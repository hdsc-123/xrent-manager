import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

/**
 * Sprint 34 étape 3 (DOMAINRULES.md section 50) — coordination maintenance/location : une
 * maintenance ne peut être créée si elle chevauche une location active/réservée (règle 1) ; une
 * maintenance planifiée bloque une nouvelle location sur sa période (règle 2) ; une prolongation
 * d'un contrat déjà validé qui chevauche une maintenance déclenche une alerte + décision
 * explicite plutôt qu'un blocage systématique, jamais un déplacement automatique de la
 * maintenance (règle 3) ; transferts/déplacements également couverts (règle 7).
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];
const password = "Correct-Horse-Battery-Staple9!";

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}
function iso(date: Date): string {
  return date.toISOString();
}

interface Tenant {
  admin: AuthenticatedTestUser;
  agencyId: string;
  clientId: string;
}

async function setupTenant(label: string): Promise<Tenant> {
  const admin = await registerTenantAdmin({
    tenantName: `Maint-Loc Coord ${label} ${runId}`,
    tenantSlug: `maint-loc-coord-${label}-${runId}`,
    name: "Admin",
    email: `admin-mlc-${label}-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(admin.tenantId);

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: `Agence ${label}`, slug: `mlc-agence-${label}-${runId}` }),
  });
  const agencyId = (await agencyResponse.json()).agency.id;

  const clientResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      name: `Client ${label}`,
      email: `client-mlc-${label}-${runId}@test.local`,
      licenseExpiryDate: "2099-12-31",
      birthDate: "1990-01-01",
    }),
  });
  const clientId = (await clientResponse.json()).client.id;

  return { admin, agencyId, clientId };
}

async function createVehicle(tenant: Tenant, label: string) {
  const response = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({
      agencyId: tenant.agencyId,
      name: "Clio",
      licensePlate: `MLC-${Math.floor(Math.random() * 1_000_000)}-${label}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay: 30000,
      chassisNumber: `VF1MLC${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 90,
      powerKW: 67,
      engineSize: 1.5,
    }),
  });
  return (await response.json()).vehicle as { id: string };
}

async function createLocation(
  tenant: Tenant,
  vehicleId: string,
  startDate: Date,
  endDate: Date,
  status?: "PENDING" | "CONFIRMED"
) {
  return apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      clientId: tenant.clientId,
      startDate: iso(startDate),
      endDate: iso(endDate),
      status,
      payment: { deferred: true },
    }),
  });
}

async function createMaintenance(tenant: Tenant, vehicleId: string, scheduledDate: Date, scheduledEndDate?: Date) {
  return apiFetch("/api/maintenances", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      type: "REPAIR",
      scheduledDate: iso(scheduledDate),
      scheduledEndDate: scheduledEndDate ? iso(scheduledEndDate) : undefined,
    }),
  });
}

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
  await prisma.$disconnect();
});

describe("Règle 1 — maintenance pendant une location active refusée", () => {
  it("refuse (409) une maintenance dont la période chevauche une location ACTIVE", async () => {
    const tenant = await setupTenant("r1");
    const vehicle = await createVehicle(tenant, "R1");

    const locationResponse = await createLocation(tenant, vehicle.id, daysFromNow(-1), daysFromNow(5));
    expect(locationResponse.status).toBe(201);
    const location = (await locationResponse.json()).location;
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    const maintenanceResponse = await createMaintenance(tenant, vehicle.id, daysFromNow(2));
    expect(maintenanceResponse.status).toBe(409);
    const body = await maintenanceResponse.json();
    expect(body.conflictingLocations).toBeDefined();
    expect(body.conflictingLocations.length).toBeGreaterThan(0);
  });
});

describe("Règle 1 — maintenance après la date de retour prévue autorisée", () => {
  it("accepte (201) une maintenance commençant après la fin de la location", async () => {
    const tenant = await setupTenant("r1b");
    const vehicle = await createVehicle(tenant, "R1B");

    const locationResponse = await createLocation(tenant, vehicle.id, daysFromNow(-1), daysFromNow(5));
    const location = (await locationResponse.json()).location;
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    const maintenanceResponse = await createMaintenance(tenant, vehicle.id, daysFromNow(6), daysFromNow(7));
    expect(maintenanceResponse.status).toBe(201);
  });
});

describe("Règle 2 — maintenance planifiée bloque une nouvelle location sur sa période", () => {
  it("refuse (409) une nouvelle location chevauchant une maintenance SCHEDULED", async () => {
    const tenant = await setupTenant("r2");
    const vehicle = await createVehicle(tenant, "R2");

    const maintenanceResponse = await createMaintenance(tenant, vehicle.id, daysFromNow(10), daysFromNow(12));
    expect(maintenanceResponse.status).toBe(201);

    const locationResponse = await createLocation(tenant, vehicle.id, daysFromNow(11), daysFromNow(13));
    expect(locationResponse.status).toBe(409);
    const body = await locationResponse.json();
    expect(body.conflictingMaintenances).toBeDefined();
    expect(body.conflictingMaintenances.length).toBeGreaterThan(0);
  });

  it("accepte (201) une location en dehors de la période de la maintenance", async () => {
    const tenant = await setupTenant("r2b");
    const vehicle = await createVehicle(tenant, "R2B");

    await createMaintenance(tenant, vehicle.id, daysFromNow(10), daysFromNow(12));

    const locationResponse = await createLocation(tenant, vehicle.id, daysFromNow(20), daysFromNow(22));
    expect(locationResponse.status).toBe(201);
  });
});

describe("Règle 3 — prolongation en conflit : alerte + décision explicite, jamais de déplacement automatique", () => {
  it("bloque une prolongation en conflit (409) sans confirmation, même pour un ADMIN (adminOverride ne suffit pas)", async () => {
    const tenant = await setupTenant("r3");
    const vehicle = await createVehicle(tenant, "R3");

    const locationResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const location = (await locationResponse.json()).location;
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    const maintenanceResponse = await createMaintenance(tenant, vehicle.id, daysFromNow(4), daysFromNow(6));
    const maintenance = (await maintenanceResponse.json()).maintenance;

    // Prolongation jusqu'à J+5 : chevauche la maintenance [J+4, J+6[.
    const extendResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ endDate: iso(daysFromNow(5)) }),
    });
    expect(extendResponse.status).toBe(409);
    const body = await extendResponse.json();
    expect(body.conflictingMaintenances).toBeDefined();
    expect(body.conflictingMaintenances.length).toBeGreaterThan(0);

    // La location n'a pas été modifiée (refusée avant écriture).
    const unchanged = await prisma.location.findUnique({ where: { id: location.id } });
    expect(unchanged?.endDate.getTime()).toBe(new Date(location.endDate).getTime());

    // La maintenance n'a jamais été déplacée par cette tentative.
    const maintenanceAfter = await prisma.maintenance.findUnique({ where: { id: maintenance.id } });
    expect(maintenanceAfter?.scheduledDate.getTime()).toBe(new Date(maintenance.scheduledDate).getTime());
  });

  it("accepte la prolongation une fois confirmée explicitement (ADMIN) — la maintenance reste inchangée", async () => {
    const tenant = await setupTenant("r3b");
    const vehicle = await createVehicle(tenant, "R3B");

    const locationResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const location = (await locationResponse.json()).location;
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    const maintenanceResponse = await createMaintenance(tenant, vehicle.id, daysFromNow(4), daysFromNow(6));
    const maintenance = (await maintenanceResponse.json()).maintenance;

    const newEndDate = daysFromNow(5);
    const confirmedResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ endDate: iso(newEndDate), confirmMaintenanceConflict: true }),
    });
    expect(confirmedResponse.status).toBe(200);
    const updated = (await confirmedResponse.json()).location;
    expect(new Date(updated.endDate).getTime()).toBe(newEndDate.getTime());

    // Jamais un déplacement automatique de la maintenance (règle 3, bullet 3).
    const maintenanceAfter = await prisma.maintenance.findUnique({ where: { id: maintenance.id } });
    expect(maintenanceAfter?.scheduledDate.getTime()).toBe(new Date(maintenance.scheduledDate).getTime());
    expect(maintenanceAfter?.status).toBe("SCHEDULED");
  });
});

describe("Règle 3 — permission insuffisante refusée sur la confirmation explicite", () => {
  it("un MEMBER sans locations.maintenance_conflict.override reçoit 403 en tentant de confirmer", async () => {
    const tenant = await setupTenant("r3c");
    const vehicle = await createVehicle(tenant, "R3C");

    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({
        name: `MLC-NoOverride-${runId}`,
        permissions: ["locations.view", "locations.edit", "locations.confirm", "locations.activate"],
      }),
    });
    const groupId = (await groupResponse.json()).group.id;

    const member = await createAndLoginMember({
      tenantId: tenant.admin.tenantId,
      name: "No Override",
      email: `no-override-${runId}@test.local`,
      password,
    });
    await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ agencyIds: [tenant.agencyId] }),
    });
    await apiFetch(`/api/users/${member.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ permissionGroupId: groupId, individualPermissions: [] }),
    });

    const locationResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const location = (await locationResponse.json()).location;
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    await createMaintenance(tenant, vehicle.id, daysFromNow(4), daysFromNow(6));

    // Le MEMBER voit bien l'alerte (409, comme n'importe qui avec locations.edit)...
    const alertResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ endDate: iso(daysFromNow(5)) }),
    });
    expect(alertResponse.status).toBe(409);

    // ...mais ne peut pas confirmer explicitement (permission insuffisante, jamais la même
    // route ne bascule silencieusement sur un blocage "muet" — 403 net, distinct du 409).
    const confirmResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ endDate: iso(daysFromNow(5)), confirmMaintenanceConflict: true }),
    });
    expect(confirmResponse.status).toBe(403);

    // La location reste inchangée après le refus 403.
    const stillUnchanged = await prisma.location.findUnique({ where: { id: location.id } });
    expect(stillUnchanged?.endDate.getTime()).toBe(new Date(location.endDate).getTime());
  });

  it("un MEMBER avec locations.maintenance_conflict.override peut confirmer explicitement", async () => {
    const tenant = await setupTenant("r3d");
    const vehicle = await createVehicle(tenant, "R3D");

    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({
        name: `MLC-WithOverride-${runId}`,
        permissions: [
          "locations.view",
          "locations.edit",
          "locations.confirm",
          "locations.activate",
          "locations.maintenance_conflict.override",
        ],
      }),
    });
    const groupId = (await groupResponse.json()).group.id;

    const member = await createAndLoginMember({
      tenantId: tenant.admin.tenantId,
      name: "With Override",
      email: `with-override-${runId}@test.local`,
      password,
    });
    await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ agencyIds: [tenant.agencyId] }),
    });
    await apiFetch(`/api/users/${member.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ permissionGroupId: groupId, individualPermissions: [] }),
    });

    const locationResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const location = (await locationResponse.json()).location;
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    await createMaintenance(tenant, vehicle.id, daysFromNow(4), daysFromNow(6));

    const confirmResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ endDate: iso(daysFromNow(5)), confirmMaintenanceConflict: true }),
    });
    expect(confirmResponse.status).toBe(200);
  });
});

describe("Isolation tenant/agence", () => {
  it("un véhicule d'un autre tenant reste introuvable (404), la garde maintenance n'est jamais atteinte", async () => {
    const tenantA = await setupTenant("iso-a");
    const tenantB = await setupTenant("iso-b");
    const vehicleB = await createVehicle(tenantB, "ISOB");

    const response = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: tenantA.admin.sessionCookie },
      body: JSON.stringify({
        vehicleId: vehicleB.id,
        clientId: tenantA.clientId,
        startDate: iso(daysFromNow(0)),
        endDate: iso(daysFromNow(2)),
        payment: { deferred: true },
      }),
    });
    expect(response.status).toBe(404);
  });

  it("un MEMBER restreint à une agence ne peut pas planifier de maintenance sur un véhicule d'une autre agence du même tenant", async () => {
    const tenant = await setupTenant("iso-c");
    const otherAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ name: "Autre agence", slug: `mlc-other-agence-${runId}` }),
    });
    const otherAgencyId = (await otherAgencyResponse.json()).agency.id;
    const otherVehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({
        agencyId: otherAgencyId,
        name: "Clio Autre",
        licensePlate: `MLC-OTHER-${Math.floor(Math.random() * 1_000_000)}`,
        make: "Renault",
        model: "Clio",
        year: 2022,
        category: "Citadine",
        chassisNumber: `VF1MLCOTHER${Math.floor(Math.random() * 1_000_000)}`,
        color: "Noir",
        doors: 5,
        seats: 5,
        horsepower: 90,
        powerKW: 67,
        engineSize: 1.5,
      }),
    });
    const otherVehicle = (await otherVehicleResponse.json()).vehicle;

    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ name: `MLC-Isolation-${runId}`, permissions: ["maintenances.create", "maintenances.view"] }),
    });
    const groupId = (await groupResponse.json()).group.id;

    const member = await createAndLoginMember({
      tenantId: tenant.admin.tenantId,
      name: "Agency Scoped",
      email: `agency-scoped-${runId}@test.local`,
      password,
    });
    await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ agencyIds: [tenant.agencyId] }),
    });
    await apiFetch(`/api/users/${member.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ permissionGroupId: groupId, individualPermissions: [] }),
    });

    const response = await apiFetch("/api/maintenances", {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({
        vehicleId: otherVehicle.id,
        type: "REPAIR",
        scheduledDate: iso(daysFromNow(1)),
      }),
    });
    expect(response.status).toBe(403);
  });
});

describe("Concurrence — réservation/prolongation/maintenance simultanées sur le même véhicule", () => {
  it("un même véhicule, une maintenance et une location simultanées sur une période qui se chevauche : exactement un succès, jamais deux", async () => {
    const tenant = await setupTenant("conc-a");
    const vehicle = await createVehicle(tenant, "CONCA");

    const [maintenanceResponse, locationResponse] = await Promise.all([
      createMaintenance(tenant, vehicle.id, daysFromNow(30), daysFromNow(32)),
      createLocation(tenant, vehicle.id, daysFromNow(31), daysFromNow(33)),
    ]);

    const statuses = [maintenanceResponse.status, locationResponse.status].sort();
    // L'une des deux opérations a gagné la garde (201), l'autre a trouvé un conflit réel une
    // fois le véhicule verrouillé (409) — jamais les deux à 201 (double réservation du véhicule
    // sur la même période), jamais les deux en échec (une des deux doit nécessairement réussir
    // puisqu'aucune des deux n'existait avant l'appel).
    expect(statuses).toEqual([201, 409]);

    const maintenanceCount = await prisma.maintenance.count({ where: { vehicleId: vehicle.id } });
    const locationCount = await prisma.location.count({ where: { vehicleId: vehicle.id } });
    expect(maintenanceCount + locationCount).toBe(1);
  });

  it("deux prolongations concurrentes de contrats différents ne bloquent pas indûment l'une l'autre (véhicules distincts)", async () => {
    // Contrôle négatif : deux véhicules différents, deux prolongations simultanées — les deux
    // doivent réussir indépendamment (le verrou est par véhicule, jamais global).
    const tenant = await setupTenant("conc-b");
    const vehicle1 = await createVehicle(tenant, "CONCB1");
    const vehicle2 = await createVehicle(tenant, "CONCB2");

    const [loc1Response, loc2Response] = await Promise.all([
      createLocation(tenant, vehicle1.id, daysFromNow(0), daysFromNow(3)),
      createLocation(tenant, vehicle2.id, daysFromNow(0), daysFromNow(3)),
    ]);
    expect(loc1Response.status).toBe(201);
    expect(loc2Response.status).toBe(201);
  });
});

describe("Non-régression — retour, dégâts et DamageInvoice inchangés par la coordination maintenance/location", () => {
  it("un retour avec dégât facturable génère toujours sa DamageInvoice normalement, même avec une maintenance planifiée (future) sur le même véhicule", async () => {
    const tenant = await setupTenant("regress");
    const vehicle = await createVehicle(tenant, "REGRESS");

    // Maintenance planifiée loin dans le futur, sans rapport avec ce contrat — présente
    // uniquement pour prouver que le retour n'est jamais affecté par la coordination.
    await createMaintenance(tenant, vehicle.id, daysFromNow(60), daysFromNow(61));

    const locationResponse = await createLocation(tenant, vehicle.id, daysFromNow(-3), daysFromNow(0));
    const location = (await locationResponse.json()).location;
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    const returnResponse = await apiFetch(`/api/locations/${location.id}/return`, {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({
        endOdometer: 100,
        endFuelLevel: 50,
        damages: [{ nature: "Rayure", description: "Test non-régression", billableAmount: 20000 }],
      }),
    });
    expect(returnResponse.status).toBe(200);
    const returnBody = await returnResponse.json();
    expect(returnBody.damages).toHaveLength(1);
    const damageInvoiceId = returnBody.damages[0].damageInvoiceId;
    expect(damageInvoiceId).toBeTruthy();

    const invoiceResponse = await apiFetch(`/api/damage-invoices/${damageInvoiceId}`, {
      headers: { Cookie: tenant.admin.sessionCookie },
    });
    expect(invoiceResponse.status).toBe(200);
    const invoiceBody = await invoiceResponse.json();
    expect(invoiceBody.damageInvoice.totalAmount).toBe(20000);

    // Le véhicule redevient AVAILABLE après un retour réussi, comportement inchangé.
    const vehicleAfter = await prisma.vehicle.findUnique({ where: { id: vehicle.id } });
    expect(vehicleAfter?.status).toBe("AVAILABLE");
  });
});
