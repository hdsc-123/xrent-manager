import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

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
  await deleteTestTenants(createdTenantIds);
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

  it("Sprint technique 5 (audit de sécurité) : ignore un `currency` fourni par le client, jamais exposé par le formulaire ni validé côté serveur", async () => {
    const response = await createVehicle(adminA, agencyA1Id, { currency: "EUR" });
    expect(response.status).toBe(201);
    const body = await response.json();
    // Reste à la valeur par défaut du schéma — un `currency` arbitraire non gardé fausserait
    // silencieusement les agrégats financiers (src/lib/reports.ts) qui additionnent des montants
    // sans jamais les regrouper par devise.
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

  it("Sprint 24-2 : ac/gps restent optionnels (défaut false) même avec les 7 champs techniques désormais obligatoires fournis", async () => {
    const response = await createVehicle(adminA, agencyA1Id);
    expect(response.status).toBe(201);
    const body = await response.json();
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
  it("Sprint technique 5 (audit de sécurité, faille corrigée) : un champ `tenantId` injecté dans le corps de la requête ne rattache jamais le véhicule à un autre tenant", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await createResponse.json()).vehicle.id;

    // Avant correction, PATCH construisait sa mise à jour Prisma à partir d'un spread du corps
    // brut de la requête (`...bodyWithoutDates`) : `tenantId` est une colonne réelle de Vehicle,
    // acceptée sans filtrage par Prisma — un simple appel API (hors de toute interface, qui
    // n'envoie jamais ce champ) suffisait à faire passer un véhicule d'un tenant à l'autre,
    // cassant l'isolation tenant (SECURITY.md section 1) pour quiconque a seulement
    // `vehicles.edit`, sans avoir besoin d'aucun privilège supplémentaire.
    const response = await apiFetch(`/api/vehicles/${vehicleId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ tenantId: adminB.tenantId, color: "Vert" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    // Le champ légitime de la requête est bien appliqué...
    expect(body.vehicle.color).toBe("Vert");
    // ...mais tenantId reste strictement inchangé.
    expect(body.vehicle.tenantId).toBe(adminA.tenantId);

    const persisted = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    expect(persisted.tenantId).toBe(adminA.tenantId);

    // Le véhicule reste invisible depuis le tenant B (aucune fuite inter-tenant provoquée).
    const fromTenantB = await apiFetch(`/api/vehicles/${vehicleId}`, {
      headers: { Cookie: adminB.sessionCookie },
    });
    expect(fromTenantB.status).toBe(404);
  });

  it("Sprint technique 5 (audit de sécurité, faille corrigée) : `id`/`createdAt` injectés dans le corps de la requête sont sans effet", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id);
    const created = (await createResponse.json()).vehicle;

    const response = await apiFetch(`/api/vehicles/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ id: "attacker-chosen-id", createdAt: "2000-01-01T00:00:00.000Z" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vehicle.id).toBe(created.id);
    expect(body.vehicle.createdAt).toBe(created.createdAt);
  });

  it("Sprint technique 5 (audit de sécurité) : `currency` ne peut plus être modifié via PATCH", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await createResponse.json()).vehicle.id;

    const response = await apiFetch(`/api/vehicles/${vehicleId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ currency: "EUR" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).vehicle.currency).toBe("MAD");
  });

  it("permet de modifier le prix", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await createResponse.json()).vehicle.id;

    const response = await apiFetch(`/api/vehicles/${vehicleId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ pricePerDay: 6000 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vehicle.pricePerDay).toBe(6000);
  });

  // Sprint "statut opérationnel automatique" (2026-08-28) : le statut n'est plus jamais
  // modifiable via cette route, même conjointement à un champ légitime (pricePerDay) — la
  // requête entière est rejetée, aucun champ n'est appliqué.
  it("rejette toute la requête si status est fourni, même conjointement à un champ légitime", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await createResponse.json()).vehicle.id;

    const response = await apiFetch(`/api/vehicles/${vehicleId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ pricePerDay: 6000, status: "MAINTENANCE" }),
    });
    expect(response.status).toBe(400);

    const after = await apiFetch(`/api/vehicles/${vehicleId}`, { headers: { Cookie: adminA.sessionCookie } });
    const afterBody = await after.json();
    expect(afterBody.vehicle.pricePerDay).not.toBe(6000);
    expect(afterBody.vehicle.status).toBe("AVAILABLE");
  });

  it("Sprint 24-2 : permet de modifier un champ de la fiche technique désormais obligatoire, mais refuse de l'effacer", async () => {
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
    expect(clearResponse.status).toBe(400);
    // La valeur précédente (validée) n'a pas été écrasée par la tentative refusée.
    const unchanged = await apiFetch(`/api/vehicles/${vehicleId}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect((await unchanged.json()).vehicle.color).toBe("Bleu");
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
      body: JSON.stringify({ name: "Client Delete Test", licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
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
      body: JSON.stringify({ name: "Client Availability Test", licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
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
      body: JSON.stringify({ name: "Client Sensible Conflict Test", licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
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

describe("Sprint 22 — GET /dashboard/vehicles/[id] : fiche complète en lecture seule sans vehicles.edit", () => {
  it("affiche les données du véhicule (immatriculation, couleur) à un user ayant vehicles.view sans vehicles.edit", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id, {
      licensePlate: `RO-${Math.floor(Math.random() * 1_000_000)}-RO`,
      color: "Bleu Marine Sprint22",
    });
    const vehicle = (await createResponse.json()).vehicle;

    const viewOnlyGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `ViewOnlyVehicles-${runId}`, permissions: ["vehicles.view", "agencies.view"] }),
    });
    const viewOnlyGroupId = (await viewOnlyGroupResponse.json()).group.id;

    const readOnlyMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Read Only Vehicles Member",
      email: `ro-vehicles-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: readOnlyMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${readOnlyMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: viewOnlyGroupId }),
    });

    const response = await apiFetch(`/dashboard/vehicles/${vehicle.id}`, {
      headers: { Cookie: readOnlyMember.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    // La fiche complète reste visible (pas seulement le message de refus) — voir
    // VehicleReadOnlyDetails.tsx.
    expect(html).toContain(vehicle.licensePlate);
    expect(html).toContain("Bleu Marine Sprint22");
    expect(html).toContain("permission de modifier ce véhicule");
    expect(html).not.toContain("Modifier le véhicule");
  });
});

describe("Sprint 24 — kilométrage/carburant actuels à la création véhicule", () => {
  it("accepte currentOdometer/currentFuelLevel à la création et les renvoie tels quels", async () => {
    const response = await createVehicle(adminA, agencyA1Id, { currentOdometer: 15000, currentFuelLevel: 80 });
    expect(response.status).toBe(201);
    const { vehicle } = await response.json();
    expect(vehicle.currentOdometer).toBe(15000);
    expect(vehicle.currentFuelLevel).toBe(80);
  });

  it("refuse un currentOdometer négatif", async () => {
    const response = await createVehicle(adminA, agencyA1Id, { currentOdometer: -1 });
    expect(response.status).toBe(400);
  });

  it("refuse un currentFuelLevel hors de la plage 0-100", async () => {
    const response = await createVehicle(adminA, agencyA1Id, { currentFuelLevel: 150 });
    expect(response.status).toBe(400);
  });

  it("currentOdometer/currentFuelLevel restent optionnels (véhicule créé sans eux)", async () => {
    const response = await createVehicle(adminA, agencyA1Id);
    expect(response.status).toBe(201);
    const { vehicle } = await response.json();
    expect(vehicle.currentOdometer).toBeNull();
    expect(vehicle.currentFuelLevel).toBeNull();
  });

  it("le prix journalier informatif (pricePerDay) reste optionnel malgré l'ajout de ces champs", async () => {
    const response = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId: agencyA1Id,
        name: "Sans prix",
        licensePlate: `NOPRICE-${Math.floor(Math.random() * 1_000_000)}`,
        make: "Renault",
        model: "Clio",
        year: 2022,
        category: "Citadine",
        chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
        color: "Blanc",
        doors: 5,
        seats: 5,
        horsepower: 6,
        powerKW: 75,
        engineSize: 1.5,
        currentOdometer: 5000,
        currentFuelLevel: 100,
      }),
    });
    expect(response.status).toBe(201);
    const { vehicle } = await response.json();
    expect(vehicle.pricePerDay).toBeNull();
  });

  it("GET /api/vehicles/[id]/last-known-state retombe sur currentOdometer/currentFuelLevel tant qu'aucun mouvement (location/transfert/déplacement) n'existe", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id, { currentOdometer: 42000, currentFuelLevel: 60 });
    const vehicle = (await createResponse.json()).vehicle;

    const response = await apiFetch(`/api/vehicles/${vehicle.id}/last-known-state`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.odometer).toBe(42000);
    expect(body.fuelLevel).toBe(60);
  });
});

describe("Sprint 24-1 — kilométrage/carburant actuels modifiables après création (PATCH)", () => {
  it("accepte de définir currentOdometer/currentFuelLevel sur un véhicule qui n'en avait pas", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id);
    const vehicle = (await createResponse.json()).vehicle;
    expect(vehicle.currentOdometer).toBeNull();

    const response = await apiFetch(`/api/vehicles/${vehicle.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ currentOdometer: 12000, currentFuelLevel: 50 }),
    });
    expect(response.status).toBe(200);
    const updated = (await response.json()).vehicle;
    expect(updated.currentOdometer).toBe(12000);
    expect(updated.currentFuelLevel).toBe(50);
  });

  it("refuse un currentOdometer négatif ou un currentFuelLevel hors 0-100 en modification", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id, { currentOdometer: 1000, currentFuelLevel: 50 });
    const vehicle = (await createResponse.json()).vehicle;

    const negative = await apiFetch(`/api/vehicles/${vehicle.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ currentOdometer: -5 }),
    });
    expect(negative.status).toBe(400);

    const outOfRange = await apiFetch(`/api/vehicles/${vehicle.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ currentFuelLevel: 101 }),
    });
    expect(outOfRange.status).toBe(400);
  });

  it("accepte de remettre currentOdometer/currentFuelLevel à null explicitement (champs informatifs, pas techniques)", async () => {
    const createResponse = await createVehicle(adminA, agencyA1Id, { currentOdometer: 1000, currentFuelLevel: 50 });
    const vehicle = (await createResponse.json()).vehicle;

    const response = await apiFetch(`/api/vehicles/${vehicle.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ currentOdometer: null, currentFuelLevel: null }),
    });
    expect(response.status).toBe(200);
    const updated = (await response.json()).vehicle;
    expect(updated.currentOdometer).toBeNull();
    expect(updated.currentFuelLevel).toBeNull();
  });
});

describe("Sprint 24-2 — champs techniques obligatoires côté API (revient sur la décision Sprint 24-1, brief explicite du propriétaire du projet)", () => {
  const VALID_TECHNICAL_FIELDS = {
    chassisNumber: "VF1AB000000000001",
    color: "Bleu",
    doors: 5,
    seats: 5,
    horsepower: 70,
    powerKW: 70,
    engineSize: 1.5,
  };

  describe("POST /api/vehicles — création refusée si un champ obligatoire est absent, null ou vide", () => {
    it.each([
      ["chassisNumber", undefined],
      ["chassisNumber", null],
      ["chassisNumber", ""],
      ["chassisNumber", "   "],
      ["color", undefined],
      ["color", null],
      ["color", ""],
      ["doors", undefined],
      ["doors", null],
      ["seats", undefined],
      ["seats", null],
      ["horsepower", undefined],
      ["horsepower", null],
      ["powerKW", undefined],
      ["powerKW", null],
      ["engineSize", undefined],
      ["engineSize", null],
    ] as const)("refuse la création quand %s = %p", async (field, value) => {
      const response = await createVehicle(adminA, agencyA1Id, { ...VALID_TECHNICAL_FIELDS, [field]: value });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBeTruthy();
    });

    it.each([
      ["doors", 0],
      ["doors", -1],
      ["seats", 0],
      ["horsepower", 0],
      ["powerKW", -5],
      ["engineSize", 0],
      ["engineSize", -1.2],
    ] as const)("refuse une valeur numérique invalide pour %s = %p", async (field, value) => {
      const response = await createVehicle(adminA, agencyA1Id, { ...VALID_TECHNICAL_FIELDS, [field]: value });
      expect(response.status).toBe(400);
    });

    it("crée le véhicule quand les 7 champs sont fournis avec des valeurs valides", async () => {
      const response = await createVehicle(adminA, agencyA1Id, VALID_TECHNICAL_FIELDS);
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.vehicle.chassisNumber).toBe(VALID_TECHNICAL_FIELDS.chassisNumber);
      expect(body.vehicle.color).toBe(VALID_TECHNICAL_FIELDS.color);
      expect(body.vehicle.doors).toBe(VALID_TECHNICAL_FIELDS.doors);
      expect(body.vehicle.seats).toBe(VALID_TECHNICAL_FIELDS.seats);
      expect(body.vehicle.horsepower).toBe(VALID_TECHNICAL_FIELDS.horsepower);
      expect(body.vehicle.powerKW).toBe(VALID_TECHNICAL_FIELDS.powerKW);
      expect(body.vehicle.engineSize).toBe(VALID_TECHNICAL_FIELDS.engineSize);
    });

    it("le prix journalier (pricePerDay) reste facultatif malgré l'obligation des 7 champs techniques", async () => {
      const response = await createVehicle(adminA, agencyA1Id, { ...VALID_TECHNICAL_FIELDS, pricePerDay: undefined });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.vehicle.pricePerDay).toBeNull();
    });
  });

  describe("PATCH /api/vehicles/[id] — modification refusée si un champ obligatoire est supprimé ou invalidé", () => {
    async function createValidVehicle() {
      const createResponse = await createVehicle(adminA, agencyA1Id, VALID_TECHNICAL_FIELDS);
      return (await createResponse.json()).vehicle as { id: string };
    }

    it.each([
      ["chassisNumber", null],
      ["chassisNumber", ""],
      ["chassisNumber", "   "],
      ["color", null],
      ["color", ""],
      ["doors", null],
      ["doors", 0],
      ["doors", -2],
      ["seats", null],
      ["horsepower", null],
      ["horsepower", -1],
      ["powerKW", null],
      ["engineSize", null],
      ["engineSize", 0],
    ] as const)("refuse d'écraser %s avec %p (suppression/invalidation)", async (field, value) => {
      const vehicle = await createValidVehicle();
      const response = await apiFetch(`/api/vehicles/${vehicle.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ [field]: value }),
      });
      expect(response.status).toBe(400);

      // La valeur d'origine, valide, n'a pas été altérée par la tentative refusée.
      const reloaded = await apiFetch(`/api/vehicles/${vehicle.id}`, { headers: { Cookie: adminA.sessionCookie } });
      const reloadedVehicle = (await reloaded.json()).vehicle;
      expect(reloadedVehicle[field]).toBe(VALID_TECHNICAL_FIELDS[field as keyof typeof VALID_TECHNICAL_FIELDS]);
    });

    it("une modification qui omet ces champs (jamais envoyés) laisse leur valeur existante inchangée", async () => {
      const vehicle = await createValidVehicle();

      const response = await apiFetch(`/api/vehicles/${vehicle.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ name: "Renommée" }),
      });
      expect(response.status).toBe(200);
      const updated = (await response.json()).vehicle;
      expect(updated.chassisNumber).toBe(VALID_TECHNICAL_FIELDS.chassisNumber);
      expect(updated.color).toBe(VALID_TECHNICAL_FIELDS.color);
    });

    it("une modification qui fournit une nouvelle valeur valide pour un champ obligatoire met bien à jour le champ", async () => {
      const vehicle = await createValidVehicle();

      const response = await apiFetch(`/api/vehicles/${vehicle.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ chassisNumber: "VF1NEW00000000004", color: "Noir" }),
      });
      expect(response.status).toBe(200);
      const updated = (await response.json()).vehicle;
      expect(updated.chassisNumber).toBe("VF1NEW00000000004");
      expect(updated.color).toBe("Noir");
    });

    it("le prix journalier (pricePerDay) reste modifiable indépendamment des champs techniques obligatoires", async () => {
      const vehicle = await createValidVehicle();

      const response = await apiFetch(`/api/vehicles/${vehicle.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ pricePerDay: null }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).vehicle.pricePerDay).toBeNull();
    });
  });

  describe("permissions et isolation tenant/agence conservées avec la validation stricte", () => {
    it("un MEMBER non rattaché à l'agence est toujours refusé (403) même avec des valeurs valides", async () => {
      const response = await createVehicle(memberA as unknown as AuthenticatedTestUser, agencyA2Id, VALID_TECHNICAL_FIELDS);
      expect(response.status).toBe(403);
    });

    it("une agence d'un autre tenant est toujours refusée (403) même avec des valeurs valides", async () => {
      const response = await createVehicle(adminA, agencyB1Id, VALID_TECHNICAL_FIELDS);
      expect(response.status).toBe(403);
    });

    it("PATCH reste refusé (404) pour un véhicule d'un autre tenant, même avec un corps valide", async () => {
      const otherTenantVehicle = await createVehicle(adminB, agencyB1Id, VALID_TECHNICAL_FIELDS);
      const vehicleId = (await otherTenantVehicle.json()).vehicle.id;

      const response = await apiFetch(`/api/vehicles/${vehicleId}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ color: "Vert" }),
      });
      expect(response.status).toBe(404);
    });
  });
});
