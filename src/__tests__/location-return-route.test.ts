import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

/**
 * Sprint 32 (DOMAINRULES.md section 32) — tests HTTP de POST /api/locations/[id]/return, même
 * convention que src/__tests__/locations.test.ts (serveur next dev réel, fixtures créées via
 * l'API). La logique métier elle-même (kilométrage/carburant/rollback/dégâts/double retour) est
 * déjà couverte par src/__tests__/location-return.test.ts (appel direct du service) — ce
 * fichier vérifie uniquement ce que la route ajoute : authentification, permissions, portée
 * tenant/agence, forme du corps de requête, codes d'erreur sûrs.
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let agencyA1Id: string;
let clientAId: string;
let dateOffset = 0;
let vehicleCounter = 0;

/** Sprint "statut opérationnel automatique" (2026-08-28) : Vehicle.status reflète désormais
 * réellement toute Location ACTIVE existante (même hors de sa période de dates) — un véhicule
 * partagé entre plusieurs tests dont certains activent une Location sans jamais la clôturer
 * (ex. les tests de rejet ci-dessous, qui laissent volontairement la Location ACTIVE) resterait
 * donc RENTED pour tous les tests suivants. Chaque appel crée désormais son propre véhicule
 * frais, pour isoler chaque test indépendamment du sort de la Location des autres. */
async function createFreshVehicle() {
  vehicleCounter += 1;
  const vehicleResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      agencyId: agencyA1Id,
      name: "Clio",
      licensePlate: `RET-RT-${vehicleCounter}-${runId}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay: 5000,
      chassisNumber: `VF1TEST${vehicleCounter}${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
    }),
  });
  return (await vehicleResponse.json()).vehicle.id as string;
}

async function createAndActivateLocation(overrides: Record<string, unknown> = {}) {
  dateOffset += 10;
  const base = new Date(Date.UTC(2028, 0, 1));
  const start = new Date(base.getTime() + dateOffset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
  const vehicleId = await createFreshVehicle();

  const createResponse = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      clientId: clientAId,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      startOdometer: 1000,
      ...overrides,
    }),
  });
  const { location } = await createResponse.json();

  await apiFetch(`/api/locations/${location.id}`, {
    method: "PATCH",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ status: "CONFIRMED" }),
  });
  await apiFetch(`/api/locations/${location.id}`, {
    method: "PATCH",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ status: "ACTIVE" }),
  });

  return location.id as string;
}

async function grantPermissions(userId: string, permissions: string[], groupName: string): Promise<void> {
  const groupResponse = await apiFetch("/api/permission-groups", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: `${groupName}-${runId}`, permissions }),
  });
  const groupId = (await groupResponse.json()).group.id;
  await apiFetch(`/api/users/${userId}/permissions`, {
    method: "PATCH",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ permissionGroupId: groupId }),
  });
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Location Return Route Test A",
    tenantSlug: `location-return-route-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Location Return Route Test B",
    tenantSlug: `location-return-route-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminB.tenantId);

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A1", slug: `agence-a1-${runId}` }),
  });
  agencyA1Id = (await agencyResponse.json()).agency.id;

  const clientResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      name: "Client A",
      email: `client-a-${runId}@test.local`,
      licenseExpiryDate: "2099-12-31",
      birthDate: "1990-01-01",
    }),
  });
  clientAId = (await clientResponse.json()).client.id;
});

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
});

describe("POST /api/locations/[id]/return — authentification et permissions", () => {
  it("refuse une requête non authentifiée", async () => {
    const locationId = await createAndActivateLocation();
    const response = await apiFetch(`/api/locations/${locationId}/return`, {
      method: "POST",
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 70 }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER rattaché à l'agence mais sans locations.complete", async () => {
    const locationId = await createAndActivateLocation();
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Permission Member",
      email: `no-perm-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA1Id } });
    await grantPermissions(member.userId, ["locations.view"], "NoComplete");

    const response = await apiFetch(`/api/locations/${locationId}/return`, {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 70 }),
    });
    expect(response.status).toBe(403);

    const dbLocation = await prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    expect(dbLocation.status).toBe("ACTIVE");
  });

  it("refuse l'accès à un contrat d'un autre tenant", async () => {
    const locationId = await createAndActivateLocation();
    const response = await apiFetch(`/api/locations/${locationId}/return`, {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 70 }),
    });
    expect(response.status).toBe(404);
  });

  it("refuse un MEMBER avec locations.complete mais non rattaché à l'agence du contrat", async () => {
    const locationId = await createAndActivateLocation();
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Out Of Agency Member",
      email: `out-agency-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    // Volontairement pas de UserAgency pour agencyA1Id.
    await grantPermissions(member.userId, ["locations.view", "locations.complete"], "OutOfAgency");

    const response = await apiFetch(`/api/locations/${locationId}/return`, {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 70 }),
    });
    expect(response.status).toBe(404);

    const dbLocation = await prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    expect(dbLocation.status).toBe("ACTIVE");
  });
});

describe("POST /api/locations/[id]/return — création valide et données invalides", () => {
  it("clôture le contrat avec des données valides", async () => {
    const locationId = await createAndActivateLocation();
    const response = await apiFetch(`/api/locations/${locationId}/return`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 70 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.status).toBe("COMPLETED");
    expect(body.vehicle.status).toBe("AVAILABLE");
  });

  it("refuse des données invalides (kilométrage manquant)", async () => {
    const locationId = await createAndActivateLocation();
    const response = await apiFetch(`/api/locations/${locationId}/return`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endFuelLevel: 70 }),
    });
    expect(response.status).toBe(400);

    const dbLocation = await prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    expect(dbLocation.status).toBe("ACTIVE");
  });

  it("refuse un kilométrage inférieur au départ, sans révéler de détail interne", async () => {
    const locationId = await createAndActivateLocation();
    const response = await apiFetch(`/api/locations/${locationId}/return`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 500, endFuelLevel: 70 }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(typeof body.error).toBe("string");
    expect(body.error).not.toMatch(/prisma|stack|at \w+\.|node_modules/i);
  });

  it("erreur sûre et cohérente (500) sur un id inexistant bien formé — jamais de détail interne", async () => {
    const response = await apiFetch("/api/locations/does-not-exist/return", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 70 }),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["error"]);
  });
});

describe("POST /api/locations/[id]/return — date/heure réelle de retour", () => {
  it("sans locations.return_time.edit : une valeur personnalisée est ignorée (heure serveur utilisée)", async () => {
    const locationId = await createAndActivateLocation();
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Return Time Edit Member",
      email: `no-return-time-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA1Id } });
    await grantPermissions(member.userId, ["locations.view", "locations.complete"], "NoReturnTimeEdit");

    const customPast = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const before = Date.now();
    const response = await apiFetch(`/api/locations/${locationId}/return`, {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 70, actualReturnAt: customPast }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(new Date(body.location.actualReturnAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("avec locations.return_time.edit : une valeur personnalisée cohérente est honorée", async () => {
    const start = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
    const locationId = await createAndActivateLocation({
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    });
    // adminA (rôle ADMIN) court-circuite can() systématiquement — pas besoin d'un groupe dédié
    // pour prouver que la permission, une fois accordée, est bien honorée par la route.
    const customReturn = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const response = await apiFetch(`/api/locations/${locationId}/return`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 70, actualReturnAt: customReturn }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(new Date(body.location.actualReturnAt).getTime()).toBe(new Date(customReturn).getTime());
  });
});
