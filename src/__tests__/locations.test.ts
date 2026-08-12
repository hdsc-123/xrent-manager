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
let agencyB1Id: string;
let vehicleAId: string; // pricePerDay = 5000 (50,00 MAD)
let vehicleBId: string;
let clientAId: string;
let clientBId: string;

async function createLocation(
  admin: AuthenticatedTestUser,
  overrides: Record<string, unknown> = {}
) {
  return apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      vehicleId: vehicleAId,
      clientId: clientAId,
      startDate: "2028-01-10",
      endDate: "2028-01-13",
      ...overrides,
    }),
  });
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Locations Test A",
    tenantSlug: `locations-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Locations Test B",
    tenantSlug: `locations-test-b-${runId}`,
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

  const agencyAResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A1", slug: `agence-a1-${runId}` }),
  });
  agencyA1Id = (await agencyAResponse.json()).agency.id;

  const agencyBResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Agence B1", slug: `agence-b1-${runId}` }),
  });
  agencyB1Id = (await agencyBResponse.json()).agency.id;

  const vehicleAResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      agencyId: agencyA1Id,
      name: "Clio",
      licensePlate: `LOC-A-${runId}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay: 5000,
    }),
  });
  vehicleAId = (await vehicleAResponse.json()).vehicle.id;

  const vehicleBResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({
      agencyId: agencyB1Id,
      name: "208",
      licensePlate: `LOC-B-${runId}`,
      make: "Peugeot",
      model: "208",
      year: 2022,
      category: "Citadine",
      pricePerDay: 4000,
    }),
  });
  vehicleBId = (await vehicleBResponse.json()).vehicle.id;

  const clientAResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Client A", email: `client-a-${runId}@test.local` }),
  });
  clientAId = (await clientAResponse.json()).client.id;

  const clientBResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Client B", email: `client-b-${runId}@test.local` }),
  });
  clientBId = (await clientBResponse.json()).client.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.payment.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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

