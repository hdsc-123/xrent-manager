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
      licensePlate: `VD-${Math.floor(Math.random() * 1_000_000)}-VD`,
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

async function createTrip(
  admin: AuthenticatedTestUser,
  vehicleId: string,
  employeeUserId: string,
  overrides: Record<string, unknown> = {}
) {
  return apiFetch("/api/vehicle-trips", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      employeeUserId,
      reason: "Livraison de documents",
      destination: "Agence centrale",
      startOdometer: 10000,
      ...overrides,
    }),
  });
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Trips Test A",
    tenantSlug: `trips-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Trips Test B",
    tenantSlug: `trips-test-b-${runId}`,
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
    body: JSON.stringify({ name: "Agence A1", slug: `vd-agence-a1-${runId}` }),
  });
  agencyA1Id = (await agencyA1Response.json()).agency.id;

  const agencyA2Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A2", slug: `vd-agence-a2-${runId}` }),
  });
  agencyA2Id = (await agencyA2Response.json()).agency.id;

  const agencyB1Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Agence B1", slug: `vd-agence-b1-${runId}` }),
  });
  agencyB1Id = (await agencyB1Response.json()).agency.id;

  await prisma.userAgency.create({ data: { userId: memberA.userId, agencyId: agencyA1Id } });

  vehicleB1Id = (await (await createVehicle(adminB, agencyB1Id)).json()).vehicle.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicleTrip.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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

describe("POST /api/vehicle-trips", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/vehicle-trips", { method: "POST", body: JSON.stringify({}) });
    expect(response.status).toBe(401);
  });

  it("crée un bon de déplacement : départ automatique, véhicule passe ON_TRIP", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const response = await createTrip(adminA, vehicleId, adminA.userId, {
      startFuelLevel: 90,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.trip.status).toBe("IN_PROGRESS");
    expect(body.trip.agencyId).toBe(agencyA1Id);
    expect(body.trip.departureDate).not.toBeNull();
    expect(body.trip.startOdometer).toBe(10000);

    const vehicleCheck = await apiFetch(`/api/vehicles/${vehicleId}`, { headers: { Cookie: adminA.sessionCookie } });
    const vehicleBody = await vehicleCheck.json();
    expect(vehicleBody.vehicle.status).toBe("ON_TRIP");
  });

  it("un véhicule EN DÉPLACEMENT n'est plus proposé comme disponible (?status=AVAILABLE)", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    await createTrip(adminA, vehicleId, adminA.userId);

    const listResponse = await apiFetch("/api/vehicles?status=AVAILABLE", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const listBody = await listResponse.json();
    const ids: string[] = listBody.vehicles.map((v: { id: string }) => v.id);
    expect(ids).not.toContain(vehicleId);
  });

  it("bloque un second déplacement sur un véhicule déjà en déplacement", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const first = await createTrip(adminA, vehicleId, adminA.userId);
    expect(first.status).toBe(201);

    const second = await createTrip(adminA, vehicleId, adminA.userId);
    expect(second.status).toBe(409);
  });

  it("refuse un véhicule d'un autre tenant (isolation multi-tenant)", async () => {
    const response = await createTrip(adminA, vehicleB1Id, adminA.userId);
    expect(response.status).toBe(404);
  });

  it("refuse un MEMBER non rattaché à l'agence du véhicule", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA2Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const response = await createTrip(memberA, vehicleId, memberA.userId);
    expect(response.status).toBe(403);
  });
});

describe("PATCH /api/vehicle-trips/[id]/return", () => {
  it("bloque le retour si le kilométrage retour n'est pas strictement supérieur au départ", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await createTrip(adminA, vehicleId, adminA.userId, { startOdometer: 20000 });
    const tripId = (await createResponse.json()).trip.id;

    const sameOdometer = await apiFetch(`/api/vehicle-trips/${tripId}/return`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 20000 }),
    });
    expect(sameOdometer.status).toBe(400);

    const lowerOdometer = await apiFetch(`/api/vehicle-trips/${tripId}/return`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 19999 }),
    });
    expect(lowerOdometer.status).toBe(400);
  });

  it("enregistre le retour : véhicule redevient AVAILABLE, kilométrage/carburant retour persistés", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await createTrip(adminA, vehicleId, adminA.userId, { startOdometer: 30000 });
    const tripId = (await createResponse.json()).trip.id;

    const response = await apiFetch(`/api/vehicle-trips/${tripId}/return`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 30150, endFuelLevel: 55 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.trip.status).toBe("COMPLETED");
    expect(body.trip.endOdometer).toBe(30150);
    expect(body.trip.returnDate).not.toBeNull();

    const vehicleCheck = await apiFetch(`/api/vehicles/${vehicleId}`, { headers: { Cookie: adminA.sessionCookie } });
    const vehicleBody = await vehicleCheck.json();
    expect(vehicleBody.vehicle.status).toBe("AVAILABLE");
  });

  it("Sprint 19 : refuse un retour sans carburant retour (désormais obligatoire)", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await createTrip(adminA, vehicleId, adminA.userId, { startOdometer: 40000 });
    const tripId = (await createResponse.json()).trip.id;

    const response = await apiFetch(`/api/vehicle-trips/${tripId}/return`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 40100 }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("endFuelLevel");
  });
});

describe("PATCH /api/vehicle-trips/[id]/cancel", () => {
  it("annule un déplacement EN COURS : le véhicule redevient AVAILABLE", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await createTrip(adminA, vehicleId, adminA.userId);
    const tripId = (await createResponse.json()).trip.id;

    const response = await apiFetch(`/api/vehicle-trips/${tripId}/cancel`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);

    const vehicleCheck = await apiFetch(`/api/vehicles/${vehicleId}`, { headers: { Cookie: adminA.sessionCookie } });
    const vehicleBody = await vehicleCheck.json();
    expect(vehicleBody.vehicle.status).toBe("AVAILABLE");
  });
});

describe("Sprint 23 — correctif de concurrence sur returnVehicleTrip/cancelVehicleTrip (DOMAINRULES.md section 39, étend le correctif Sprint 22)", () => {
  it("retour et annulation concurrents sur le même déplacement — une seule réussit (409 pour l'autre)", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await createTrip(adminA, vehicleId, adminA.userId);
    const tripId = (await createResponse.json()).trip.id;

    const [returnResponse, cancelResponse] = await Promise.all([
      apiFetch(`/api/vehicle-trips/${tripId}/return`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ endOdometer: 10500, endFuelLevel: 75 }),
      }),
      apiFetch(`/api/vehicle-trips/${tripId}/cancel`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
      }),
    ]);

    const statuses = [returnResponse.status, cancelResponse.status].sort();
    expect(statuses).toEqual([200, 409]);

    const finalCheck = await apiFetch(`/api/vehicle-trips/${tripId}`, { headers: { Cookie: adminA.sessionCookie } });
    const finalTrip = (await finalCheck.json()).trip;
    expect(["COMPLETED", "CANCELLED"]).toContain(finalTrip.status);
  });
});

describe("Sprint 15 — permissions granulaires (vehicle_trips.create)", () => {
  it("refuse un MEMBER rattaché à l'agence mais dont le groupe personnalisé n'a pas vehicle_trips.create", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoTripCreate-${runId}`, permissions: ["vehicle_trips.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Member",
      email: `restricted-trips-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: restrictedMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const response = await createTrip(restrictedMember, vehicleId, restrictedMember.userId);
    expect(response.status).toBe(403);
  });

  it("autorise un MEMBER dont le groupe personnalisé accorde vehicle_trips.create", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const grantedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: `WithTripCreate-${runId}`,
        permissions: ["vehicle_trips.view", "vehicle_trips.create"],
      }),
    });
    const grantedGroupId = (await grantedGroupResponse.json()).group.id;

    const grantedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Granted Member",
      email: `granted-trips-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: grantedMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${grantedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: grantedGroupId }),
    });

    const response = await createTrip(grantedMember, vehicleId, grantedMember.userId);
    expect(response.status).toBe(201);
  });

  it("un ADMIN crée un bon de déplacement même rattaché à un groupe personnalisé vide (bypass systématique)", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

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
      const response = await createTrip(adminA, vehicleId, adminA.userId);
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
