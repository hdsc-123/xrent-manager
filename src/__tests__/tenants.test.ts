import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { apiFetch, extractSessionCookie } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let memberA: AuthenticatedTestUser;

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Tenants Test A",
    tenantSlug: `tenants-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Tenants Test B",
    tenantSlug: `tenants-test-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminB.tenantId);

  memberA = await createAndLoginMember({
    tenantId: adminA.tenantId,
    name: "Member A",
    email: `member-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
});

afterAll(async () => {
  // Sprint 15 : PATCH /api/tenants/[id] journalise désormais "tenant.updated" (AuditLog),
  // absent jusqu'ici — sans cette suppression, la contrainte de clé étrangère
  // AuditLog_tenantId_fkey bloque prisma.tenant.deleteMany() ci-dessous.
  // Invitation.invitedByUserId bloque prisma.user.deleteMany() ci-dessous (nouveau, ce fichier
  // crée désormais une vraie invitation — voir "l'administrateur du nouveau tenant peut...").
  await prisma.invitation.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  // Nouveau (ce fichier crée désormais une vraie agence — voir "l'administrateur du nouveau
  // tenant peut...") : Agency.tenantId bloque prisma.tenant.deleteMany() ci-dessous.
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("GET /api/tenants", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/tenants");
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER", async () => {
    const response = await apiFetch("/api/tenants", {
      headers: { Cookie: memberA.sessionCookie },
    });
    expect(response.status).toBe(403);
  });

  it("un ADMIN ne voit jamais que son propre tenant (isolation multi-tenant)", async () => {
    const response = await apiFetch("/api/tenants", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    const ids: string[] = body.tenants.map((t: { id: string }) => t.id);
    expect(ids).toContain(adminA.tenantId);
    expect(ids).not.toContain(adminB.tenantId);
  });
});

describe("GET /api/tenants/[id]", () => {
  it("retourne le tenant de l'admin connecté", async () => {
    const response = await apiFetch(`/api/tenants/${adminA.tenantId}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tenant.id).toBe(adminA.tenantId);
  });

  it("retourne 404 pour le tenant d'un autre admin (pas de fuite inter-tenant)", async () => {
    const response = await apiFetch(`/api/tenants/${adminB.tenantId}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/tenants/[id]", () => {
  it("met à jour le tenant de l'admin connecté", async () => {
    const response = await apiFetch(`/api/tenants/${adminA.tenantId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Tenants Test A — renommé" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tenant.name).toBe("Tenants Test A — renommé");
  });

  it("refuse de modifier le tenant d'un autre admin", async () => {
    const response = await apiFetch(`/api/tenants/${adminB.tenantId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Hostile rename" }),
    });
    expect(response.status).toBe(404);
  });

  it("refuse un MEMBER même sur son propre tenant", async () => {
    const response = await apiFetch(`/api/tenants/${adminA.tenantId}`, {
      method: "PATCH",
      headers: { Cookie: memberA.sessionCookie },
      body: JSON.stringify({ name: "Member rename attempt" }),
    });
    expect(response.status).toBe(403);
  });

  it("Sprint 15 — contractNumberPrefix/lastContractNumber n'existent plus sur Tenant (déplacés vers Agency) : ignorés silencieusement", async () => {
    // Sprint 15 : la numérotation de contrat est désormais portée par Agency, par agence
    // (voir PATCH /api/agencies/[id]). PATCH /api/tenants/[id] ne connaît plus que `name` —
    // envoyer ces champs ne doit ni échouer ni les faire apparaître sur le tenant retourné.
    const response = await apiFetch(`/api/tenants/${adminA.tenantId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Tenants Test A", contractNumberPrefix: "RAK", lastContractNumber: 42 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tenant.name).toBe("Tenants Test A");
    expect(body.tenant).not.toHaveProperty("contractNumberPrefix");
    expect(body.tenant).not.toHaveProperty("lastContractNumber");
  });

  it("Sprint 15 — un lastContractNumber négatif envoyé sur /api/tenants/[id] est ignoré (pas de validation, le champ n'existe plus)", async () => {
    const response = await apiFetch(`/api/tenants/${adminA.tenantId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Tenants Test A", lastContractNumber: -1 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tenant).not.toHaveProperty("lastContractNumber");
  });
});

describe("POST /api/tenants — création réservée au Super Admin plateforme (2026-08-29)", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/tenants", {
      method: "POST",
      body: JSON.stringify({
        tenantName: "Should Not Exist",
        tenantSlug: `should-not-exist-${runId}`,
        name: "Nobody",
        email: `nobody-${runId}@test.local`,
        password: "Correct-Horse-Battery-Staple9!",
      }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER", async () => {
    const response = await apiFetch("/api/tenants", {
      method: "POST",
      headers: { Cookie: memberA.sessionCookie },
      body: JSON.stringify({
        tenantName: "Should Not Exist",
        tenantSlug: `should-not-exist-member-${runId}`,
        name: "Nobody",
        email: `nobody-member-${runId}@test.local`,
        password: "Correct-Horse-Battery-Staple9!",
      }),
    });
    expect(response.status).toBe(403);
  });

  it("refuse un ADMIN de tenant ordinaire (pas Super Admin) — ne peut pas créer un autre tenant", async () => {
    const response = await apiFetch("/api/tenants", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        tenantName: "Should Not Exist Either",
        tenantSlug: `should-not-exist-admin-${runId}`,
        name: "Nobody",
        email: `nobody-admin-${runId}@test.local`,
        password: "Correct-Horse-Battery-Staple9!",
      }),
    });
    expect(response.status).toBe(403);
  });

  it("le Super Admin (email listé dans SUPER_ADMIN_EMAILS) peut créer un tenant et son premier ADMIN", async () => {
    const superAdmin = await registerTenantAdmin({
      tenantName: "Platform Seat",
      tenantSlug: `platform-seat-${runId}`,
      name: "Super Admin",
      email: `superadmin-${runId}@superadmin.test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    createdTenantIds.push(superAdmin.tenantId);

    const newAdminEmail = `new-tenant-admin-${runId}@test.local`;
    const response = await apiFetch("/api/tenants", {
      method: "POST",
      headers: { Cookie: superAdmin.sessionCookie },
      body: JSON.stringify({
        tenantName: "Newly Created Tenant",
        tenantSlug: `newly-created-${runId}`,
        name: "First Admin",
        email: newAdminEmail,
        password: "Correct-Horse-Battery-Staple9!",
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    createdTenantIds.push(body.tenant.id);

    // La création du premier administrateur est correctement rattachée au nouveau tenant.
    expect(body.user.tenantId).toBe(body.tenant.id);
    expect(body.user.role).toBe("ADMIN");
    expect(body.user.email).toBe(newAdminEmail);
    expect(body.user.passwordHash).toBeUndefined();

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: body.user.id } });
    expect(stored.tenantId).toBe(body.tenant.id);
    expect(stored.role).toBe("ADMIN");

    // Le Super Admin lui-même n'obtient aucun accès de lecture au tenant qu'il vient de créer
    // (SECURITY.md section 1 — la capacité Super Admin est strictement la création).
    const getNewTenant = await apiFetch(`/api/tenants/${body.tenant.id}`, {
      headers: { Cookie: superAdmin.sessionCookie },
    });
    expect(getNewTenant.status).toBe(404);
  });

  it("un utilisateur d'un tenant ne peut pas accéder aux données d'un autre tenant (isolation déjà vérifiée par ailleurs, reconfirmée sur le tenant fraîchement créé)", async () => {
    const superAdmin = await registerTenantAdmin({
      tenantName: "Platform Seat 2",
      tenantSlug: `platform-seat-2-${runId}`,
      name: "Super Admin 2",
      email: `superadmin2-${runId}@superadmin.test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    createdTenantIds.push(superAdmin.tenantId);

    const createResponse = await apiFetch("/api/tenants", {
      method: "POST",
      headers: { Cookie: superAdmin.sessionCookie },
      body: JSON.stringify({
        tenantName: "Isolation Check Tenant",
        tenantSlug: `isolation-check-${runId}`,
        name: "Isolated Admin",
        email: `isolated-admin-${runId}@test.local`,
        password: "Correct-Horse-Battery-Staple9!",
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    createdTenantIds.push(created.tenant.id);

    // adminA (tenant totalement distinct) ne doit jamais voir ce nouveau tenant.
    const crossTenantRead = await apiFetch(`/api/tenants/${created.tenant.id}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(crossTenantRead.status).toBe(404);
  });

  it("hash le mot de passe du premier admin (jamais en clair), rejette un mot de passe trop court et un slug déjà utilisé", async () => {
    const superAdmin = await registerTenantAdmin({
      tenantName: "Platform Seat 3",
      tenantSlug: `platform-seat-3-${runId}`,
      name: "Super Admin 3",
      email: `superadmin3-${runId}@superadmin.test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    createdTenantIds.push(superAdmin.tenantId);

    const rawPassword = "Correct-Horse-Battery-Staple9!";
    const newTenantSlug = `hash-check-${runId}`;
    const response = await apiFetch("/api/tenants", {
      method: "POST",
      headers: { Cookie: superAdmin.sessionCookie },
      body: JSON.stringify({
        tenantName: "Hash Check Tenant",
        tenantSlug: newTenantSlug,
        name: "Hash Check Admin",
        email: `hash-check-admin-${runId}@test.local`,
        password: rawPassword,
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    createdTenantIds.push(body.tenant.id);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: body.user.id } });
    expect(stored.passwordHash).toBeTruthy();
    expect(stored.passwordHash).not.toBe(rawPassword);
    expect(await bcrypt.compare(rawPassword, stored.passwordHash as string)).toBe(true);

    const shortPasswordResponse = await apiFetch("/api/tenants", {
      method: "POST",
      headers: { Cookie: superAdmin.sessionCookie },
      body: JSON.stringify({
        tenantName: "Short Password Tenant",
        tenantSlug: `short-pw-${runId}`,
        name: "Nobody",
        email: `short-pw-${runId}@test.local`,
        password: "short",
      }),
    });
    expect(shortPasswordResponse.status).toBe(400);

    const duplicateSlugResponse = await apiFetch("/api/tenants", {
      method: "POST",
      headers: { Cookie: superAdmin.sessionCookie },
      body: JSON.stringify({
        tenantName: "Duplicate Slug Tenant",
        tenantSlug: newTenantSlug,
        name: "Someone Else",
        email: `dup-${runId}@test.local`,
        password: rawPassword,
      }),
    });
    expect(duplicateSlugResponse.status).toBe(409);
  });

  it("l'administrateur du nouveau tenant peut ensuite créer une ville/agence puis inviter et créer un utilisateur dans son propre tenant", async () => {
    const superAdmin = await registerTenantAdmin({
      tenantName: "Platform Seat 4",
      tenantSlug: `platform-seat-4-${runId}`,
      name: "Super Admin 4",
      email: `superadmin4-${runId}@superadmin.test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    createdTenantIds.push(superAdmin.tenantId);

    const newAdminPassword = "Correct-Horse-Battery-Staple9!";
    const newAdminEmail = `provisioned-admin-${runId}@test.local`;
    const createResponse = await apiFetch("/api/tenants", {
      method: "POST",
      headers: { Cookie: superAdmin.sessionCookie },
      body: JSON.stringify({
        tenantName: "Provisioned Tenant",
        tenantSlug: `provisioned-${runId}`,
        name: "Provisioned Admin",
        email: newAdminEmail,
        password: newAdminPassword,
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    createdTenantIds.push(created.tenant.id);

    // Le Super Admin ne se connecte jamais à ce tenant : l'admin fraîchement créé se connecte
    // lui-même avec ses propres identifiants.
    const loginResponse = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: newAdminEmail, password: newAdminPassword }),
    });
    const newAdminCookie = extractSessionCookie(loginResponse);
    expect(newAdminCookie).toBeDefined();

    // Une "ville" n'est pas une entité dédiée dans ce schéma (DOMAINRULES.md) : elle vit comme
    // champ libre `city` sur Agency — créer une agence avec une ville couvre les deux exigences.
    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: newAdminCookie! },
      body: JSON.stringify({ name: "Agence Casablanca", city: "Casablanca" }),
    });
    expect(agencyResponse.status).toBe(201);
    const agencyBody = await agencyResponse.json();
    expect(agencyBody.agency.tenantId).toBe(created.tenant.id);
    expect(agencyBody.agency.city).toBe("Casablanca");

    // Aucune route POST /api/users dédiée n'existe (DOMAINRULES.md) — un utilisateur ne peut
    // être créé que par acceptation d'une invitation émise par un ADMIN de son tenant.
    const invitedEmail = `invited-${runId}@test.local`;
    const invitationResponse = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: newAdminCookie! },
      body: JSON.stringify({ email: invitedEmail, role: "MEMBER" }),
    });
    expect(invitationResponse.status).toBe(201);
    const invitationBody = await invitationResponse.json();

    const acceptResponse = await apiFetch(`/api/invitations/${invitationBody.invitation.id}/accept`, {
      method: "POST",
      body: JSON.stringify({ name: "Invited User", password: "Another-Battery9!" }),
    });
    expect(acceptResponse.status).toBe(200);

    const invitedUser = await prisma.user.findUniqueOrThrow({
      where: { tenantId_email: { tenantId: created.tenant.id, email: invitedEmail } },
    });
    expect(invitedUser.tenantId).toBe(created.tenant.id);
    expect(invitedUser.role).toBe("MEMBER");
  });
});

describe("DELETE /api/tenants/[id]", () => {
  it("refuse de supprimer le tenant d'un autre admin", async () => {
    const response = await apiFetch(`/api/tenants/${adminB.tenantId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });

  it("refuse la suppression d'un tenant ayant des utilisateurs actifs", async () => {
    const response = await apiFetch(`/api/tenants/${adminA.tenantId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(409);
  });
});