describe("POST /api/locations", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/locations", {
      method: "POST",
      body: JSON.stringify({ vehicleId: vehicleAId, clientId: clientAId }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse une date de fin antérieure ou égale à la date de début", async () => {
    const response = await createLocation(adminA, { startDate: "2028-02-05", endDate: "2028-02-05" });
    expect(response.status).toBe(400);
  });

  it("refuse un véhicule d'un autre tenant (isolation multi-tenant)", async () => {
    const response = await createLocation(adminA, { vehicleId: vehicleBId });
    expect(response.status).toBe(404);
  });

  it("refuse un client d'un autre tenant (isolation multi-tenant)", async () => {
    const response = await createLocation(adminA, { clientId: clientBId });
    expect(response.status).toBe(404);
  });

  it("crée la location, calcule totalPrice = pricePerDay × jours et fixe le statut PENDING par défaut", async () => {
    const response = await createLocation(adminA, {
      startDate: "2028-01-10",
      endDate: "2028-01-13",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.status).toBe("PENDING");
    expect(body.location.pricePerDay).toBe(5000);
    expect(body.location.totalPrice).toBe(15000); // 3 jours × 5000
    expect(body.location.currency).toBe("MAD");
  });

  it("refuse une location en conflit avec une location existante sur le même véhicule", async () => {
    const first = await createLocation(adminA, { startDate: "2028-05-01", endDate: "2028-05-05" });
    expect(first.status).toBe(201);

    const conflicting = await createLocation(adminA, {
      startDate: "2028-05-03",
      endDate: "2028-05-08",
    });
    expect(conflicting.status).toBe(409);
    const body = await conflicting.json();
    expect(body.conflictingLocations).toHaveLength(1);
  });

  it("accepte une location adjacente (pas de chevauchement) sur le même véhicule", async () => {
    const response = await createLocation(adminA, { startDate: "2028-05-05", endDate: "2028-05-08" });
    expect(response.status).toBe(201);
  });

  it("refuse un MEMBER non rattaché à l'agence du véhicule", async () => {
    const response = await createLocation(memberA as unknown as AuthenticatedTestUser, {
      startDate: "2028-06-01",
      endDate: "2028-06-03",
    });
    expect(response.status).toBe(403);
  });

  it("persiste startOdometer/endOdometer/deposit (Sprint 12A)", async () => {
    const response = await createLocation(adminA, {
      startDate: "2029-01-15",
      endDate: "2029-01-17",
      startOdometer: 12000,
      endOdometer: 12250,
      deposit: 300000,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.startOdometer).toBe(12000);
    expect(body.location.endOdometer).toBe(12250);
    expect(body.location.deposit).toBe(300000);
  });

  it("refuse un kilométrage négatif", async () => {
    const response = await createLocation(adminA, {
      startDate: "2029-01-20",
      endDate: "2029-01-22",
      startOdometer: -10,
    });
    expect(response.status).toBe(400);
  });

  it("arrondit le nombre de jours au jour supérieur en tenant compte de l'heure (dépassement = jour supplémentaire)", async () => {
    // Départ 10/02 10:00, retour 12/02 11:00 → 2 jours + 1h de dépassement → 3 jours facturés.
    const response = await createLocation(adminA, {
      startDate: "2029-02-10T10:00:00.000Z",
      endDate: "2029-02-12T11:00:00.000Z",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.totalPrice).toBe(15000); // 3 jours × 5000
  });

  it("n'arrondit pas à un jour de plus pour un retour légèrement anticipé", async () => {
    // Départ 10/03 10:00, retour 12/03 09:59 → toujours 2 jours (pas de dépassement).
    const response = await createLocation(adminA, {
      startDate: "2029-03-10T10:00:00.000Z",
      endDate: "2029-03-12T09:59:00.000Z",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.totalPrice).toBe(10000); // 2 jours × 5000
  });
});

describe("GET /api/locations", () => {
  it("liste uniquement les locations du tenant connecté (isolation multi-tenant)", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-07-01",
      endDate: "2028-07-03",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch("/api/locations", { headers: { Cookie: adminA.sessionCookie } });
    const body = await response.json();
    const ids: string[] = body.locations.map((l: { id: string }) => l.id);
    expect(ids).toContain(locationId);

    const otherTenantResponse = await apiFetch("/api/locations", {
      headers: { Cookie: adminB.sessionCookie },
    });
    const otherBody = await otherTenantResponse.json();
    const otherIds: string[] = otherBody.locations.map((l: { id: string }) => l.id);
    expect(otherIds).not.toContain(locationId);
  });

  it("filtre par statut", async () => {
    const response = await apiFetch("/api/locations?status=PENDING", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.locations.every((l: { status: string }) => l.status === "PENDING")).toBe(true);
  });
});

describe("PATCH /api/locations/[id]", () => {
  it("retourne 404 pour une location d'un autre tenant", async () => {
    const otherLocationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({
        vehicleId: vehicleBId,
        clientId: clientBId,
        startDate: "2028-08-01",
        endDate: "2028-08-03",
      }),
    });
    const otherLocationId = (await otherLocationResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${otherLocationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(response.status).toBe(404);
  });

  it("autorise la transition PENDING → CONFIRMED", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-09-01",
      endDate: "2028-09-03",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.status).toBe("CONFIRMED");
  });

  it("refuse une transition de statut invalide (PENDING → COMPLETED)", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-09-10",
      endDate: "2028-09-13",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    expect(response.status).toBe(409);
  });

  it("recalcule totalPrice quand les dates changent", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-10-01",
      endDate: "2028-10-03",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ startDate: "2028-10-01", endDate: "2028-10-06" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.totalPrice).toBe(25000); // 5 jours × 5000
  });

  it("permet d'enregistrer le kilométrage de retour et la caution (Sprint 12A)", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2029-04-01",
      endDate: "2029-04-03",
      startOdometer: 50000,
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 50180 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.startOdometer).toBe(50000);
    expect(body.location.endOdometer).toBe(50180);
  });
});

describe("DELETE /api/locations/[id]", () => {
  it("supprime une location PENDING", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-11-01",
      endDate: "2028-11-03",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("refuse la suppression d'une location CONFIRMED (doit être annulée d'abord)", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-11-10",
      endDate: "2028-11-13",
    });
    const locationId = (await createResponse.json()).location.id;

    await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const deleteResponse = await apiFetch(`/api/locations/${locationId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(409);

    const cancelResponse = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(cancelResponse.status).toBe(200);

    const deleteAfterCancelResponse = await apiFetch(`/api/locations/${locationId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteAfterCancelResponse.status).toBe(200);
  });
});
