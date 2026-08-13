import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch, extractSessionCookie, findSetCookie } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const password = "Correct-Horse-Battery-Staple9!";
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Users Test A",
    tenantSlug: `users-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Users Test B",
    tenantSlug: `users-test-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(adminB.tenantId);
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("PATCH /api/users/[id]", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch(`/api/users/${adminA.userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "MEMBER" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER (réservé ADMIN)", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Member A",
      email: `member-patch-${runId}@test.local`,
      password,
    });
    const target = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Target",
      email: `target-patch-${runId}@test.local`,
      password,
    });

    const response = await apiFetch(`/api/users/${target.userId}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ role: "ADMIN" }),
    });
    expect(response.status).toBe(403);
  });

  it("retourne 404 pour un user d'un autre tenant (isolation)", async () => {
    const response = await apiFetch(`/api/users/${adminB.userId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ role: "MEMBER" }),
    });
    expect(response.status).toBe(404);
  });

  it("permet à un ADMIN de changer le rôle d'un MEMBER", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Promotable",
      email: `promotable-${runId}@test.local`,
      password,
    });

    const response = await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ role: "ADMIN" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.role).toBe("ADMIN");
  });

  it("empêche de rétrograder le dernier ADMIN du tenant", async () => {
    const soloTenant = await registerTenantAdmin({
      tenantName: "Solo Admin Tenant",
      tenantSlug: `solo-admin-${runId}`,
      name: "Solo Admin",
      email: `solo-admin-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(soloTenant.tenantId);

    const response = await apiFetch(`/api/users/${soloTenant.userId}`, {
      method: "PATCH",
      headers: { Cookie: soloTenant.sessionCookie },
      body: JSON.stringify({ role: "MEMBER" }),
    });
    expect(response.status).toBe(409);
  });

  it("rejette un mot de passe non conforme lors d'une réinitialisation", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Weak Pw Target",
      email: `weak-pw-${runId}@test.local`,
      password,
    });

    const response = await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ password: "weak" }),
    });
    expect(response.status).toBe(400);
  });

  it("permet à un ADMIN de réinitialiser le mot de passe d'un user", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Pw Reset Target",
      email: `pw-reset-${runId}@test.local`,
      password,
    });

    const newPassword = "New-Correct-Horse9!";
    const response = await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ password: newPassword }),
    });
    expect(response.status).toBe(200);

    const loginResponse = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: member.email, password: newPassword, tenantId: adminA.tenantId }),
    });
    expect(loginResponse.status).toBe(200);
  });
});

describe("PATCH /api/users/[id] — agencyIds (Sprint 13C)", () => {
  it("un MEMBER fraîchement créé n'a aucune agence assignée (bug historique)", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Fresh Member",
      email: `fresh-member-${runId}@test.local`,
      password,
    });

    const response = await apiFetch(`/api/users/${member.userId}`, {
      method: "GET",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.agencyIds).toEqual([]);
  });

  it("permet à un ADMIN d'assigner des agences à un MEMBER", async () => {
    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence Assign", slug: `agence-assign-${runId}` }),
    });
    const agencyId = (await agencyResponse.json()).agency.id;

    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Assignable Member",
      email: `assignable-${runId}@test.local`,
      password,
    });

    const response = await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ agencyIds: [agencyId] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.agencyIds).toEqual([agencyId]);

    const links = await prisma.userAgency.findMany({ where: { userId: member.userId } });
    expect(links).toHaveLength(1);
    expect(links[0].agencyId).toBe(agencyId);
  });

  it("remplace l'ensemble des agences assignées (pas d'ajout incrémental)", async () => {
    const agency1Response = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence Replace 1", slug: `agence-replace-1-${runId}` }),
    });
    const agency1Id = (await agency1Response.json()).agency.id;

    const agency2Response = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence Replace 2", slug: `agence-replace-2-${runId}` }),
    });
    const agency2Id = (await agency2Response.json()).agency.id;

    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Replace Member",
      email: `replace-member-${runId}@test.local`,
      password,
    });

    await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ agencyIds: [agency1Id] }),
    });

    const response = await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ agencyIds: [agency2Id] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.agencyIds).toEqual([agency2Id]);
  });

  it("refuse une agence d'un autre tenant (isolation multi-tenant)", async () => {
    const foreignAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({ name: "Agence B Isolation", slug: `agence-b-isolation-${runId}` }),
    });
    const foreignAgencyId = (await foreignAgencyResponse.json()).agency.id;

    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Isolation Member",
      email: `isolation-member-${runId}@test.local`,
      password,
    });

    const response = await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ agencyIds: [foreignAgencyId] }),
    });
    expect(response.status).toBe(400);
  });

  it("un MEMBER voit ses véhicules une fois assigné à l'agence via /api/users/[id]", async () => {
    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence E2E", slug: `agence-e2e-${runId}` }),
    });
    const agencyId = (await agencyResponse.json()).agency.id;

    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId,
        name: "Golf",
        licensePlate: `E2E-${Math.floor(Math.random() * 1_000_000)}-AA`,
        make: "Volkswagen",
        model: "Golf",
        year: 2023,
        category: "Berline",
        pricePerDay: 5000,
      }),
    });
    expect(vehicleResponse.status).toBe(201);

    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "E2E Member",
      email: `e2e-member-${runId}@test.local`,
      password,
    });

    const beforeAssignment = await apiFetch("/api/vehicles", {
      headers: { Cookie: member.sessionCookie },
    });
    expect((await beforeAssignment.json()).vehicles).toEqual([]);

    await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ agencyIds: [agencyId] }),
    });

    const afterAssignment = await apiFetch("/api/vehicles", {
      headers: { Cookie: member.sessionCookie },
    });
    const afterVehicles = (await afterAssignment.json()).vehicles;
    expect(afterVehicles).toHaveLength(1);
    expect(afterVehicles[0].agencyId).toBe(agencyId);
  });
});

