import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];
const password = "Correct-Horse-Battery-Staple9!";

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let memberA: AuthenticatedTestUser;

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Permissions Test A",
    tenantSlug: `permissions-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Permissions Test B",
    tenantSlug: `permissions-test-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(adminB.tenantId);

  memberA = await createAndLoginMember({
    tenantId: adminA.tenantId,
    name: "Member A",
    email: `member-a-${runId}@test.local`,
    password,
  });
});

afterAll(async () => {
  await prisma.userPermission.deleteMany({ where: { user: { tenantId: { in: createdTenantIds } } } });
  await prisma.reservation.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("GET /api/permission-groups", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/permission-groups");
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER", async () => {
    const response = await apiFetch("/api/permission-groups", { headers: { Cookie: memberA.sessionCookie } });
    expect(response.status).toBe(403);
  });

  it("retourne les 4 groupes par défaut créés à l'inscription (ADMIN, MEMBER, COMPTABILITÉ, AGENCE)", async () => {
    const response = await apiFetch("/api/permission-groups", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    const names: string[] = body.groups.map((g: { name: string }) => g.name);
    expect(names).toEqual(expect.arrayContaining(["ADMIN", "MEMBER", "COMPTABILITÉ", "AGENCE"]));

    const memberGroup = body.groups.find((g: { name: string }) => g.name === "MEMBER");
    expect(memberGroup.permissions).toContain("reservations.view");
    expect(memberGroup.permissions).not.toContain("reservations.delete");
  });
});

describe("POST /api/permission-groups", () => {
  it("crée un groupe personnalisé avec un sous-ensemble de permissions", async () => {
    const response = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Custom-${runId}`, permissions: ["reservations.view", "clients.view"] }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.group.permissions.sort()).toEqual(["clients.view", "reservations.view"]);
  });

  it("refuse un nom déjà utilisé dans le tenant", async () => {
    const name = `Duplicate-${runId}`;
    const first = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name, permissions: [] }),
    });
    expect(first.status).toBe(201);

    const response = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name, permissions: [] }),
    });
    expect(response.status).toBe(409);
  });
});

describe("PATCH/DELETE /api/permission-groups/[id]", () => {
  it("modifie le nom et les permissions d'un groupe", async () => {
    const created = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `ToEdit-${runId}`, permissions: ["clients.view"] }),
    });
    const groupId = (await created.json()).group.id;

    const response = await apiFetch(`/api/permission-groups/${groupId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Edited-${runId}`, permissions: ["clients.view", "clients.edit"] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.group.name).toBe(`Edited-${runId}`);
    expect(body.group.permissions.sort()).toEqual(["clients.edit", "clients.view"]);
  });

  it("retourne 404 pour un groupe d'un autre tenant (isolation multi-tenant)", async () => {
    const createdB = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({ name: `TenantB-${runId}`, permissions: [] }),
    });
    const groupBId = (await createdB.json()).group.id;

    const response = await apiFetch(`/api/permission-groups/${groupBId}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });

  it("bloque la suppression d'un groupe encore assigné à un utilisateur", async () => {
    const created = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Assigned-${runId}`, permissions: ["clients.view"] }),
    });
    const groupId = (await created.json()).group.id;

    const target = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Assigned Member",
      email: `assigned-${runId}@test.local`,
      password,
    });

    await apiFetch(`/api/users/${target.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: groupId }),
    });

    const deleteResponse = await apiFetch(`/api/permission-groups/${groupId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(409);

    await apiFetch(`/api/users/${target.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: null }),
    });

    const deleteAfterUnassign = await apiFetch(`/api/permission-groups/${groupId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteAfterUnassign.status).toBe(200);
  });
});

describe("GET/PATCH /api/users/[id]/permissions", () => {
  it("un MEMBER sans groupe ni permission individuelle n'a accès à aucune permission (403 sur une route gated)", async () => {
    const noPerms = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Perms",
      email: `no-perms-${runId}@test.local`,
      password,
    });

    const response = await apiFetch("/api/reservations", {
      method: "POST",
      headers: { Cookie: noPerms.sessionCookie },
      body: JSON.stringify({
        voucherNumber: `V-${runId}`,
        clientFirstName: "Test",
        clientLastName: "Refuse",
        startDate: "2030-01-01",
        endDate: "2030-01-02",
      }),
    });
    expect(response.status).toBe(403);
  });

  it("assigner le groupe MEMBER accorde reservations.create (permission gated réellement appliquée)", async () => {
    const groupsResponse = await apiFetch("/api/permission-groups", { headers: { Cookie: adminA.sessionCookie } });
    const memberGroup = (await groupsResponse.json()).groups.find((g: { name: string }) => g.name === "MEMBER");

    const target = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Grouped Member",
      email: `grouped-${runId}@test.local`,
      password,
    });

    const patchResponse = await apiFetch(`/api/users/${target.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: memberGroup.id }),
    });
    expect(patchResponse.status).toBe(200);

    const createResponse = await apiFetch("/api/reservations", {
      method: "POST",
      headers: { Cookie: target.sessionCookie },
      body: JSON.stringify({
        voucherNumber: `V-GROUP-${runId}`,
        clientFirstName: "Test",
        clientLastName: "Grouped",
        startDate: "2030-01-01",
        endDate: "2030-01-02",
      }),
    });
    expect(createResponse.status).toBe(201);

    // reservations.delete n'est pas dans le groupe MEMBER par défaut.
    const reservationId = (await createResponse.json()).reservation.id;
    const deleteResponse = await apiFetch(`/api/reservations/${reservationId}`, {
      method: "DELETE",
      headers: { Cookie: target.sessionCookie },
    });
    expect(deleteResponse.status).toBe(403);
  });

  it("une permission individuelle s'ajoute à celles du groupe (additif, jamais un retrait)", async () => {
    const target = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Individual Perm",
      email: `individual-${runId}@test.local`,
      password,
    });

    await apiFetch(`/api/users/${target.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ individualPermissions: ["reservations.view"] }),
    });

    const viewResponse = await apiFetch("/api/reservations", { headers: { Cookie: target.sessionCookie } });
    expect(viewResponse.status).toBe(200);

    const createResponse = await apiFetch("/api/reservations", {
      method: "POST",
      headers: { Cookie: target.sessionCookie },
      body: JSON.stringify({
        voucherNumber: `V-IND-${runId}`,
        clientFirstName: "Test",
        clientLastName: "Individual",
        startDate: "2030-01-01",
        endDate: "2030-01-02",
      }),
    });
    expect(createResponse.status).toBe(403);
  });

  it("un ADMIN a toujours toutes les permissions, quel que soit son groupe/ses permissions individuelles", async () => {
    const response = await apiFetch("/api/reservations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        voucherNumber: `V-ADMIN-${runId}`,
        clientFirstName: "Test",
        clientLastName: "Admin",
        startDate: "2030-01-01",
        endDate: "2030-01-02",
      }),
    });
    expect(response.status).toBe(201);
  });
});
