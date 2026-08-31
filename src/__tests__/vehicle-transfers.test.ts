import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";
// Sprint 31B — Scénario F (rollback) : appelée directement (hors route HTTP) pour provoquer une
// erreur après le verrouillage du véhicule via un responsibleUserId inexistant, impossible à
// obtenir via POST /api/vehicle-transfers qui valide déjà responsibleUserId avant d'appeler cette
// fonction (voir src/app/api/vehicle-transfers/route.ts).
import { createVehicleTransfer } from "@/lib/vehicle-transfers";

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
  await deleteTestTenants(createdTenantIds);
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

  it("Sprint 19 : autorise un MEMBER à lancer un transfert vers une agence d'arrivée à laquelle il n'est pas rattaché (bug réel corrigé)", async () => {
    // memberA n'est rattaché qu'à agencyA1Id (voir beforeAll) — pas agencyA2Id.
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const response = await createTransfer(memberA, vehicleId, agencyA2Id, memberA.userId);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.transfer.fromAgencyId).toBe(agencyA1Id);
    expect(body.transfer.toAgencyId).toBe(agencyA2Id);
  });

  it("Sprint 19 : refuse toujours une agence d'arrivée d'un autre tenant", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const response = await createTransfer(adminA, vehicleId, agencyB1Id, adminA.userId);
    expect(response.status).toBe(404);
  });
});

/**
 * Sprint 31B (DOMAINRULES.md section 46) : avant ce sprint, la création d'un transfert/
 * déplacement relisait le véhicule dans la transaction via un simple `tx.vehicle.findUnique`,
 * sans verrou de ligne — sous l'isolation READ COMMITTED de PostgreSQL, deux créations
 * concurrentes sur le même véhicule pouvaient toutes deux lire AVAILABLE avant que l'une des
 * deux n'écrive. Correctif : `lockVehicleForUpdate` (SELECT ... FOR UPDATE) posé en tout début
 * de transaction (voir createVehicleTransfer, src/lib/vehicle-transfers.ts). Les tests
 * ci-dessous répètent chaque scénario concurrent plusieurs fois : le résultat attendu (un seul
 * 201, un seul 409, un seul mouvement actif en base) est garanti par le verrou de ligne
 * PostgreSQL lui-même, jamais par un minutage particulier des deux requêtes — déterministe par
 * construction, pas par chance.
 */
