import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";
// Sprint 31B — Scénario F (rollback) : appelée directement (hors route HTTP) pour provoquer une
// erreur après le verrouillage du véhicule via un employeeUserId inexistant, impossible à obtenir
// via POST /api/vehicle-trips qui valide déjà employeeUserId avant d'appeler cette fonction (voir
// src/app/api/vehicle-trips/route.ts).
import { createVehicleTrip } from "@/lib/vehicle-trips";

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

/**
 * Sprint 31B (DOMAINRULES.md section 46) : même correctif que côté transfert
 * (vehicle-transfers.test.ts) — `lockVehicleForUpdate` (SELECT ... FOR UPDATE) posé en tout
 * début de transaction dans createVehicleTrip (src/lib/vehicle-trips.ts). Le scénario croisé
 * transfert/déplacement (Scénario C) est déjà couvert par vehicle-transfers.test.ts (nécessite
 * les deux modules) ; les tests ci-dessous couvrent la partie propre à VehicleTrip. Répétés
 * plusieurs fois : le résultat (un seul 201, un seul 409, un seul déplacement actif) est garanti
 * par le verrou de ligne PostgreSQL, jamais par un minutage particulier des deux requêtes.
 */
describe("Sprint 31B — verrouillage du véhicule à la création (courses concurrentes)", () => {
  const CONCURRENCY_REPEATS = 5;

  /** Sprint "statut opérationnel automatique" (2026-08-28) : PATCH /api/vehicles/[id] rejette
   * désormais tout `status` fourni par le client (plus jamais assignable manuellement, même via
   * l'API) — statut forcé directement en base pour isoler ces tests, même convention que
   * locations.test.ts (createVehicleWithStatus). */
  async function setVehicleStatus(admin: AuthenticatedTestUser, vehicleId: string, status: string) {
    void admin;
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: status as never } });
  }

  it("Scénario B : deux déplacements concurrents sur le même véhicule — exactement un 201 et un 409, un seul déplacement actif en base, un seul audit", async () => {
    for (let attempt = 0; attempt < CONCURRENCY_REPEATS; attempt++) {
      const vehicleResponse = await createVehicle(adminA, agencyA1Id);
      const vehicleId = (await vehicleResponse.json()).vehicle.id;

      const auditCountBefore = await prisma.auditLog.count({
        where: { tenantId: adminA.tenantId, action: "vehicle_trip.created" },
      });

      const [r1, r2] = await Promise.all([
        createTrip(adminA, vehicleId, adminA.userId),
        createTrip(adminA, vehicleId, adminA.userId),
      ]);

      const statuses = [r1.status, r2.status];
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(1);

      // Le message exact du perdant (conflit de concurrence vs refus métier générique, voir
      // VehicleReservationConflictError, src/lib/vehicle-trips.ts) dépend de l'entrelacement réel
      // des deux requêtes HTTP — non garanti par Promise.all seul (constaté : reproductible à
      // 100% en isolation avant que la route ne soit compilée par Next dev, ~1/53 même chaude).
      // Seules les propriétés ci-dessous sont garanties par le verrou de ligne PostgreSQL,
      // indépendamment du minutage — ce sont elles qui font foi pour la sécurité de concurrence.
      const loserResponse = r1.status === 409 ? r1 : r2;
      const loserBody = await loserResponse.json();
      expect(typeof loserBody.error).toBe("string");
      expect(loserBody.error.length).toBeGreaterThan(0);

      const activeTrips = await prisma.vehicleTrip.count({ where: { vehicleId, status: "IN_PROGRESS" } });
      expect(activeTrips).toBe(1);

      const vehicleCheck = await apiFetch(`/api/vehicles/${vehicleId}`, { headers: { Cookie: adminA.sessionCookie } });
      const vehicleBody = await vehicleCheck.json();
      expect(vehicleBody.vehicle.status).toBe("ON_TRIP");

      const auditCountAfter = await prisma.auditLog.count({
        where: { tenantId: adminA.tenantId, action: "vehicle_trip.created" },
      });
      expect(auditCountAfter - auditCountBefore).toBe(1);
    }
  });

  it("Scénario D : refuse un déplacement sur un véhicule RENTED (refus métier, jamais un conflit de concurrence)", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;
    await setVehicleStatus(adminA, vehicleId, "RENTED");

    const response = await createTrip(adminA, vehicleId, adminA.userId);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).not.toContain("déjà été réservé par un autre utilisateur");
  });

  it("Scénario D : refuse un déplacement sur un véhicule MAINTENANCE (refus métier)", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;
    await setVehicleStatus(adminA, vehicleId, "MAINTENANCE");

    const response = await createTrip(adminA, vehicleId, adminA.userId);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).not.toContain("déjà été réservé par un autre utilisateur");
  });

  it("Scénario D : refuse un déplacement sur un véhicule désactivé (refus métier)", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;
    await prisma.vehicle.update({
      where: { id: vehicleId },
      data: { deactivatedAt: new Date(), deactivatedReason: "Test", deactivatedById: adminA.userId },
    });

    const response = await createTrip(adminA, vehicleId, adminA.userId);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).not.toContain("déjà été réservé par un autre utilisateur");
  });

  it("Scénario F : une erreur après le verrouillage du véhicule (FK employeeUserId inexistant) déclenche un rollback complet — aucune donnée résiduelle", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const auditCountBefore = await prisma.auditLog.count({
      where: { tenantId: adminA.tenantId, action: "vehicle_trip.created" },
    });

    // Appel direct de la fonction lib (pas de la route) : la route valide déjà employeeUserId
    // avant d'appeler createVehicleTrip, il faut donc la contourner pour provoquer l'échec
    // (violation de contrainte de clé étrangère P2003) exactement après le verrouillage du
    // véhicule et la vérification de son statut, mais avant toute écriture définitive.
    await expect(
      createVehicleTrip({
        tenantId: adminA.tenantId,
        vehicleId,
        employeeUserId: "nonexistent-employee-user-id",
        reason: "Course test rollback",
        destination: "Aéroport",
        startOdometer: 100,
      })
    ).rejects.toThrow();

    const tripCount = await prisma.vehicleTrip.count({ where: { vehicleId } });
    expect(tripCount).toBe(0);

    const auditCountAfter = await prisma.auditLog.count({
      where: { tenantId: adminA.tenantId, action: "vehicle_trip.created" },
    });
    expect(auditCountAfter).toBe(auditCountBefore);

    const vehicleCheck = await apiFetch(`/api/vehicles/${vehicleId}`, { headers: { Cookie: adminA.sessionCookie } });
    const vehicleBody = await vehicleCheck.json();
    expect(vehicleBody.vehicle.status).toBe("AVAILABLE");
  });
});

