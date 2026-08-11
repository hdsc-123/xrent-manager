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
      licensePlate: `AA-${Math.floor(Math.random() * 1_000_000)}-AA`,
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

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Vehicles Test A",
    tenantSlug: `vehicles-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "correct-horse-battery-staple",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Vehicles Test B",
    tenantSlug: `vehicles-test-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password: "correct-horse-battery-staple",
  });
  createdTenantIds.push(adminB.tenantId);

  memberA = await createAndLoginMember({
    tenantId: adminA.tenantId,
    name: "Member A",
    email: `member-a-${runId}@test.local`,
    password: "correct-horse-battery-staple",
  });

  const agencyA1Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A1", slug: `agence-a1-${runId}` }),
  });
  agencyA1Id = (await agencyA1Response.json()).agency.id;

  const agencyA2Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A2", slug: `agence-a2-${runId}` }),
  });
  agencyA2Id = (await agencyA2Response.json()).agency.id;

  const agencyB1Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Agence B1", slug: `agence-b1-${runId}` }),
  });
  agencyB1Id = (await agencyB1Response.json()).agency.id;
});

afterAll(async () => {
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("POST /api/vehicles", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/vehicles", {
      method: "POST",
      body: JSON.stringify({ agencyId: agencyA1Id }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER non rattaché à l'agence", async () => {
    const response = await createVehicle(memberA as unknown as AuthenticatedTestUser, agencyA1Id);
    expect(response.status).toBe(403);
  });

  it("refuse une agence appartenant à un autre tenant (isolation multi-tenant)", async () => {
    const response = await createVehicle(adminA, agencyB1Id);
    expect(response.status).toBe(403);
  });

  it("crée le véhicule rattaché au tenant et à l'agence de l'ADMIN connecté", async () => {
    const response = await createVehicle(adminA, agencyA1Id);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.vehicle.tenantId).toBe(adminA.tenantId);
    expect(body.vehicle.agencyId).toBe(agencyA1Id);
    expect(body.vehicle.currency).toBe("MAD");
  });

  it("refuse une immatriculation dupliquée pour le même tenant", async () => {
    const plate = `DUP-${runId}`;
    const first = await createVehicle(adminA, agencyA1Id, { licensePlate: plate });
    expect(first.status).toBe(201);

    const second = await createVehicle(adminA, agencyA1Id, { licensePlate: plate });
    expect(second.status).toBe(409);
  });

  it("autorise un MEMBER une fois explicitement rattaché à l'agence", async () => {
    await prisma.userAgency.create({ data: { userId: memberA.userId, agencyId: agencyA1Id } });

    const response = await createVehicle(memberA, agencyA1Id);
    expect(response.status).toBe(201);
  });
});

describe("GET /api/vehicles", () => {
  it("liste uniquement les véhicules du tenant connecté (isolation multi-tenant)", async () => {
    const vehicleAResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleAId = (await vehicleAResponse.json()).vehicle.id;

    const vehicleBResponse = await createVehicle(adminB, agencyB1Id);
    const vehicleBId = (await vehicleBResponse.json()).vehicle.id;

    const response = await apiFetch("/api/vehicles", { headers: { Cookie: adminA.sessionCookie } });
    const body = await response.json();
    const ids: string[] = body.vehicles.map((v: { id: string }) => v.id);
    expect(ids).toContain(vehicleAId);
    expect(ids).not.toContain(vehicleBId);
  });

  it("restreint un MEMBER aux véhicules de ses agences rattachées (isolation multi-agence)", async () => {
    const vehicleA2Response = await createVehicle(adminA, agencyA2Id);
    const vehicleA2Id = (await vehicleA2Response.json()).vehicle.id;

    // memberA est rattaché à agencyA1 (test précédent) mais pas à agencyA2.
    const response = await apiFetch("/api/vehicles", { headers: { Cookie: memberA.sessionCookie } });
    const body = await response.json();
    const ids: string[] = body.vehicles.map((v: { id: string }) => v.id);
    expect(ids).not.toContain(vehicleA2Id);
  });
});

describe("GET /api/vehicles/[id]", () => {
  it("retourne 404 pour un véhicule d'un autre tenant", async () => {
    const vehicleBResponse = await createVehicle(adminB, agencyB1Id);
    const vehicleBId = (await vehicleBResponse.json()).vehicle.id;

    const response = await apiFetch(`/api/vehicles/${vehicleBId}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/vehicles/[id]", () => {
  it("permet de modifier le prix et le statut", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await createResponse.json()).vehicle.id;

    const response = await apiFetch(`/api/vehicles/${vehicleId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ pricePerDay: 6000, status: "MAINTENANCE" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vehicle.pricePerDay).toBe(6000);
    expect(body.vehicle.status).toBe("MAINTENANCE");
  });
});

describe("DELETE /api/vehicles/[id]", () => {
  it("supprime un véhicule sans location", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await createResponse.json()).vehicle.id;

    const response = await apiFetch(`/api/vehicles/${vehicleId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("refuse la suppression d'un véhicule ayant une location", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await createResponse.json()).vehicle.id;

    const clientResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Client Delete Test" }),
    });
    const clientId = (await clientResponse.json()).client.id;

    await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        clientId,
        startDate: "2027-01-01",
        endDate: "2027-01-03",
      }),
    });

    const response = await apiFetch(`/api/vehicles/${vehicleId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(409);
  });
});

describe("GET /api/vehicles/[id]/availability", () => {
  it("indique le véhicule disponible en l'absence de location", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await createResponse.json()).vehicle.id;

    const response = await apiFetch(
      `/api/vehicles/${vehicleId}/availability?start=2027-02-01&end=2027-02-05`,
      { headers: { Cookie: adminA.sessionCookie } }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.available).toBe(true);
    expect(body.conflictingLocations).toHaveLength(0);
  });

  it("détecte un conflit avec une location existante", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await createResponse.json()).vehicle.id;

    const clientResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Client Availability Test" }),
    });
    const clientId = (await clientResponse.json()).client.id;

    await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        clientId,
        startDate: "2027-03-10",
        endDate: "2027-03-15",
      }),
    });

    const conflicting = await apiFetch(
      `/api/vehicles/${vehicleId}/availability?start=2027-03-12&end=2027-03-20`,
      { headers: { Cookie: adminA.sessionCookie } }
    );
    const conflictingBody = await conflicting.json();
    expect(conflictingBody.available).toBe(false);
    expect(conflictingBody.conflictingLocations).toHaveLength(1);

    const free = await apiFetch(
      `/api/vehicles/${vehicleId}/availability?start=2027-03-15&end=2027-03-20`,
      { headers: { Cookie: adminA.sessionCookie } }
    );
    const freeBody = await free.json();
    expect(freeBody.available).toBe(true);
  });
});
