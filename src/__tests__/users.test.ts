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
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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
