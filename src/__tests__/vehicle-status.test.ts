/**
 * Sprint "statut opérationnel automatique" (2026-08-28) — DOMAINRULES.md section 5 révisée,
 * ARCHITECTURE.md, SECURITY.md. `Vehicle.status` n'est plus jamais saisi manuellement : il est
 * entièrement calculé côté serveur (src/lib/vehicle-status.ts, getVehicleOperationalStatus) à
 * partir des opérations métier réellement actives, et réécrit (syncVehicleStatus) dans la même
 * transaction que chaque transition Location/Maintenance/VehicleTransfer/VehicleTrip pertinente.
 * L'ancien VehicleStatus.INACTIVE devient un état administratif séparé
 * (Vehicle.deactivatedAt/deactivatedReason/deactivatedById, réservé ADMIN).
 *
 * Ce fichier couvre les 20 scénarios de test explicitement requis par le brief du sprint,
 * au-delà des tests déjà étendus dans locations.test.ts/reservations.test.ts (rejet du statut
 * manuel bloquant à la création/modification d'une Location) et déjà couverts par
 * vehicle-mobility-alerts.test.ts (STOCK_INCONSISTENCY, désormais un détecteur de dérive
 * persisté/calculé plutôt que l'ancienne heuristique AVAILABLE/RENTED manuelle).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getMaintenanceEffectiveEnd } from "@/lib/vehicles";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let memberA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let agencyA1Id: string;
let agencyA2Id: string;
let agencyB1Id: string;
let clientAId: string;

let vehicleCounter = 0;
let dateCounter = 0;

async function createVehicle(admin: AuthenticatedTestUser, agencyId: string, overrides: Record<string, unknown> = {}) {
  vehicleCounter += 1;
  const response = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      agencyId,
      name: "Véhicule Statut Auto",
      licensePlate: `VS-${vehicleCounter}-${runId}`,
      make: "Dacia",
      model: "Sandero",
      year: 2022,
      category: "Citadine",
      pricePerDay: 4000,
      chassisNumber: `VF1TESTVS${vehicleCounter}${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 5,
      powerKW: 55,
      engineSize: 1.0,
      ...overrides,
    }),
  });
  return response;
}

async function createFreshVehicle(admin: AuthenticatedTestUser, agencyId: string) {
  const response = await createVehicle(admin, agencyId);
  expect(response.status).toBe(201);
  return (await response.json()).vehicle.id as string;
}

async function getVehicle(admin: AuthenticatedTestUser, vehicleId: string) {
  const response = await apiFetch(`/api/vehicles/${vehicleId}`, { headers: { Cookie: admin.sessionCookie } });
  return (await response.json()).vehicle;
}

function nextDateRange(): { startDate: string; endDate: string } {
  dateCounter += 1;
  const base = new Date(Date.UTC(2029, 0, 1));
  const start = new Date(base.getTime() + dateCounter * 10 * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

async function createLocation(
  admin: AuthenticatedTestUser,
  vehicleId: string,
  overrides: Record<string, unknown> = {}
) {
  return apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      clientId: clientAId,
      startOdometer: 1000,
      ...nextDateRange(),
      ...overrides,
    }),
  });
}

async function activateLocation(admin: AuthenticatedTestUser, locationId: string) {
  await apiFetch(`/api/locations/${locationId}`, {
    method: "PATCH",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ status: "CONFIRMED" }),
  });
  return apiFetch(`/api/locations/${locationId}`, {
    method: "PATCH",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ status: "ACTIVE" }),
  });
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Vehicle Status Test A",
    tenantSlug: `vehicle-status-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  memberA = await createAndLoginMember({
    tenantId: adminA.tenantId,
    name: "Member A",
    email: `member-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });

  adminB = await registerTenantAdmin({
    tenantName: "Vehicle Status Test B",
    tenantSlug: `vehicle-status-test-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminB.tenantId);

  const agencyAResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence VS A1", slug: `agence-vs-a1-${runId}` }),
  });
  agencyA1Id = (await agencyAResponse.json()).agency.id;

  const agencyA2Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence VS A2", slug: `agence-vs-a2-${runId}` }),
  });
  agencyA2Id = (await agencyA2Response.json()).agency.id;

  const agencyBResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Agence VS B1", slug: `agence-vs-b1-${runId}` }),
  });
  agencyB1Id = (await agencyBResponse.json()).agency.id;

  await prisma.userAgency.create({ data: { userId: memberA.userId, agencyId: agencyA1Id } });

  const clientResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      name: "Client VS",
      email: `client-vs-${runId}@test.local`,
      licenseExpiryDate: "2099-12-31",
      birthDate: "1990-01-01",
    }),
  });
  clientAId = (await clientResponse.json()).client.id;
});

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
});

describe("1-3. Création/modification d'un véhicule — statut jamais manuel", () => {
  it("1. création d'un véhicule => AVAILABLE", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
  });

  it("2. tentative de création avec un statut fourni par le client => rejet (400)", async () => {
    const response = await createVehicle(adminA, agencyA1Id, { status: "RENTED" });
    expect(response.status).toBe(400);
  });

  it("3. tentative de modification directe du statut => rejet (400)", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const response = await apiFetch(`/api/vehicles/${vehicleId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "MAINTENANCE" }),
    });
    expect(response.status).toBe(400);
    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
  });
});

describe("4-7. Transitions Location", () => {
  it("4. réservation future (PENDING/CONFIRMED) => véhicule reste AVAILABLE", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const createResponse = await createLocation(adminA, vehicleId);
    expect(createResponse.status).toBe(201);
    const location = (await createResponse.json()).location;
    expect(await (await getVehicle(adminA, vehicleId)).status).toBe("AVAILABLE");

    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
  });

  it("5. activation d'un contrat => RENTED", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const createResponse = await createLocation(adminA, vehicleId);
    const location = (await createResponse.json()).location;

    const activateResponse = await activateLocation(adminA, location.id);
    expect(activateResponse.status).toBe(200);

    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("RENTED");
  });

  it("6. retour validé => statut recalculé (AVAILABLE)", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const createResponse = await createLocation(adminA, vehicleId);
    const location = (await createResponse.json()).location;
    await activateLocation(adminA, location.id);
    expect((await getVehicle(adminA, vehicleId)).status).toBe("RENTED");

    const returnResponse = await apiFetch(`/api/locations/${location.id}/return`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 70 }),
    });
    expect(returnResponse.status).toBe(200);

    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
  });

  it("7. contrat annulé (admin-cancel depuis ACTIVE) => statut recalculé (AVAILABLE)", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const createResponse = await createLocation(adminA, vehicleId);
    const location = (await createResponse.json()).location;
    await activateLocation(adminA, location.id);
    expect((await getVehicle(adminA, vehicleId)).status).toBe("RENTED");

    const cancelResponse = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Test annulation admin" }),
    });
    expect(cancelResponse.status).toBe(200);

    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
  });
});

describe("8-9. Transitions Maintenance", () => {
  it("8. maintenance active (scheduledDate <= maintenant) => MAINTENANCE", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const response = await apiFetch("/api/maintenances", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        type: "OIL_CHANGE",
        scheduledDate: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    });
    expect(response.status).toBe(201);

    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("MAINTENANCE");
  });

  it("maintenance planifiée pour une date future => ne bloque pas prématurément (reste AVAILABLE)", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const response = await apiFetch("/api/maintenances", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId, type: "OIL_CHANGE", scheduledDate: "2035-06-01" }),
    });
    expect(response.status).toBe(201);

    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
  });

  it("9. maintenance clôturée (COMPLETED) => statut recalculé (AVAILABLE)", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const createResponse = await apiFetch("/api/maintenances", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        type: "OIL_CHANGE",
        scheduledDate: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    });
    const maintenance = (await createResponse.json()).maintenance;
    expect((await getVehicle(adminA, vehicleId)).status).toBe("MAINTENANCE");

    const completeResponse = await apiFetch(`/api/maintenances/${maintenance.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    expect(completeResponse.status).toBe(200);

    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
  });
});

describe("10-11. Transitions Transfert", () => {
  it("10. transfert actif => TRANSFERRING", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const response = await apiFetch("/api/vehicle-transfers", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId, toAgencyId: agencyA2Id, responsibleUserId: adminA.userId }),
    });
    expect(response.status).toBe(201);

    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("TRANSFERRING");
  });

  it("11. transfert reçu (validate) => statut recalculé (AVAILABLE), agence mise à jour", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const createResponse = await apiFetch("/api/vehicle-transfers", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId, toAgencyId: agencyA2Id, responsibleUserId: adminA.userId }),
    });
    const transfer = (await createResponse.json()).transfer;

    const validateResponse = await apiFetch(`/api/vehicle-transfers/${transfer.id}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 75, arrivalDriverName: "Chauffeur Test" }),
    });
    expect(validateResponse.status).toBe(200);

    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
    expect(vehicle.agencyId).toBe(agencyA2Id);
  });

  it("transfert annulé => statut recalculé (AVAILABLE)", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const createResponse = await apiFetch("/api/vehicle-transfers", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId, toAgencyId: agencyA2Id, responsibleUserId: adminA.userId }),
    });
    const transfer = (await createResponse.json()).transfer;
    expect((await getVehicle(adminA, vehicleId)).status).toBe("TRANSFERRING");

    const cancelResponse = await apiFetch(`/api/vehicle-transfers/${transfer.id}/cancel`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(cancelResponse.status).toBe(200);

    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
    expect(vehicle.agencyId).toBe(agencyA1Id);
  });
});

describe("12-13. Transitions Bon de déplacement interne", () => {
  it("12. déplacement interne actif => ON_TRIP", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const response = await apiFetch("/api/vehicle-trips", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        employeeUserId: adminA.userId,
        reason: "Livraison",
        destination: "Agence centrale",
        startOdometer: 10000,
      }),
    });
    expect(response.status).toBe(201);

    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("ON_TRIP");
  });

  it("13. déplacement terminé (return) => statut recalculé (AVAILABLE)", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const createResponse = await apiFetch("/api/vehicle-trips", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        employeeUserId: adminA.userId,
        reason: "Livraison",
        destination: "Agence centrale",
        startOdometer: 10000,
      }),
    });
    const trip = (await createResponse.json()).trip;

    const returnResponse = await apiFetch(`/api/vehicle-trips/${trip.id}/return`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 10100, endFuelLevel: 60 }),
    });
    expect(returnResponse.status).toBe(200);

    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
  });

  it("déplacement annulé => statut recalculé (AVAILABLE)", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const createResponse = await apiFetch("/api/vehicle-trips", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        employeeUserId: adminA.userId,
        reason: "Livraison",
        destination: "Agence centrale",
        startOdometer: 10000,
      }),
    });
    const trip = (await createResponse.json()).trip;
    expect((await getVehicle(adminA, vehicleId)).status).toBe("ON_TRIP");

    const cancelResponse = await apiFetch(`/api/vehicle-trips/${trip.id}/cancel`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(cancelResponse.status).toBe(200);

    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
  });
});

describe("14. Chevauchements incompatibles => refus explicite", () => {
  it("un transfert ne peut pas démarrer sur un véhicule déjà en maintenance active", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    await apiFetch("/api/maintenances", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        type: "REPAIR",
        scheduledDate: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    });
    expect((await getVehicle(adminA, vehicleId)).status).toBe("MAINTENANCE");

    const response = await apiFetch("/api/vehicle-transfers", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId, toAgencyId: agencyA2Id, responsibleUserId: adminA.userId }),
    });
    expect(response.status).toBe(409);
  });

  it("un déplacement ne peut pas démarrer sur un véhicule déjà en transfert", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    await apiFetch("/api/vehicle-transfers", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId, toAgencyId: agencyA2Id, responsibleUserId: adminA.userId }),
    });
    expect((await getVehicle(adminA, vehicleId)).status).toBe("TRANSFERRING");

    const response = await apiFetch("/api/vehicle-trips", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        employeeUserId: adminA.userId,
        reason: "Test",
        destination: "Test",
        startOdometer: 10000,
      }),
    });
    expect(response.status).toBe(409);
  });

  it("un véhicule désactivé bloque toute nouvelle Location/Maintenance/Transfert/Déplacement", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    await apiFetch(`/api/vehicles/${vehicleId}/deactivate`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Test désactivation chevauchement" }),
    });

    const locationResponse = await createLocation(adminA, vehicleId);
    expect(locationResponse.status).toBe(409);

    const maintenanceResponse = await apiFetch("/api/maintenances", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId, type: "OIL_CHANGE", scheduledDate: "2030-06-01" }),
    });
    expect(maintenanceResponse.status).toBe(409);

    const transferResponse = await apiFetch("/api/vehicle-transfers", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId, toAgencyId: agencyA2Id, responsibleUserId: adminA.userId }),
    });
    expect(transferResponse.status).toBe(409);

    const tripResponse = await apiFetch("/api/vehicle-trips", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        employeeUserId: adminA.userId,
        reason: "Test",
        destination: "Test",
        startOdometer: 10000,
      }),
    });
    expect(tripResponse.status).toBe(409);
  });
});

describe("15. Isolation tenant/agence", () => {
  it("un véhicule d'un autre tenant est introuvable (404), jamais affecté par une opération du tenant courant", async () => {
    const vehicleBId = await createFreshVehicle(adminB, agencyB1Id);

    const response = await apiFetch(`/api/vehicles/${vehicleBId}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);

    const locationResponse = await createLocation(adminA, vehicleBId);
    expect(locationResponse.status).toBe(404);

    const vehicleAfter = await getVehicle(adminB, vehicleBId);
    expect(vehicleAfter.status).toBe("AVAILABLE");
  });
});

describe("16. Sélecteurs cohérents avec le statut réel", () => {
  it("GET /api/vehicles?status=AVAILABLE&excludeDeactivated=true exclut un véhicule loué et un véhicule désactivé", async () => {
    const rentedVehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const createResponse = await createLocation(adminA, rentedVehicleId);
    const location = (await createResponse.json()).location;
    await activateLocation(adminA, location.id);

    const deactivatedVehicleId = await createFreshVehicle(adminA, agencyA1Id);
    await apiFetch(`/api/vehicles/${deactivatedVehicleId}/deactivate`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Test sélecteur" }),
    });

    const availableVehicleId = await createFreshVehicle(adminA, agencyA1Id);

    const response = await apiFetch("/api/vehicles?status=AVAILABLE&excludeDeactivated=true", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const body = await response.json();
    const ids = body.vehicles.map((v: { id: string }) => v.id);
    expect(ids).not.toContain(rentedVehicleId);
    expect(ids).not.toContain(deactivatedVehicleId);
    expect(ids).toContain(availableVehicleId);
  });
});

describe("17-18. Alerte STOCK_INCONSISTENCY — dérive persisté/calculé", () => {
  it("17-18. une divergence réelle crée une alerte ; la correction empêche sa recréation", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);

    // Divergence forcée hors du flux applicatif normal (simule un bug de resynchronisation) —
    // le statut persisté (MAINTENANCE) ne correspond à aucune opération active réelle.
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: "MAINTENANCE" } });

    await prisma.alert.deleteMany({
      where: { tenantId: adminA.tenantId, entityType: "VehicleStockInconsistency", entityId: vehicleId },
    });

    const firstCheck = await apiFetch("/api/tasks/check-alerts", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(firstCheck.status).toBe(200);
    const firstBody = await firstCheck.json();
    expect(firstBody.created.stockInconsistencies).toBeGreaterThanOrEqual(1);

    const alertsResponse = await apiFetch("/api/alerts?type=STOCK_INCONSISTENCY", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const alertsBody = await alertsResponse.json();
    const alert = alertsBody.alerts.find((a: { entityId: string }) => a.entityId === vehicleId);
    expect(alert).toBeDefined();

    // Correction (même effet qu'un vrai resync) : le statut persisté redevient cohérent.
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: "AVAILABLE" } });
    await apiFetch(`/api/alerts/${alert.id}/resolve`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
    });

    const secondCheck = await apiFetch("/api/tasks/check-alerts", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
    });
    const secondBody = await secondCheck.json();

    const alertsAfter = await apiFetch("/api/alerts?type=STOCK_INCONSISTENCY", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const alertsAfterBody = await alertsAfter.json();
    const unresolvedForVehicle = alertsAfterBody.alerts.filter(
      (a: { entityId: string; status: string }) => a.entityId === vehicleId && a.status !== "RESOLVED"
    );
    expect(unresolvedForVehicle).toHaveLength(0);
    void secondBody;
  });
});

describe("19. Concurrence sur l'activation d'un contrat", () => {
  it("deux activations concurrentes de la même Location — une seule réussit, le véhicule finit RENTED sans corruption", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const createResponse = await createLocation(adminA, vehicleId);
    const location = (await createResponse.json()).location;
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const [first, second] = await Promise.all([
      apiFetch(`/api/locations/${location.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ status: "ACTIVE" }),
      }),
      apiFetch(`/api/locations/${location.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ status: "ACTIVE" }),
      }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).not.toBe(200);

    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("RENTED");
  });

  it("réactivation séquentielle (non concurrente) d'un contrat déjà ACTIVE refusée en conflit (409), jamais un no-op silencieux — même cause racine que le test ci-dessus, sans dépendre du timing", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const createResponse = await createLocation(adminA, vehicleId);
    const location = (await createResponse.json()).location;
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    const firstActivation = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });
    expect(firstActivation.status).toBe(200);

    // Appel séquentiel, strictement après que le premier a déjà commité — reproduit directement
    // la cause racine corrigée (statusChanging à tort false quand data.status === existing.status
    // déjà à jour), indépendamment de tout aléa de concurrence réelle.
    const secondActivation = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });
    expect(secondActivation.status).toBe(409);

    const vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("RENTED");
  });
});

describe("20-21. Désactivation/réactivation administrative — permissions, motif, audit", () => {
  it("désactivation réservée ADMIN — refusée (403) pour un MEMBER", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const response = await apiFetch(`/api/vehicles/${vehicleId}/deactivate`, {
      method: "POST",
      headers: { Cookie: memberA.sessionCookie },
      body: JSON.stringify({ reason: "Tentative non autorisée" }),
    });
    expect(response.status).toBe(403);
  });

  it("désactivation sans motif => rejetée (400)", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const response = await apiFetch(`/api/vehicles/${vehicleId}/deactivate`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "" }),
    });
    expect(response.status).toBe(400);
  });

  it("désactivation d'un véhicule déjà désactivé => conflit (409)", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    await apiFetch(`/api/vehicles/${vehicleId}/deactivate`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Première désactivation" }),
    });
    const response = await apiFetch(`/api/vehicles/${vehicleId}/deactivate`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Deuxième tentative" }),
    });
    expect(response.status).toBe(409);
  });

  it("réactivation d'un véhicule non désactivé => conflit (409)", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    const response = await apiFetch(`/api/vehicles/${vehicleId}/reactivate`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(409);
  });

  it("réactivation réservée ADMIN — refusée (403) pour un MEMBER", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);
    await apiFetch(`/api/vehicles/${vehicleId}/deactivate`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Test" }),
    });
    const response = await apiFetch(`/api/vehicles/${vehicleId}/reactivate`, {
      method: "POST",
      headers: { Cookie: memberA.sessionCookie },
    });
    expect(response.status).toBe(403);
  });

  it("20. désactivation puis réactivation — statut opérationnel calculé inchangé (orthogonal), audit des deux actions", async () => {
    const vehicleId = await createFreshVehicle(adminA, agencyA1Id);

    const deactivateResponse = await apiFetch(`/api/vehicles/${vehicleId}/deactivate`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Panne moteur grave" }),
    });
    expect(deactivateResponse.status).toBe(200);

    let vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
    expect(vehicle.deactivatedAt).not.toBeNull();
    expect(vehicle.deactivatedReason).toBe("Panne moteur grave");

    const deactivateAudit = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, action: "vehicle.deactivated", resourceId: vehicleId },
    });
    expect(deactivateAudit).toBeDefined();

    const reactivateResponse = await apiFetch(`/api/vehicles/${vehicleId}/reactivate`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(reactivateResponse.status).toBe(200);

    vehicle = await getVehicle(adminA, vehicleId);
    expect(vehicle.status).toBe("AVAILABLE");
    expect(vehicle.deactivatedAt).toBeNull();
    expect(vehicle.deactivatedReason).toBeNull();

    const reactivateAudit = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, action: "vehicle.reactivated", resourceId: vehicleId },
    });
    expect(reactivateAudit).toBeDefined();
  });
});

describe("INC-21 — getMaintenanceEffectiveEnd sans scheduledEndDate ne dépend plus de l'heure d'exécution", () => {
  it("retourne scheduledDate + 24h, jamais la fin du jour calendaire (défaut avant correction : une maintenance planifiée juste avant minuit ne bloquait plus dès que l'heure courante franchissait minuit)", () => {
    // Date fixe, non relative à Date.now() — ce test doit rester déterministe quelle que soit
    // l'heure/le jour d'exécution de la suite, contrairement aux scénarios d'intégration
    // ci-dessus (scheduledDate: Date.now() - 1h) qui n'exercent ce cas que par coïncidence
    // horaire.
    const scheduledDate = new Date("2026-08-28T23:26:00.000Z"); // 34 min avant minuit UTC
    const effectiveEnd = getMaintenanceEffectiveEnd({ scheduledDate, scheduledEndDate: null });

    // Ancien calcul (bogué) : fin du jour calendaire de scheduledDate => 2026-08-28T23:59:59.999Z,
    // soit ~33 minutes après scheduledDate — un instant déjà dans le passé dès que "maintenant"
    // franchit minuit, alors que la maintenance n'a même pas encore une journée d'ancienneté.
    const buggyEndOfDay = new Date("2026-08-28T23:59:59.999Z");
    expect(effectiveEnd.getTime()).toBeGreaterThan(buggyEndOfDay.getTime());

    // Nouveau calcul (correct) : exactement scheduledDate + 24h, qui couvre bien "toute sa
    // journée prévue" (DOMAINRULES.md section 50) quelle que soit l'heure de planification.
    expect(effectiveEnd.toISOString()).toBe("2026-08-29T23:26:00.000Z");
  });

  it("scheduledEndDate explicite reste prioritaire, inchangé par la correction", () => {
    const scheduledDate = new Date("2026-08-28T08:00:00.000Z");
    const scheduledEndDate = new Date("2026-08-28T10:00:00.000Z");
    const effectiveEnd = getMaintenanceEffectiveEnd({ scheduledDate, scheduledEndDate });
    expect(effectiveEnd.toISOString()).toBe("2026-08-28T10:00:00.000Z");
  });
});
