import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let memberA: AuthenticatedTestUser;
let agencyA1Id: string;
let agencyA2Id: string;
let agencyB1Id: string;
let vehicleA1Id: string;
let vehicleB1Id: string;

async function createVehicle(
  admin: AuthenticatedTestUser,
  agencyId: string,
  overrides: Record<string, unknown> = {}
) {
  const response = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      agencyId,
      name: "Clio",
      licensePlate: `MT-${Math.floor(Math.random() * 1_000_000)}-MT`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay: 4500,
      chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
      ...overrides,
    }),
  });
  return response;
}

async function createMaintenance(
  admin: AuthenticatedTestUser,
  vehicleId: string,
  overrides: Record<string, unknown> = {}
) {
  return apiFetch("/api/maintenances", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      type: "OIL_CHANGE",
      scheduledDate: "2030-06-01",
      ...overrides,
    }),
  });
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Maintenances Test A",
    tenantSlug: `maintenances-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Maintenances Test B",
    tenantSlug: `maintenances-test-b-${runId}`,
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

  const agencyA1Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A1", slug: `mt-agence-a1-${runId}` }),
  });
  agencyA1Id = (await agencyA1Response.json()).agency.id;

  const agencyA2Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A2", slug: `mt-agence-a2-${runId}` }),
  });
  agencyA2Id = (await agencyA2Response.json()).agency.id;

  const agencyB1Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Agence B1", slug: `mt-agence-b1-${runId}` }),
  });
  agencyB1Id = (await agencyB1Response.json()).agency.id;

  await prisma.userAgency.create({ data: { userId: memberA.userId, agencyId: agencyA1Id } });

  vehicleA1Id = (await (await createVehicle(adminA, agencyA1Id)).json()).vehicle.id;
  vehicleB1Id = (await (await createVehicle(adminB, agencyB1Id)).json()).vehicle.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.maintenance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicleTransfer.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("POST /api/maintenances", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/maintenances", {
      method: "POST",
      body: JSON.stringify({ vehicleId: vehicleA1Id, type: "OIL_CHANGE", scheduledDate: "2030-06-01" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un véhicule d'un autre tenant (isolation multi-tenant)", async () => {
    const response = await createMaintenance(adminA, vehicleB1Id);
    expect(response.status).toBe(404);
  });

  it("crée la maintenance avec agencyId/currency dérivés du véhicule", async () => {
    const response = await createMaintenance(adminA, vehicleA1Id);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.maintenance.tenantId).toBe(adminA.tenantId);
    expect(body.maintenance.agencyId).toBe(agencyA1Id);
    expect(body.maintenance.currency).toBe("MAD");
    expect(body.maintenance.status).toBe("SCHEDULED");
  });

  it("refuse un coût négatif", async () => {
    const response = await createMaintenance(adminA, vehicleA1Id, { cost: -100 });
    expect(response.status).toBe(400);
  });

  it("refuse un MEMBER non rattaché à l'agence du véhicule", async () => {
    const vehicleA2Response = await createVehicle(adminA, agencyA2Id);
    const vehicleA2Id = (await vehicleA2Response.json()).vehicle.id;

    const response = await createMaintenance(memberA, vehicleA2Id);
    expect(response.status).toBe(403);
  });
});

describe("GET /api/maintenances", () => {
  it("liste uniquement les maintenances du tenant connecté (isolation multi-tenant)", async () => {
    const maintenanceAResponse = await createMaintenance(adminA, vehicleA1Id);
    const maintenanceAId = (await maintenanceAResponse.json()).maintenance.id;

    const maintenanceBResponse = await createMaintenance(adminB, vehicleB1Id);
    const maintenanceBId = (await maintenanceBResponse.json()).maintenance.id;

    const response = await apiFetch("/api/maintenances", { headers: { Cookie: adminA.sessionCookie } });
    const body = await response.json();
    const ids: string[] = body.maintenances.map((m: { id: string }) => m.id);
    expect(ids).toContain(maintenanceAId);
    expect(ids).not.toContain(maintenanceBId);
  });
});

describe("PATCH /api/maintenances/[id]", () => {
  it("passe SCHEDULED -> COMPLETED et fixe completedDate automatiquement", async () => {
    const createResponse = await createMaintenance(adminA, vehicleA1Id);
    const maintenanceId = (await createResponse.json()).maintenance.id;

    const response = await apiFetch(`/api/maintenances/${maintenanceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED", cost: 12000 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.maintenance.status).toBe("COMPLETED");
    expect(body.maintenance.cost).toBe(12000);
    expect(body.maintenance.completedDate).not.toBeNull();
  });

  it("refuse une transition invalide (COMPLETED -> SCHEDULED)", async () => {
    const createResponse = await createMaintenance(adminA, vehicleA1Id);
    const maintenanceId = (await createResponse.json()).maintenance.id;

    await apiFetch(`/api/maintenances/${maintenanceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });

    const response = await apiFetch(`/api/maintenances/${maintenanceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "SCHEDULED" }),
    });
    expect(response.status).toBe(409);
  });

  it("refuse de modifier notes/coût une fois COMPLETED (historique conservé)", async () => {
    const createResponse = await createMaintenance(adminA, vehicleA1Id);
    const maintenanceId = (await createResponse.json()).maintenance.id;

    await apiFetch(`/api/maintenances/${maintenanceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });

    const response = await apiFetch(`/api/maintenances/${maintenanceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ notes: "Tentative de modification après complétion." }),
    });
    expect(response.status).toBe(409);
  });
});