describe("Sprint 31B — verrouillage du véhicule à la création (courses concurrentes)", () => {
  const CONCURRENCY_REPEATS = 5;

  /** Sprint "statut opérationnel automatique" (2026-08-28) : PATCH /api/vehicles/[id] rejette
   * désormais tout `status` fourni par le client (plus jamais assignable manuellement, même via
   * l'API) — statut forcé directement en base pour isoler ces tests du reste de
   * l'infrastructure Location/Maintenance/Transfert/Déplacement, même convention que
   * locations.test.ts (createVehicleWithStatus). */
  async function setVehicleStatus(admin: AuthenticatedTestUser, vehicleId: string, status: string) {
    void admin;
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: status as never } });
  }

  it("Scénario A : deux transferts concurrents sur le même véhicule — exactement un 201 et un 409, un seul transfert actif en base, un seul audit", async () => {
    for (let attempt = 0; attempt < CONCURRENCY_REPEATS; attempt++) {
      const vehicleResponse = await createVehicle(adminA, agencyA1Id);
      const vehicleId = (await vehicleResponse.json()).vehicle.id;

      const auditCountBefore = await prisma.auditLog.count({
        where: { tenantId: adminA.tenantId, action: "vehicle_transfer.created" },
      });

      const [r1, r2] = await Promise.all([
        createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId),
        createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId),
      ]);

      const statuses = [r1.status, r2.status];
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(1);

      // Le message exact du perdant (conflit de concurrence vs refus métier générique, voir
      // VehicleReservationConflictError) dépend de l'entrelacement réel des deux requêtes HTTP —
      // non garanti par Promise.all seul (constaté : reproductible à 100% en isolation avant que
      // la route ne soit compilée par Next dev, ~1/53 même une fois chaude). Seules les propriétés
      // ci-dessous sont garanties par le verrou de ligne PostgreSQL, indépendamment du minutage —
      // ce sont elles qui font foi pour la sécurité de concurrence, pas le libellé exact du 409.
      const loserResponse = r1.status === 409 ? r1 : r2;
      const loserBody = await loserResponse.json();
      expect(typeof loserBody.error).toBe("string");
      expect(loserBody.error.length).toBeGreaterThan(0);

      const activeTransfers = await prisma.vehicleTransfer.count({ where: { vehicleId, status: "IN_TRANSIT" } });
      expect(activeTransfers).toBe(1);

      const vehicleCheck = await apiFetch(`/api/vehicles/${vehicleId}`, { headers: { Cookie: adminA.sessionCookie } });
      const vehicleBody = await vehicleCheck.json();
      expect(vehicleBody.vehicle.status).toBe("TRANSFERRING");

      const auditCountAfter = await prisma.auditLog.count({
        where: { tenantId: adminA.tenantId, action: "vehicle_transfer.created" },
      });
      expect(auditCountAfter - auditCountBefore).toBe(1);
    }
  });

  it("Scénario C : un transfert et un déplacement concurrents sur le même véhicule — exactement une réussite et un conflit, un seul mouvement actif, statut véhicule cohérent avec le gagnant", async () => {
    for (let attempt = 0; attempt < CONCURRENCY_REPEATS; attempt++) {
      const vehicleResponse = await createVehicle(adminA, agencyA1Id);
      const vehicleId = (await vehicleResponse.json()).vehicle.id;

      const [transferResponse, tripResponse] = await Promise.all([
        createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId),
        apiFetch("/api/vehicle-trips", {
          method: "POST",
          headers: { Cookie: adminA.sessionCookie },
          body: JSON.stringify({
            vehicleId,
            employeeUserId: adminA.userId,
            reason: "Course test concurrence",
            destination: "Aéroport",
            startOdometer: 100,
          }),
        }),
      ]);

      const statuses = [transferResponse.status, tripResponse.status];
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(1);

      const activeTransfers = await prisma.vehicleTransfer.count({ where: { vehicleId, status: "IN_TRANSIT" } });
      const activeTrips = await prisma.vehicleTrip.count({ where: { vehicleId, status: "IN_PROGRESS" } });
      expect(activeTransfers + activeTrips).toBe(1);

      const vehicleCheck = await apiFetch(`/api/vehicles/${vehicleId}`, { headers: { Cookie: adminA.sessionCookie } });
      const vehicleBody = await vehicleCheck.json();

      // Voir le commentaire du Scénario A ci-dessus : le libellé exact du 409 perdant n'est pas
      // garanti par Promise.all seul, seules les propriétés ci-dessous le sont (verrou de ligne).
      if (transferResponse.status === 201) {
        expect(activeTransfers).toBe(1);
        expect(activeTrips).toBe(0);
        expect(vehicleBody.vehicle.status).toBe("TRANSFERRING");
        const tripError = await tripResponse.json();
        expect(typeof tripError.error).toBe("string");
        expect(tripError.error.length).toBeGreaterThan(0);
      } else {
        expect(activeTrips).toBe(1);
        expect(activeTransfers).toBe(0);
        expect(vehicleBody.vehicle.status).toBe("ON_TRIP");
        const transferError = await transferResponse.json();
        expect(typeof transferError.error).toBe("string");
        expect(transferError.error.length).toBeGreaterThan(0);
      }
    }
  });

  it("Scénario D : refuse un transfert sur un véhicule RENTED (refus métier, jamais un conflit de concurrence)", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;
    await setVehicleStatus(adminA, vehicleId, "RENTED");

    const response = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).not.toContain("déjà été réservé par un autre utilisateur");
  });

  it("Scénario D : refuse un transfert sur un véhicule MAINTENANCE (refus métier)", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;
    await setVehicleStatus(adminA, vehicleId, "MAINTENANCE");

    const response = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).not.toContain("déjà été réservé par un autre utilisateur");
  });

  it("Scénario D : refuse un transfert sur un véhicule désactivé (refus métier)", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;
    await prisma.vehicle.update({
      where: { id: vehicleId },
      data: { deactivatedAt: new Date(), deactivatedReason: "Test", deactivatedById: adminA.userId },
    });

    const response = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).not.toContain("déjà été réservé par un autre utilisateur");
  });

  it("Scénario F : une erreur après le verrouillage du véhicule (FK responsibleUserId inexistant) déclenche un rollback complet — aucune donnée résiduelle", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const alertCountBefore = await prisma.alert.count({ where: { tenantId: adminA.tenantId } });
    const auditCountBefore = await prisma.auditLog.count({
      where: { tenantId: adminA.tenantId, action: "vehicle_transfer.created" },
    });

    // Appel direct de la fonction lib (pas de la route) : la route valide déjà responsibleUserId
    // avant d'appeler createVehicleTransfer, il faut donc la contourner pour provoquer l'échec
    // (violation de contrainte de clé étrangère P2003) exactement après le verrouillage du
    // véhicule et la vérification de son statut, mais avant toute écriture définitive.
    await expect(
      createVehicleTransfer({
        tenantId: adminA.tenantId,
        vehicleId,
        toAgencyId: agencyA2Id,
        responsibleUserId: "nonexistent-responsible-user-id",
      })
    ).rejects.toThrow();

    const transferCount = await prisma.vehicleTransfer.count({ where: { vehicleId } });
    expect(transferCount).toBe(0);

    const alertCountAfter = await prisma.alert.count({ where: { tenantId: adminA.tenantId } });
    expect(alertCountAfter).toBe(alertCountBefore);

    const auditCountAfter = await prisma.auditLog.count({
      where: { tenantId: adminA.tenantId, action: "vehicle_transfer.created" },
    });
    expect(auditCountAfter).toBe(auditCountBefore);

    const vehicleCheck = await apiFetch(`/api/vehicles/${vehicleId}`, { headers: { Cookie: adminA.sessionCookie } });
    const vehicleBody = await vehicleCheck.json();
    expect(vehicleBody.vehicle.status).toBe("AVAILABLE");
    expect(vehicleBody.vehicle.agencyId).toBe(agencyA1Id);
  });
});

