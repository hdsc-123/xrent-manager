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
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Vehicles Test B",
    tenantSlug: `vehicles-test-b-${runId}`,
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

  it("Sprint 18 — refuse une année manifestement absurde (plafond haut)", async () => {
    const response = await createVehicle(adminA, agencyA1Id, { year: 9999 });
    expect(response.status).toBe(400);
  });

  it("autorise un MEMBER une fois explicitement rattaché à l'agence", async () => {
    await prisma.userAgency.create({ data: { userId: memberA.userId, agencyId: agencyA1Id } });

    const response = await createVehicle(memberA, agencyA1Id);
    expect(response.status).toBe(201);
  });

  it("persiste la fiche technique professionnelle (Sprint 12A)", async () => {
    const response = await createVehicle(adminA, agencyA1Id, {
      color: "Blanc",
      doors: 5,
      seats: 5,
      transmission: "AUTOMATIQUE",
      fuel: "DIESEL",
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
      ac: true,
      gps: true,
      chassisNumber: "VF1CHASSIS123",
      imageUrl: "https://example.test/vehicle.jpg",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.vehicle.color).toBe("Blanc");
    expect(body.vehicle.doors).toBe(5);
    expect(body.vehicle.transmission).toBe("AUTOMATIQUE");
    expect(body.vehicle.fuel).toBe("DIESEL");
    expect(body.vehicle.ac).toBe(true);
    expect(body.vehicle.gps).toBe(true);
    expect(body.vehicle.engineSize).toBe(1.5);
  });

  it("accepte toujours une création minimale sans les nouveaux champs (rétrocompatibilité)", async () => {
    const response = await createVehicle(adminA, agencyA1Id);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.vehicle.color).toBeNull();
    expect(body.vehicle.ac).toBe(false);
    expect(body.vehicle.gps).toBe(false);
  });

  it("refuse une transmission invalide", async () => {
    const response = await createVehicle(adminA, agencyA1Id, { transmission: "TURBO" });
    expect(response.status).toBe(400);
  });

  it("crée un véhicule sans pricePerDay (Sprint 14A : champ optionnel/informatif)", async () => {
    const response = await createVehicle(adminA, agencyA1Id, { pricePerDay: undefined });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.vehicle.pricePerDay).toBeNull();
  });

  it("refuse un pricePerDay non positif s'il est fourni", async () => {
    const response = await createVehicle(adminA, agencyA1Id, { pricePerDay: 0 });
    expect(response.status).toBe(400);
  });

  it("refuse un nombre de portes négatif", async () => {
    const response = await createVehicle(adminA, agencyA1Id, { doors: -1 });
    expect(response.status).toBe(400);
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

  it("permet de modifier puis d'effacer un champ optionnel de la fiche technique (Sprint 12A)", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id, { color: "Rouge" });
    const vehicleId = (await createResponse.json()).vehicle.id;

    const setResponse = await apiFetch(`/api/vehicles/${vehicleId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ color: "Bleu", doors: 3 }),
    });
    expect(setResponse.status).toBe(200);
    expect((await setResponse.json()).vehicle.color).toBe("Bleu");

    const clearResponse = await apiFetch(`/api/vehicles/${vehicleId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ color: null }),
    });
    expect(clearResponse.status).toBe(200);
    expect((await clearResponse.json()).vehicle.color).toBeNull();
  });

  it("Sprint 19 : persiste puis efface les champs d'alertes proactives (assurance/vignette/contrôle technique/vidange)", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await createResponse.json()).vehicle.id;

    const setResponse = await apiFetch(`/api/vehicles/${vehicleId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        insuranceExpiryDate: "2031-01-01",
        vignetteExpiryDate: "2031-02-01",
        technicalInspectionExpiryDate: "2031-03-01",
        nextOilChangeDate: "2031-04-01",
        nextOilChangeKm: 50000,
      }),
    });
    expect(setResponse.status).toBe(200);
    const setBody = await setResponse.json();
    expect(setBody.vehicle.insuranceExpiryDate).toContain("2031-01-01");
    expect(setBody.vehicle.vignetteExpiryDate).toContain("2031-02-01");
    expect(setBody.vehicle.technicalInspectionExpiryDate).toContain("2031-03-01");
    expect(setBody.vehicle.nextOilChangeDate).toContain("2031-04-01");
    expect(setBody.vehicle.nextOilChangeKm).toBe(50000);

    const invalidDate = await apiFetch(`/api/vehicles/${vehicleId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ insuranceExpiryDate: "not-a-date" }),
    });
    expect(invalidDate.status).toBe(400);

    const clearResponse = await apiFetch(`/api/vehicles/${vehicleId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ insuranceExpiryDate: null, nextOilChangeKm: null }),
    });
    expect(clearResponse.status).toBe(200);
    const clearBody = await clearResponse.json();
    expect(clearBody.vehicle.insuranceExpiryDate).toBeNull();
    expect(clearBody.vehicle.nextOilChangeKm).toBeNull();
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

  // Sprint 16 (audit sécurité) : findConflictingLocations (src/lib/vehicles.ts) renvoyait
  // jusqu'ici l'enregistrement Location complet (prix, caution, notes, clientId) dans
  // VehicleNotAvailableError.conflictingLocations — exposé sans vérifier locations.view sur
  // POST/PATCH /api/locations et POST /api/reservations/[id]/convert. Seuls id/dates/statut
  // sont désormais sélectionnés.
  it("Sprint 16 — un conflit de disponibilité n'expose que id/dates/statut, jamais prix/caution/notes/clientId", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await createResponse.json()).vehicle.id;

    const clientResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Client Sensible Conflict Test" }),
    });
    const clientId = (await clientResponse.json()).client.id;

    await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        clientId,
        startDate: "2027-04-10",
        endDate: "2027-04-15",
        deposit: 500000,
        notes: "Note confidentielle sur ce contrat.",
      }),
    });

    // Une seconde création en conflit déclenche VehicleNotAvailableError (409), le chemin
    // effectivement exposé au client — pas seulement GET availability (lecture pure).
    const conflictResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        clientId,
        startDate: "2027-04-12",
        endDate: "2027-04-20",
      }),
    });
    expect(conflictResponse.status).toBe(409);
    const body = await conflictResponse.json();
    expect(body.conflictingLocations).toHaveLength(1);
    const conflict = body.conflictingLocations[0];
    expect(Object.keys(conflict).sort()).toEqual(["endDate", "id", "startDate", "status"]);
    expect(conflict).not.toHaveProperty("deposit");
    expect(conflict).not.toHaveProperty("notes");
    expect(conflict).not.toHaveProperty("clientId");
    expect(conflict).not.toHaveProperty("pricePerDay");
    expect(conflict).not.toHaveProperty("totalPrice");
  });
});

describe("Sprint 15 — permissions granulaires (vehicles.create)", () => {
  it("refuse un MEMBER rattaché à l'agence mais dont le groupe personnalisé n'a pas vehicles.create", async () => {
    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoVehicleCreate-${runId}`, permissions: ["vehicles.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Member",
      email: `restricted-vehicles-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: restrictedMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const response = await createVehicle(restrictedMember, agencyA1Id);
    expect(response.status).toBe(403);
  });

  it("autorise un MEMBER dont le groupe personnalisé accorde vehicles.create", async () => {
    const grantedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `WithVehicleCreate-${runId}`, permissions: ["vehicles.view", "vehicles.create"] }),
    });
    const grantedGroupId = (await grantedGroupResponse.json()).group.id;

    const grantedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Granted Member",
      email: `granted-vehicles-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: grantedMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${grantedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: grantedGroupId }),
    });

    const response = await createVehicle(grantedMember, agencyA1Id);
    expect(response.status).toBe(201);
  });

  it("un ADMIN crée un véhicule même rattaché à un groupe personnalisé vide (bypass systématique)", async () => {
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
      const response = await createVehicle(adminA, agencyA1Id);
      expect(response.status).toBe(201);
    } finally {
      // Nettoyage : on retire le groupe restrictif pour ne pas affecter les tests suivants.
      await apiFetch(`/api/users/${adminA.userId}/permissions`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ permissionGroupId: null }),
      });
    }
  });
});