describe("GET/PATCH /api/users/me (Sprint 10)", () => {
  it("GET refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/users/me");
    expect(response.status).toBe(401);
  });

  it("GET retourne le profil de l'user connecté", async () => {
    const response = await apiFetch("/api/users/me", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.id).toBe(adminA.userId);
    expect(body.user.email).toBe(adminA.email);
  });

  it("permet de modifier phone et avatar (Sprint 12C)", async () => {
    const response = await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ phone: "+212600000000", avatar: "https://example.test/avatar.png" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.phone).toBe("+212600000000");
    expect(body.user.avatar).toBe("https://example.test/avatar.png");

    const getResponse = await apiFetch("/api/users/me", { headers: { Cookie: adminA.sessionCookie } });
    const getBody = await getResponse.json();
    expect(getBody.user.phone).toBe("+212600000000");
  });

  it("refuse un avatar qui n'est pas une URL http(s)", async () => {
    const response = await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ avatar: "not-a-url" }),
    });
    expect(response.status).toBe(400);
  });

  it("PATCH refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/users/me", {
      method: "PATCH",
      body: JSON.stringify({ name: "Nouveau nom" }),
    });
    expect(response.status).toBe(401);
  });

  it("permet à un user de modifier son propre nom", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Self Edit",
      email: `self-edit-${runId}@test.local`,
      password,
    });

    const response = await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ name: "Nom modifié" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.name).toBe("Nom modifié");
  });

  it("empêche un user de modifier le profil d'un autre user (aucun id cible acceptable)", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Isolated Self Edit",
      email: `isolated-self-edit-${runId}@test.local`,
      password,
    });

    const response = await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ name: "Ne devrait toucher que moi-même" }),
    });
    expect(response.status).toBe(200);

    const untouchedAdmin = await prisma.user.findUnique({ where: { id: adminA.userId } });
    expect(untouchedAdmin?.name).toBe("Admin A");
  });

  it("rejette un email déjà utilisé dans le même tenant", async () => {
    const existing = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Email Taken",
      email: `email-taken-${runId}@test.local`,
      password,
    });
    const other = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Email Wanter",
      email: `email-wanter-${runId}@test.local`,
      password,
    });

    const response = await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: other.sessionCookie },
      body: JSON.stringify({ email: existing.email }),
    });
    expect(response.status).toBe(409);
  });

  it("rejette un changement de mot de passe sans currentPassword", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Current Password",
      email: `no-current-pw-${runId}@test.local`,
      password,
    });

    const response = await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ newPassword: "New-Correct-Horse9!" }),
    });
    expect(response.status).toBe(400);
  });

  it("rejette un changement de mot de passe avec un currentPassword incorrect", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Wrong Current Password",
      email: `wrong-current-pw-${runId}@test.local`,
      password,
    });

    const response = await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ currentPassword: "not-the-password", newPassword: "New-Correct-Horse9!" }),
    });
    expect(response.status).toBe(400);
  });

  it("permet à un user de changer son mot de passe avec le bon currentPassword", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Password Changer",
      email: `password-changer-${runId}@test.local`,
      password,
    });

    const newPassword = "New-Correct-Horse9!";
    const response = await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ currentPassword: password, newPassword }),
    });
    expect(response.status).toBe(200);

    const loginResponse = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: member.email, password: newPassword, tenantId: adminA.tenantId }),
    });
    expect(loginResponse.status).toBe(200);
  });

  it("rafraîchit le nom dans la session JWT via trigger update après édition de profil (Sprint 11, HANDOFF.md point 35)", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Session Refresh Before",
      email: `session-refresh-${runId}@test.local`,
      password,
    });

    const beforeSession = await apiFetch("/api/auth/session", {
      headers: { Cookie: member.sessionCookie },
    });
    expect((await beforeSession.json()).user.name).toBe("Session Refresh Before");

    const patchResponse = await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ name: "Session Refresh After" }),
    });
    expect(patchResponse.status).toBe(200);

    // Sans rafraîchissement explicite, le token JWT reste périmé jusqu'à reconnexion
    // (comportement documenté avant ce sprint, HANDOFF.md section 3) : ce test évite une
    // régression silencieuse vers "toujours à jour sans update() côté client".
    const staleSession = await apiFetch("/api/auth/session", {
      headers: { Cookie: member.sessionCookie },
    });
    expect((await staleSession.json()).user.name).toBe("Session Refresh Before");

    // Reproduit ce que fait useSession().update() côté client (EditProfileForm.tsx) :
    // POST /api/auth/session avec un jeton CSRF valide déclenche trigger "update", qui
    // relit le nom/email à jour en base (src/lib/auth.ts).
    const csrfResponse = await apiFetch("/api/auth/csrf", { headers: { Cookie: member.sessionCookie } });
    const { csrfToken } = await csrfResponse.json();
    const csrfCookie = findSetCookie(csrfResponse, "csrf-token")?.split(";")[0];
    expect(csrfCookie).toBeTruthy();

    const updateResponse = await apiFetch("/api/auth/session", {
      method: "POST",
      headers: { Cookie: `${member.sessionCookie}; ${csrfCookie}` },
      body: JSON.stringify({ csrfToken }),
    });
    expect(updateResponse.status).toBe(200);
    expect((await updateResponse.json()).user.name).toBe("Session Refresh After");

    const refreshedSessionCookie = extractSessionCookie(updateResponse) ?? member.sessionCookie;
    const afterSession = await apiFetch("/api/auth/session", {
      headers: { Cookie: refreshedSessionCookie },
    });
    expect((await afterSession.json()).user.name).toBe("Session Refresh After");
  });
});