describe("DELETE /api/maintenances/[id]", () => {
  it("supprime une maintenance SCHEDULED", async () => {
    const createResponse = await createMaintenance(adminA, vehicleA1Id);
    const maintenanceId = (await createResponse.json()).maintenance.id;

    const response = await apiFetch(`/api/maintenances/${maintenanceId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("refuse la suppression d'une maintenance COMPLETED (historique conservé)", async () => {
    const createResponse = await createMaintenance(adminA, vehicleA1Id);
    const maintenanceId = (await createResponse.json()).maintenance.id;

    await apiFetch(`/api/maintenances/${maintenanceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });

    const response = await apiFetch(`/api/maintenances/${maintenanceId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(409);
  });
});

describe("POST /api/tasks/check-alerts (génération d'alertes de maintenance)", () => {
  it("crée une alerte MAINTENANCE_DUE pour une maintenance planifiée aujourd'hui, réservé ADMIN", async () => {
    const memberAttempt = await apiFetch("/api/tasks/check-alerts", {
      method: "POST",
      headers: { Cookie: memberA.sessionCookie },
    });
    expect(memberAttempt.status).toBe(403);

    const dueMaintenanceResponse = await createMaintenance(adminA, vehicleA1Id, {
      scheduledDate: new Date().toISOString(),
    });
    const dueMaintenanceId = (await dueMaintenanceResponse.json()).maintenance.id;

    const response = await apiFetch("/api/tasks/check-alerts", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.created.dueMaintenances).toBeGreaterThanOrEqual(1);

    const alertsResponse = await apiFetch("/api/alerts?type=MAINTENANCE_DUE", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const alertsBody = await alertsResponse.json();
    const alertForMaintenance = alertsBody.alerts.find(
      (alert: { entityId: string }) => alert.entityId === dueMaintenanceId
    );
    expect(alertForMaintenance).toBeDefined();

    // Un second passage ne doit pas dupliquer l'alerte tant qu'elle n'est pas résolue.
    const second = await apiFetch("/api/tasks/check-alerts", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
    });
    const secondBody = await second.json();
    const alertsAfterSecond = await apiFetch("/api/alerts?type=MAINTENANCE_DUE", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const alertsAfterSecondBody = await alertsAfterSecond.json();
    const matchingAlerts = alertsAfterSecondBody.alerts.filter(
      (alert: { entityId: string }) => alert.entityId === dueMaintenanceId
    );
    expect(matchingAlerts).toHaveLength(1);
    expect(secondBody.created.dueMaintenances).toBe(0);
  });
});

describe("Sprint 19 — alertes véhicule proactives (assurance/vignette/contrôle technique/vidange)", () => {
  it("crée INSURANCE_EXPIRING/VIGNETTE_EXPIRING/TECHNICAL_INSPECTION_DUE pour un véhicule dont les échéances sont dépassées", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id, {
      insuranceExpiryDate: "2020-01-01",
      vignetteExpiryDate: "2020-01-01",
      technicalInspectionExpiryDate: "2020-01-01",
    });
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const response = await apiFetch("/api/tasks/check-alerts", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.created.insuranceExpiring).toBeGreaterThanOrEqual(1);
    expect(body.created.vignetteExpiring).toBeGreaterThanOrEqual(1);
    expect(body.created.technicalInspectionDue).toBeGreaterThanOrEqual(1);

    const alertsResponse = await apiFetch("/api/alerts", { headers: { Cookie: adminA.sessionCookie } });
    const alertsBody = await alertsResponse.json();
    const vehicleAlerts = alertsBody.alerts.filter((alert: { entityId: string }) => alert.entityId === vehicleId);
    const types = vehicleAlerts.map((alert: { type: string }) => alert.type);
    expect(types).toEqual(
      expect.arrayContaining(["INSURANCE_EXPIRING", "VIGNETTE_EXPIRING", "TECHNICAL_INSPECTION_DUE"])
    );
  });

  it("crée OIL_CHANGE_DUE par date, et par kilométrage via le dernier retour connu (transfert)", async () => {
    // Par date.
    const byDateResponse = await createVehicle(adminA, agencyA1Id, { nextOilChangeDate: "2020-01-01" });
    const byDateVehicleId = (await byDateResponse.json()).vehicle.id;

    // Par kilométrage : nextOilChangeKm bas, dernier kilométrage connu (via un transfert validé)
    // au-dessus du seuil.
    const byKmResponse = await createVehicle(adminA, agencyA1Id, { nextOilChangeKm: 1000 });
    const byKmVehicleId = (await byKmResponse.json()).vehicle.id;

    const agency2Response = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence Vidange 2", slug: `mt-agence2-${runId}` }),
    });
    const agency2Id = (await agency2Response.json()).agency.id;

    const transferResponse = await apiFetch("/api/vehicle-transfers", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId: byKmVehicleId, toAgencyId: agency2Id, responsibleUserId: adminA.userId }),
    });
    const transferId = (await transferResponse.json()).transfer.id;
    await apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      // Sprint 24 : endFuelLevel/arrivalDriverName désormais obligatoires en plus d'endOdometer.
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 50, arrivalDriverName: "Chauffeur Test" }),
    });

    const response = await apiFetch("/api/tasks/check-alerts", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.created.oilChangeDue).toBeGreaterThanOrEqual(2);

    const alertsResponse = await apiFetch("/api/alerts?type=OIL_CHANGE_DUE", { headers: { Cookie: adminA.sessionCookie } });
    const alertsBody = await alertsResponse.json();
    const entityIds = alertsBody.alerts.map((alert: { entityId: string }) => alert.entityId);
    expect(entityIds).toContain(byDateVehicleId);
    expect(entityIds).toContain(byKmVehicleId);
  });
});

describe("Sprint 15 — permissions granulaires (maintenances.create)", () => {
  it("refuse un MEMBER rattaché à l'agence mais dont le groupe personnalisé n'a pas maintenances.create", async () => {
    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoMaintenanceCreate-${runId}`, permissions: ["maintenances.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Member",
      email: `restricted-maintenances-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: restrictedMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const response = await createMaintenance(restrictedMember, vehicleA1Id);
    expect(response.status).toBe(403);
  });

  it("autorise un MEMBER dont le groupe personnalisé accorde maintenances.create", async () => {
    const grantedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: `WithMaintenanceCreate-${runId}`,
        permissions: ["maintenances.view", "maintenances.create"],
      }),
    });
    const grantedGroupId = (await grantedGroupResponse.json()).group.id;

    const grantedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Granted Member",
      email: `granted-maintenances-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: grantedMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${grantedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: grantedGroupId }),
    });

    const response = await createMaintenance(grantedMember, vehicleA1Id);
    expect(response.status).toBe(201);
  });

  it("un ADMIN planifie une maintenance même rattaché à un groupe personnalisé vide (bypass systématique)", async () => {
    const emptyGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `EmptyAdminGroup-${runId}`, permissions: [] }),
    });
    const emptyGroupId = (await emptyGroupResponse.json()).group.id;

    await apiFetch(`/api/users/${adminA.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: emptyGroupId }),
    });

    try {
      const response = await createMaintenance(adminA, vehicleA1Id);
      expect(response.status).toBe(201);
    } finally {
      await apiFetch(`/api/users/${adminA.userId}/permissions`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ permissionGroupId: null }),
      });
    }
  });
});

describe("Sprint 24 — maintenances.complete/cancel séparées de maintenances.edit", () => {
  async function createGroupAndMember(name: string, permissions: string[]) {
    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `${name}-${runId}`, permissions }),
    });
    const groupId = (await groupResponse.json()).group.id;

    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name,
      email: `${name.toLowerCase()}-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${member.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: groupId }),
    });
    return member;
  }

  it("maintenances.edit seul ne permet plus de terminer ni annuler", async () => {
    const editOnly = await createGroupAndMember("MtEditOnly", ["maintenances.view", "maintenances.edit"]);

    const createResponse = await createMaintenance(adminA, vehicleA1Id, { scheduledDate: "2030-07-01" });
    const maintenance = (await createResponse.json()).maintenance;

    for (const status of ["COMPLETED", "CANCELLED"]) {
      const response = await apiFetch(`/api/maintenances/${maintenance.id}`, {
        method: "PATCH",
        headers: { Cookie: editOnly.sessionCookie },
        body: JSON.stringify({ status }),
      });
      expect(response.status).toBe(403);
    }

    // Un champ générique (notes) reste autorisé avec maintenances.edit seul.
    const notesResponse = await apiFetch(`/api/maintenances/${maintenance.id}`, {
      method: "PATCH",
      headers: { Cookie: editOnly.sessionCookie },
      body: JSON.stringify({ notes: "Note ajoutée par MtEditOnly" }),
    });
    expect(notesResponse.status).toBe(200);
  });

  it("maintenances.complete seul termine, sans maintenances.edit", async () => {
    const completeOnly = await createGroupAndMember("MtCompleteOnly", ["maintenances.view", "maintenances.complete"]);

    const createResponse = await createMaintenance(adminA, vehicleA1Id, { scheduledDate: "2030-07-02" });
    const maintenance = (await createResponse.json()).maintenance;

    const completeResponse = await apiFetch(`/api/maintenances/${maintenance.id}`, {
      method: "PATCH",
      headers: { Cookie: completeOnly.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    expect(completeResponse.status).toBe(200);
    expect((await completeResponse.json()).maintenance.status).toBe("COMPLETED");

    const notesResponse = await apiFetch(`/api/maintenances/${maintenance.id}`, {
      method: "PATCH",
      headers: { Cookie: completeOnly.sessionCookie },
      body: JSON.stringify({ notes: "Tentative" }),
    });
    expect(notesResponse.status).toBe(403);
  });

  it("maintenances.cancel seul annule, sans maintenances.edit", async () => {
    const cancelOnly = await createGroupAndMember("MtCancelOnly", ["maintenances.view", "maintenances.cancel"]);

    const createResponse = await createMaintenance(adminA, vehicleA1Id, { scheduledDate: "2030-07-03" });
    const maintenance = (await createResponse.json()).maintenance;

    const cancelResponse = await apiFetch(`/api/maintenances/${maintenance.id}`, {
      method: "PATCH",
      headers: { Cookie: cancelOnly.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(cancelResponse.status).toBe(200);
    expect((await cancelResponse.json()).maintenance.status).toBe("CANCELLED");
  });

  it("un ADMIN (super admin du tenant) termine/annule une maintenance sans aucun groupe de permissions", async () => {
    const completeTargetResponse = await createMaintenance(adminA, vehicleA1Id, { scheduledDate: "2030-07-04" });
    const completeTarget = (await completeTargetResponse.json()).maintenance;
    const completeResponse = await apiFetch(`/api/maintenances/${completeTarget.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    expect(completeResponse.status).toBe(200);

    const cancelTargetResponse = await createMaintenance(adminA, vehicleA1Id, { scheduledDate: "2030-07-05" });
    const cancelTarget = (await cancelTargetResponse.json()).maintenance;
    const cancelResponse = await apiFetch(`/api/maintenances/${cancelTarget.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(cancelResponse.status).toBe(200);
  });
});
