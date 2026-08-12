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
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.maintenance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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