describe("DELETE /api/users/[id]", () => {
  it("refuse un MEMBER (réservé ADMIN)", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Member Delete Attempt",
      email: `member-delete-${runId}@test.local`,
      password,
    });

    const response = await apiFetch(`/api/users/${adminA.userId}`, {
      method: "DELETE",
      headers: { Cookie: member.sessionCookie },
    });
    expect(response.status).toBe(403);
  });

  it("empêche de supprimer le dernier ADMIN du tenant", async () => {
    const soloTenant = await registerTenantAdmin({
      tenantName: "Solo Admin Delete Tenant",
      tenantSlug: `solo-admin-delete-${runId}`,
      name: "Solo Admin",
      email: `solo-admin-delete-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(soloTenant.tenantId);

    const response = await apiFetch(`/api/users/${soloTenant.userId}`, {
      method: "DELETE",
      headers: { Cookie: soloTenant.sessionCookie },
    });
    expect(response.status).toBe(409);
  });

  it("supprime un user et nettoie ses UserAgency associées", async () => {
    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence Suppression", slug: `agence-suppr-${runId}` }),
    });
    const agencyId = (await agencyResponse.json()).agency.id;

    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Deletable",
      email: `deletable-${runId}@test.local`,
      password,
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId } });

    const response = await apiFetch(`/api/users/${member.userId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);

    const stillExists = await prisma.user.findUnique({ where: { id: member.userId } });
    expect(stillExists).toBeNull();
    const links = await prisma.userAgency.findMany({ where: { userId: member.userId } });
    expect(links).toHaveLength(0);
  });
});