// Sprint 30 (point 6b, Sprint A) : vehicleId déjà supporté par GET /api/vehicle-trips
// (getVehicleTrips, src/lib/vehicle-trips.ts) mais jusqu'ici jamais exposé dans l'UI
// (VehicleTripsTable.tsx) — le formulaire de filtre ajouté ce sprint réutilise ce paramètre
// tel quel, sans changement d'API.
describe("GET /api/vehicle-trips — filtre vehicleId (Sprint 30, point 6b Sprint A)", () => {
  it("filtre par véhicule, combinable avec le filtre status existant", async () => {
    const vehicleAResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleAId = (await vehicleAResponse.json()).vehicle.id;
    const vehicleCResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleCId = (await vehicleCResponse.json()).vehicle.id;

    const tripA = await createTrip(adminA, vehicleAId, adminA.userId);
    const tripAId = (await tripA.json()).trip.id;
    await createTrip(adminA, vehicleCId, adminA.userId);

    const filteredResponse = await apiFetch(`/api/vehicle-trips?vehicleId=${vehicleAId}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const filteredBody = await filteredResponse.json();
    expect(filteredBody.trips.every((trip: { vehicleId: string }) => trip.vehicleId === vehicleAId)).toBe(true);
    expect(filteredBody.trips.map((trip: { id: string }) => trip.id)).toContain(tripAId);

    const combinedResponse = await apiFetch(`/api/vehicle-trips?vehicleId=${vehicleAId}&status=IN_PROGRESS`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const combinedBody = await combinedResponse.json();
    expect(combinedBody.trips.map((trip: { id: string }) => trip.id)).toContain(tripAId);

    const combinedNoMatchResponse = await apiFetch(`/api/vehicle-trips?vehicleId=${vehicleAId}&status=CANCELLED`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const combinedNoMatchBody = await combinedNoMatchResponse.json();
    expect(combinedNoMatchBody.trips.map((trip: { id: string }) => trip.id)).not.toContain(tripAId);
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
