import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

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
  await deleteTestTenants(createdTenantIds);
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

  it("Sprint 23 — contracts_overview.view/vehicle_performance.view accordées par défaut à MEMBER/AGENCE/COMPTABILITÉ (DOMAINRULES.md section 39)", async () => {
    const response = await apiFetch("/api/permission-groups", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();

    for (const name of ["MEMBER", "AGENCE", "COMPTABILITÉ"]) {
      const group = body.groups.find((g: { name: string }) => g.name === name);
      expect(group.permissions).toContain("contracts_overview.view");
      expect(group.permissions).toContain("vehicle_performance.view");
    }
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

describe("Sprint 19 — persistance des permissions de groupe (correctif du backfill récurrent)", () => {
  it("un retrait explicite sur MEMBER/AGENCE ne réapparaît plus après un nouveau GET (bug réel corrigé)", async () => {
    const listResponse = await apiFetch("/api/permission-groups", { headers: { Cookie: adminA.sessionCookie } });
    const groups = (await listResponse.json()).groups as { id: string; name: string; permissions: string[] }[];
    const memberGroup = groups.find((g) => g.name === "MEMBER");
    expect(memberGroup).toBeDefined();
    // cash_register.edit/delete (Sprint 19) font partie des clés historiquement backfillées —
    // exactement le type de clé que l'ancien mécanisme réinjectait silencieusement.
    expect(memberGroup!.permissions).toContain("cash_register.edit");

    const remainingPermissions = memberGroup!.permissions.filter((key) => key !== "cash_register.edit");
    const patchResponse = await apiFetch(`/api/permission-groups/${memberGroup!.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissions: remainingPermissions }),
    });
    expect(patchResponse.status).toBe(200);
    expect((await patchResponse.json()).group.permissions).not.toContain("cash_register.edit");

    // Avant le correctif Sprint 19, ce second GET (qui invoque ensureDefaultGroups) réinjectait
    // silencieusement cash_register.edit dans le groupe MEMBER déjà existant — annulant le
    // retrait explicite ci-dessus sans qu'aucun ADMIN ne l'ait demandé.
    const secondListResponse = await apiFetch("/api/permission-groups", { headers: { Cookie: adminA.sessionCookie } });
    const secondGroups = (await secondListResponse.json()).groups as { id: string; name: string; permissions: string[] }[];
    const memberGroupAfter = secondGroups.find((g) => g.name === "MEMBER");
    expect(memberGroupAfter!.permissions).not.toContain("cash_register.edit");

    // Restaure l'état initial pour ne pas affecter les autres tests de ce fichier qui
    // s'appuient sur le groupe MEMBER par défaut.
    await apiFetch(`/api/permission-groups/${memberGroup!.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissions: memberGroup!.permissions }),
    });
  });
});

describe("Révocation immédiate d'un droit déjà en usage, sans reconnexion (phase 2.2)", () => {
  it("modifier un groupe personnalisé déjà assigné (retrait d'une clé) révoque l'accès au prochain appel, même cookie de session", async () => {
    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `LiveRevoke-${runId}`, permissions: ["reservations.view", "reservations.create"] }),
    });
    const groupId = (await groupResponse.json()).group.id;

    const target = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Live Revoke Member",
      email: `live-revoke-${runId}@test.local`,
      password,
    });
    await apiFetch(`/api/users/${target.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: groupId }),
    });

    const beforeRevoke = await apiFetch("/api/reservations", {
      method: "POST",
      headers: { Cookie: target.sessionCookie },
      body: JSON.stringify({
        voucherNumber: `V-LIVEREV-BEFORE-${runId}`,
        clientFirstName: "Test",
        clientLastName: "AvantRevocation",
        startDate: "2030-01-01",
        endDate: "2030-01-02",
      }),
    });
    expect(beforeRevoke.status).toBe(201);

    // L'utilisateur cible n'est jamais touché ici — c'est la DÉFINITION du groupe qui perd la
    // clé, pas son rattachement (`permissionGroupId` inchangé). getEffectivePermissions()
    // relit GroupPermission à chaque appel (src/lib/permissions.ts) : aucune raison technique
    // que ce cas diverge du retrait direct d'une UserPermission déjà couvert ci-dessus.
    await apiFetch(`/api/permission-groups/${groupId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissions: ["reservations.view"] }),
    });

    const afterRevoke = await apiFetch("/api/reservations", {
      method: "POST",
      headers: { Cookie: target.sessionCookie },
      body: JSON.stringify({
        voucherNumber: `V-LIVEREV-AFTER-${runId}`,
        clientFirstName: "Test",
        clientLastName: "ApresRevocation",
        startDate: "2030-01-01",
        endDate: "2030-01-02",
      }),
    });
    expect(afterRevoke.status).toBe(403);

    // La lecture, encore accordée par le groupe, reste elle utilisable avec ce même cookie —
    // preuve que le 403 ci-dessus vient bien de la permission retirée, pas d'un effet de bord.
    const stillReadable = await apiFetch("/api/reservations", { headers: { Cookie: target.sessionCookie } });
    expect(stillReadable.status).toBe(200);
  });

  it("retirer une permission individuelle déjà accordée la révoque immédiatement, même cookie de session", async () => {
    const emptyGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Empty-LiveRevoke-${runId}`, permissions: [] }),
    });
    const emptyGroupId = (await emptyGroupResponse.json()).group.id;

    const target = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Individual Revoke Member",
      email: `individual-revoke-${runId}@test.local`,
      password,
    });
    await apiFetch(`/api/users/${target.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: emptyGroupId, individualPermissions: ["reservations.view"] }),
    });

    const beforeRevoke = await apiFetch("/api/reservations", { headers: { Cookie: target.sessionCookie } });
    expect(beforeRevoke.status).toBe(200);

    await apiFetch(`/api/users/${target.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: emptyGroupId, individualPermissions: [] }),
    });

    const afterRevoke = await apiFetch("/api/reservations", { headers: { Cookie: target.sessionCookie } });
    expect(afterRevoke.status).toBe(403);
  });
});

describe("GET/PATCH /api/users/[id]/permissions", () => {
  // Sprint 15 : décision explicite — un MEMBER n'ayant jamais été rattaché à un groupe (aucun
  // code de l'application ne le fait automatiquement à sa création) retombe désormais sur les
  // permissions du groupe par défaut "MEMBER" (voir src/lib/permissions.ts,
  // getEffectivePermissions), plutôt que sur un ensemble vide comme avant ce sprint. Ce test
  // couvrait jusqu'ici ce cas précis avec l'ancienne sémantique ; il est réécrit pour prouver
  // la frontière désormais correcte : c'est un groupe personnalisé explicitement vide (pas
  // l'absence totale de groupe) qui doit encore bloquer entièrement l'accès.
  it("un MEMBER rattaché à un groupe personnalisé explicitement vide n'a accès à aucune permission (403 sur une route gated)", async () => {
    const emptyGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Empty-${runId}`, permissions: [] }),
    });
    const emptyGroupId = (await emptyGroupResponse.json()).group.id;

    const noPerms = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Perms",
      email: `no-perms-${runId}@test.local`,
      password,
    });
    await apiFetch(`/api/users/${noPerms.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: emptyGroupId }),
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

  it("un MEMBER sans aucun groupe assigné retombe sur les permissions du groupe par défaut MEMBER (Sprint 15)", async () => {
    const unassigned = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Unassigned",
      email: `unassigned-${runId}@test.local`,
      password,
    });

    const response = await apiFetch("/api/reservations", {
      method: "POST",
      headers: { Cookie: unassigned.sessionCookie },
      body: JSON.stringify({
        voucherNumber: `V-unassigned-${runId}`,
        clientFirstName: "Test",
        clientLastName: "ParDefaut",
        startDate: "2030-01-01",
        endDate: "2030-01-02",
      }),
    });
    expect(response.status).toBe(201);
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

  it("Sprint 18 — journalise l'assignation d'un groupe de permissions (user.permissions_changed)", async () => {
    const groupsResponse = await apiFetch("/api/permission-groups", { headers: { Cookie: adminA.sessionCookie } });
    const memberGroup = (await groupsResponse.json()).groups.find((g: { name: string }) => g.name === "MEMBER");

    const target = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Audited Member",
      email: `audited-${runId}@test.local`,
      password,
    });

    const patchResponse = await apiFetch(`/api/users/${target.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: memberGroup.id }),
    });
    expect(patchResponse.status).toBe(200);

    const logs = await prisma.auditLog.findMany({
      where: { tenantId: adminA.tenantId, action: "user.permissions_changed", resourceId: target.userId },
    });
    expect(logs).toHaveLength(1);
  });

  it("une permission individuelle s'ajoute à celles du groupe (additif, jamais un retrait)", async () => {
    // Sprint 15 : le groupe utilisé ici doit être explicitement vide (pas l'absence totale de
    // groupe, qui retombe désormais sur les permissions du groupe par défaut MEMBER — voir le
    // test précédent) pour que ce test isole correctement l'effet additif d'une permission
    // individuelle, sans que la base du groupe MEMBER par défaut ne le fausse.
    const emptyGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Empty-Individual-${runId}`, permissions: [] }),
    });
    const emptyGroupId = (await emptyGroupResponse.json()).group.id;

    const target = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Individual Perm",
      email: `individual-${runId}@test.local`,
      password,
    });

    await apiFetch(`/api/users/${target.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: emptyGroupId, individualPermissions: ["reservations.view"] }),
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

describe("Sprint 15 — nouvelles clés de permission (maintenances/alerts/cash_register/vehicle_transfers/vehicle_trips)", () => {
  it("les groupes par défaut MEMBER/AGENCE contiennent les nouvelles clés Sprint 15 pour un tenant fraîchement créé, COMPTABILITÉ reste scopé finance/reporting", async () => {
    const response = await apiFetch("/api/permission-groups", { headers: { Cookie: adminB.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    const memberGroup = body.groups.find((g: { name: string }) => g.name === "MEMBER");
    const agenceGroup = body.groups.find((g: { name: string }) => g.name === "AGENCE");
    const comptaGroup = body.groups.find((g: { name: string }) => g.name === "COMPTABILITÉ");

    const memberKeys = [
      "maintenances.view",
      "maintenances.create",
      "maintenances.edit",
      "maintenances.delete",
      "alerts.view",
      "alerts.acknowledge",
      "alerts.resolve",
      "cash_register.view",
      "cash_register.create_entry",
      "cash_register.create_expense",
      "cash_register.manage_categories",
      "vehicle_transfers.view",
      "vehicle_transfers.create",
      "vehicle_transfers.validate",
      "vehicle_transfers.cancel",
      "vehicle_trips.view",
      "vehicle_trips.create",
      "vehicle_trips.return",
      "vehicle_trips.cancel",
    ];
    for (const key of memberKeys) {
      expect(memberGroup.permissions).toContain(key);
    }

    const agenceKeys = [
      // Sprint 17 : agencies.view/cash_register.* — régression Sprint 15 corrigée (ce groupe
      // n'avait jamais reçu ces clés, ce qui bloquait GET /api/agencies pour ce groupe malgré
      // des permissions *.create par ailleurs accordées, voir src/lib/permissions.ts).
      "agencies.view",
      "cash_register.view",
      "cash_register.create_entry",
      "cash_register.create_expense",
      "cash_register.manage_categories",
      "maintenances.view",
      "maintenances.create",
      "maintenances.edit",
      "maintenances.delete",
      "alerts.view",
      "alerts.acknowledge",
      "alerts.resolve",
      "vehicle_transfers.view",
      "vehicle_transfers.create",
      "vehicle_transfers.validate",
      "vehicle_transfers.cancel",
      "vehicle_trips.view",
      "vehicle_trips.create",
      "vehicle_trips.return",
      "vehicle_trips.cancel",
    ];
    for (const key of agenceKeys) {
      expect(agenceGroup.permissions).toContain(key);
    }

    // COMPTABILITÉ reste scopé finance/reporting (Sprint 15, resserrement assumé confirmé
    // avec le propriétaire du projet) : aucune des nouvelles clés opérationnelles ne lui
    // est accordée.
    for (const key of [
      "maintenances.view",
      "alerts.view",
      "cash_register.view",
      "vehicle_transfers.view",
      "vehicle_trips.view",
    ]) {
      expect(comptaGroup.permissions).not.toContain(key);
    }
  });

  it("can() applique réellement cash_register.create_entry : refuse sans la clé, accorde une fois le groupe personnalisé mis à jour", async () => {
    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoCashEntry-${runId}`, permissions: ["cash_register.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Cash Member",
      email: `restricted-cash-${runId}@test.local`,
      password,
    });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const deniedResponse = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: restrictedMember.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", amount: 1000 }),
    });
    expect(deniedResponse.status).toBe(403);

    const grantedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: `WithCashEntry-${runId}`,
        permissions: ["cash_register.view", "cash_register.create_entry"],
      }),
    });
    const grantedGroupId = (await grantedGroupResponse.json()).group.id;

    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: grantedGroupId }),
    });

    const grantedResponse = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: restrictedMember.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", amount: 1000, description: "Test permission accordée" }),
    });
    expect(grantedResponse.status).toBe(201);
  });
});