// Sprint 30 (point 6b, Sprint A) : vehicleId déjà supporté par GET /api/vehicle-transfers
// (getVehicleTransfers, src/lib/vehicle-transfers.ts) mais jusqu'ici jamais exposé dans l'UI
// (VehicleTransfersTable.tsx) — le formulaire de filtre ajouté ce sprint réutilise ce paramètre
// tel quel, sans changement d'API.
describe("GET /api/vehicle-transfers — filtre vehicleId (Sprint 30, point 6b Sprint A)", () => {
  it("filtre par véhicule, combinable avec le filtre status existant", async () => {
    const vehicleAResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleAId = (await vehicleAResponse.json()).vehicle.id;
    const vehicleCResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleCId = (await vehicleCResponse.json()).vehicle.id;

    const transferA = await createTransfer(adminA, vehicleAId, agencyA2Id, adminA.userId);
    const transferAId = (await transferA.json()).transfer.id;
    await createTransfer(adminA, vehicleCId, agencyA2Id, adminA.userId);

    const filteredResponse = await apiFetch(`/api/vehicle-transfers?vehicleId=${vehicleAId}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const filteredBody = await filteredResponse.json();
    expect(filteredBody.transfers.every((transfer: { vehicleId: string }) => transfer.vehicleId === vehicleAId)).toBe(
      true
    );
    expect(filteredBody.transfers.map((transfer: { id: string }) => transfer.id)).toContain(transferAId);

    const combinedResponse = await apiFetch(
      `/api/vehicle-transfers?vehicleId=${vehicleAId}&status=IN_TRANSIT`,
      { headers: { Cookie: adminA.sessionCookie } }
    );
    const combinedBody = await combinedResponse.json();
    expect(combinedBody.transfers.map((transfer: { id: string }) => transfer.id)).toContain(transferAId);

    const combinedNoMatchResponse = await apiFetch(
      `/api/vehicle-transfers?vehicleId=${vehicleAId}&status=CANCELLED`,
      { headers: { Cookie: adminA.sessionCookie } }
    );
    const combinedNoMatchBody = await combinedNoMatchResponse.json();
    expect(combinedNoMatchBody.transfers.map((transfer: { id: string }) => transfer.id)).not.toContain(transferAId);
  });
});

describe("Sprint 19 — GET /api/vehicles/[id]/last-known-state", () => {
  it("retourne null/null pour un véhicule sans historique de retour", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const response = await apiFetch(`/api/vehicles/${vehicleId}/last-known-state`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.odometer).toBeNull();
    expect(body.fuelLevel).toBeNull();
  });

  it("reprend le kilométrage/carburant du dernier transfert validé", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId, {
      startOdometer: 1000,
    });
    const transferId = (await createResponse.json()).transfer.id;

    await apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      // Sprint 24 : endOdometer/endFuelLevel/arrivalDriverName désormais obligatoires à la
      // réception d'un transfert (voir PATCH .../validate).
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 75, arrivalDriverName: "Chauffeur Test" }),
    });

    const response = await apiFetch(`/api/vehicles/${vehicleId}/last-known-state`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const body = await response.json();
    expect(body.odometer).toBe(1200);
    expect(body.fuelLevel).toBe(75);
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
      // Sprint 24 : voir le commentaire équivalent ci-dessus.
      body: JSON.stringify({ endOdometer: 5200, endFuelLevel: 60, arrivalDriverName: "Chauffeur Test" }),
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
      // Sprint 24 : endFuelLevel/arrivalDriverName fournis pour isoler spécifiquement le rejet
      // sur l'incohérence de kilométrage (400), pas sur un champ obligatoire manquant.
      body: JSON.stringify({ endOdometer: 7000, endFuelLevel: 50, arrivalDriverName: "Chauffeur Test" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse de revalider un transfert déjà COMPLETED", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId);
    const transferId = (await createResponse.json()).transfer.id;

    // Sprint 24 : champs obligatoires à la réception (voir PATCH .../validate) — fournis ici
    // pour que la première validation aboutisse réellement (COMPLETED), condition nécessaire
    // pour exercer le rejet d'une revalidation (409) testé ci-dessous.
    const arrivalBody = { endOdometer: 100, endFuelLevel: 50, arrivalDriverName: "Chauffeur Test" };
    await apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(arrivalBody),
    });

    const response = await apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(arrivalBody),
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

  it("Sprint 22 : deux validations/annulations concurrentes sur le même transfert — une seule réussit (409 pour l'autre)", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId);
    const transferId = (await createResponse.json()).transfer.id;

    const [validateResponse, cancelResponse] = await Promise.all([
      apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        // Sprint 24 : champs obligatoires à la réception, voir le commentaire ci-dessus.
        body: JSON.stringify({ endOdometer: 100, endFuelLevel: 50, arrivalDriverName: "Chauffeur Test" }),
      }),
      apiFetch(`/api/vehicle-transfers/${transferId}/cancel`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
      }),
    ]);

    const statuses = [validateResponse.status, cancelResponse.status].sort();
    // L'un des deux réussit (200), l'autre échoue (409) — jamais les deux à 200 (ce qui
    // trahirait la race condition documentée depuis le Sprint 17, corrigée ce sprint via
    // updateMany conditionné sur status: "IN_TRANSIT").
    expect(statuses).toEqual([200, 409]);

    const finalCheck = await apiFetch(`/api/vehicle-transfers/${transferId}`, { headers: { Cookie: adminA.sessionCookie } });
    const finalTransfer = (await finalCheck.json()).transfer;
    expect(["COMPLETED", "CANCELLED"]).toContain(finalTransfer.status);
  });

  it("Sprint 22 : enregistre le nom du chauffeur à l'arrivée", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId);
    const transferId = (await createResponse.json()).transfer.id;

    const response = await apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      // Sprint 24 : endOdometer/endFuelLevel désormais obligatoires en plus d'arrivalDriverName.
      body: JSON.stringify({ endOdometer: 100, endFuelLevel: 50, arrivalDriverName: "Karim Chauffeur" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.transfer.arrivalDriverName).toBe("Karim Chauffeur");
  });
});

describe("Sprint 22 — alerte à l'agence d'arrivée au lancement d'un transfert", () => {
  it("crée une alerte VEHICLE_TRANSFER_INCOMING scopée à l'agence d'arrivée", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId);
    const transfer = (await createResponse.json()).transfer;

    const alertsResponse = await apiFetch(`/api/alerts?type=VEHICLE_TRANSFER_INCOMING`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(alertsResponse.status).toBe(200);
    const { alerts } = await alertsResponse.json();
    const alert = alerts.find((a: { entityId: string }) => a.entityId === transfer.id);
    expect(alert).toBeDefined();
    expect(alert.agencyId).toBe(agencyA2Id);
    expect(alert.status).toBe("PENDING");
  });
});

describe("Sprint 15 — permissions granulaires (vehicle_transfers.create)", () => {
  it("refuse un MEMBER rattaché à l'agence de départ mais dont le groupe personnalisé n'a pas vehicle_transfers.create", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoTransferCreate-${runId}`, permissions: ["vehicle_transfers.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Member",
      email: `restricted-transfers-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: restrictedMember.userId, agencyId: agencyA1Id } });
    await prisma.userAgency.create({ data: { userId: restrictedMember.userId, agencyId: agencyA2Id } });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const response = await createTransfer(restrictedMember, vehicleId, agencyA2Id, restrictedMember.userId);
    expect(response.status).toBe(403);
  });

  it("autorise un MEMBER dont le groupe personnalisé accorde vehicle_transfers.create", async () => {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const grantedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: `WithTransferCreate-${runId}`,
        permissions: ["vehicle_transfers.view", "vehicle_transfers.create"],
      }),
    });
    const grantedGroupId = (await grantedGroupResponse.json()).group.id;

    const grantedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Granted Member",
      email: `granted-transfers-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: grantedMember.userId, agencyId: agencyA1Id } });
    await prisma.userAgency.create({ data: { userId: grantedMember.userId, agencyId: agencyA2Id } });
    await apiFetch(`/api/users/${grantedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: grantedGroupId }),
    });

    const response = await createTransfer(grantedMember, vehicleId, agencyA2Id, grantedMember.userId);
    expect(response.status).toBe(201);
  });

  it("un ADMIN lance un transfert même rattaché à un groupe personnalisé vide (bypass systématique)", async () => {
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
      const response = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId);
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

describe("Sprint 24 — kilométrage/carburant/chauffeur d'arrivée obligatoires à la réception", () => {
  async function createInTransitTransfer() {
    const vehicleResponse = await createVehicle(adminA, agencyA1Id);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;
    const createResponse = await createTransfer(adminA, vehicleId, agencyA2Id, adminA.userId, {
      startOdometer: 1000,
    });
    const transferId = (await createResponse.json()).transfer.id;
    return { vehicleId, transferId };
  }

  it("refuse la réception sans endOdometer", async () => {
    const { transferId } = await createInTransitTransfer();
    const response = await apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endFuelLevel: 50, arrivalDriverName: "Chauffeur Test" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse la réception sans endFuelLevel", async () => {
    const { transferId } = await createInTransitTransfer();
    const response = await apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 1200, arrivalDriverName: "Chauffeur Test" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse la réception sans arrivalDriverName", async () => {
    const { transferId } = await createInTransitTransfer();
    const response = await apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 50 }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse un arrivalDriverName vide/blanc", async () => {
    const { transferId } = await createInTransitTransfer();
    const response = await apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 50, arrivalDriverName: "   " }),
    });
    expect(response.status).toBe(400);
  });

  it("accepte la réception avec les trois champs fournis et cohérents (endOdometer ≥ startOdometer)", async () => {
    const { transferId } = await createInTransitTransfer();
    const response = await apiFetch(`/api/vehicle-transfers/${transferId}/validate`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 50, arrivalDriverName: "Chauffeur Test" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.transfer.status).toBe("COMPLETED");
    expect(body.transfer.arrivalDriverName).toBe("Chauffeur Test");
  });
});
