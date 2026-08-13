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
      licensePlate: `VT-${Math.floor(Math.random() * 1_000_000)}-VT`,
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

async function createTransfer(
  admin: AuthenticatedTestUser,
  vehicleId: string,
  toAgencyId: string,
  responsibleUserId: string,
  overrides: Record<string, unknown> = {}
) {
  return apiFetch("/api/vehicle-transfers", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ vehicleId, toAgencyId, responsibleUserId, ...overrides }),
  });
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Transfers Test A",
    tenantSlug: `transfers-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Transfers Test B",
    tenantSlug: `transfers-test-b-${runId}`,
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
    body: JSON.stringify({ name: "Agence A1", slug: `vt-agence-a1-${runId}` }),
  });
  agencyA1Id = (await agencyA1Response.json()).agency.id;

  const agencyA2Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A2", slug: `vt-agence-a2-${runId}` }),
  });
  agencyA2Id = (await agencyA2Response.json()).agency.id;

  const agencyB1Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Agence B1", slug: `vt-agence-b1-${runId}` }),
  });
  agencyB1Id = (await agencyB1Response.json()).agency.id;

  await prisma.userAgency.create({ data: { userId: memberA.userId, agencyId: agencyA1Id } });

  vehicleB1Id = (await (await createVehicle(adminB, agencyB1Id)).json()).vehicle.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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

describe("POST /api/vehicle-transfers", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/vehicle-transfers", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(401);
  });

  it("lance un transfert : fromAgencyId dérivé du véhicule, véhicule passe TRANSFERRING", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const response = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId, {
      startOdometer: 10000,
      startFuelLevel: 80,
      reason: "Réaffectation flotte",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.transfer.fromAgencyId).toBe(agencyA1Id);
    expect(body.transfer.toAgencyId).toBe(agencyA2Id);
    expect(body.transfer.status).toBe("IN_TRANSIT");

    const vehicleCheck = await apiFetch(`/api/vehicles/${vehicleId}`, { headers: { Cookie: adminA.sessionCookie } });
    const vehicleBody = await vehicleCheck.json();
    expect(vehicleBody.vehicle.status).toBe("TRANSFERRING");
    // Toujours rattaché à l'agence de départ tant que non validé.
    expect(vehicleBody.vehicle.agencyId).toBe(agencyA1Id);
  });

  it("un véhicule EN TRANSIT n'est plus proposé comme disponible (?status=AVAILABLE)", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId);

    const listResponse = await apiFetch("/api/vehicles?status=AVAILABLE", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const listBody = await listResponse.json();
    const ids: string[] = listBody.vehicles.map((v: { id: string }) => v.id);
    expect(ids).not.toContain(vehicleId);
  });

  it("bloque un transfert incohérent : agence d'arrivée identique à l'agence de départ", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const response = await createTransfer(adminA, vehicleId, agencyA1Id, adminA.userId);
    expect(response.status).toBe(400);
  });

  it("bloque un second transfert sur un véhicule déjà EN TRANSIT (véhicule non AVAILABLE)", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const first = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId);
    expect(first.status).toBe(201);

    const second = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId);
    expect(second.status).toBe(409);
  });

  it("refuse un véhicule d'un autre tenant (isolation multi-tenant)", async () => {
    const response = await createTransfer(adminA, vehicleB1Id, agencyA2Id, adminA.userId);
    expect(response.status).toBe(404);
  });

  it("refuse un MEMBER non rattaché à l'agence de départ du véhicule", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA2Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const response = await createTransfer(memberA, vehicleId, agencyA1Id, memberA.userId);
    expect(response.status).toBe(403);
  });
});

describe("PATCH /api/vehicle-transfers/[id]/validate", () => {
  it("valide la réception : véhicule rattaché à la nouvelle agence, repasse AVAILABLE", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId, {
      startOdometer: 5000,
    });
    const transferId = (await createResponse.json()).transfer.id;

    const response = await apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 5200, endFuelLevel: 60 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.transfer.status).toBe("COMPLETED");
    expect(body.transfer.endOdometer).toBe(5200);

    const vehicleCheck = await apiFetch(`/api/vehicles/${vehicleId}`, { headers: { Cookie: adminA.sessionCookie } });
    const vehicleBody = await vehicleCheck.json();
    expect(vehicleBody.vehicle.agencyId).toBe(agencyA2Id);
    expect(vehicleBody.vehicle.status).toBe("AVAILABLE");
  });

  it("bloque la validation si le kilométrage d'arrivée est inférieur au départ", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId, {
      startOdometer: 8000,
    });
    const transferId = (await createResponse.json()).transfer.id;

    const response = await apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 7000 }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse de revalider un transfert déjà COMPLETED", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId);
    const transferId = (await createResponse.json()).transfer.id;

    await apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({}),
    });

    const response = await apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(409);
  });
});

describe("PATCH /api/vehicle-transfers/[id]/cancel", () => {
  it("annule un transfert EN TRANSIT : le véhicule redevient AVAILABLE à l'agence de départ", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId);
    const transferId = (await createResponse.json()).transfer.id;

    const response = await apiFetch(`/api/vehicle-transfers/${transferId}/cancel`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);

    const vehicleCheck = await apiFetch(`/api/vehicles/${vehicleId}`, { headers: { Cookie: adminA.sessionCookie } });
    const vehicleBody = await vehicleCheck.json();
    expect(vehicleBody.vehicle.status).toBe("AVAILABLE");
    expect(vehicleBody.vehicle.agencyId).toBe(agencyA1Id);
  });
});
