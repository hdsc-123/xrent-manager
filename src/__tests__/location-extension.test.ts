import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

/**
 * Sprint 13E tâche 2 (DOMAINRULES.md section 52) — « Prolonger la location » : interface et
 * garde-fous serveur dédiés (`extendReturnDate`, PATCH /api/locations/[id]) construits sur le
 * parcours maintenance déjà validé au Sprint 34 étape 3 (voir maintenance-location-coordination.
 * test.ts, non dupliqué ici) — ce fichier couvre spécifiquement : la validation stricte de la
 * nouvelle date de retour, le recalcul de prix, la resynchronisation de la facture DRAFT (et la
 * non-modification d'une facture déjà verrouillée), le nouveau contournement de verrou dédié
 * (`extendReturnDate`, indépendant de `locations.maintenance_conflict.override`), l'isolation
 * tenant/agence, l'audit/historique, le numéro de contrat conservé, et la concurrence.
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];
const password = "Correct-Horse-Battery-Staple9!";
const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}
function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
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
    tenantName: `Loc Ext ${label} ${runId}`,
    tenantSlug: `loc-ext-${label}-${runId}`,
    name: "Admin",
    email: `admin-le-${label}-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(admin.tenantId);

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: `Agence ${label}`, slug: `le-agence-${label}-${runId}` }),
  });
  const agencyId = (await agencyResponse.json()).agency.id;

  const clientResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      name: `Client ${label}`,
      email: `client-le-${label}-${runId}@test.local`,
      licenseExpiryDate: "2099-12-31",
      birthDate: "1990-01-01",
    }),
  });
  const clientId = (await clientResponse.json()).client.id;

  return { admin, agencyId, clientId };
}

async function createVehicle(tenant: Tenant, label: string, pricePerDay = 30000) {
  const response = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({
      agencyId: tenant.agencyId,
      name: "Clio",
      licensePlate: `LE-${Math.floor(Math.random() * 1_000_000)}-${label}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay,
      chassisNumber: `VF1LE${Math.floor(Math.random() * 1_000_000)}`,
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
  payment: Record<string, unknown> = { deferred: true }
) {
  return apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      clientId: tenant.clientId,
      startDate: iso(startDate),
      endDate: iso(endDate),
      payment,
    }),
  });
}

async function activateLocation(tenant: Tenant, locationId: string, actor: AuthenticatedTestUser = tenant.admin) {
  await apiFetch(`/api/locations/${locationId}`, {
    method: "PATCH",
    headers: { Cookie: actor.sessionCookie },
    body: JSON.stringify({ status: "CONFIRMED" }),
  });
  return apiFetch(`/api/locations/${locationId}`, {
    method: "PATCH",
    headers: { Cookie: actor.sessionCookie },
    body: JSON.stringify({ status: "ACTIVE" }),
  });
}

async function createMaintenance(tenant: Tenant, vehicleId: string, scheduledDate: Date, scheduledEndDate: Date) {
  return apiFetch("/api/maintenances", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      type: "REPAIR",
      scheduledDate: iso(scheduledDate),
      scheduledEndDate: iso(scheduledEndDate),
    }),
  });
}

/** Membre restreint à `tenant.agencyId`, avec exactement les permissions demandées. */
async function createScopedMember(
  tenant: Tenant,
  label: string,
  permissions: string[],
  agencyId: string = tenant.agencyId
) {
  const groupResponse = await apiFetch("/api/permission-groups", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ name: `LE-${label}-${runId}`, permissions }),
  });
  const groupId = (await groupResponse.json()).group.id;

  const member = await createAndLoginMember({
    tenantId: tenant.admin.tenantId,
    name: label,
    email: `le-${label}-${runId}@test.local`,
    password,
  });
  await apiFetch(`/api/users/${member.userId}`, {
    method: "PATCH",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ agencyIds: [agencyId] }),
  });
  await apiFetch(`/api/users/${member.userId}/permissions`, {
    method: "PATCH",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ permissionGroupId: groupId, individualPermissions: [] }),
  });
  return member;
}

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashEntry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashRegister.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.payment.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.damageInvoiceLine.deleteMany({ where: { damageInvoice: { tenantId: { in: createdTenantIds } } } });
  await prisma.damage.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.damageInvoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.reservation.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.maintenance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("Prolongation valide — recalcul de prix, numéro de contrat conservé, audit", () => {
  it("prolonge une location ACTIVE avec une nouvelle date de retour strictement postérieure (200)", async () => {
    const tenant = await setupTenant("valid");
    const vehicle = await createVehicle(tenant, "VALID");

    const createResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const created = (await createResponse.json()).location as {
      id: string;
      contractNumber: string | null;
      startDate: string;
      endDate: string;
      totalPrice: number;
    };
    await activateLocation(tenant, created.id);

    const newEnd = addDays(new Date(created.endDate), 2);
    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(newEnd) }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(new Date(body.location.endDate).getTime()).toBe(newEnd.getTime());
    expect(body.location.contractNumber).toBe(created.contractNumber);
    expect(body.location.startDate).toBe(created.startDate);

    const expectedDays = Math.ceil((newEnd.getTime() - new Date(created.startDate).getTime()) / DAY_MS);
    expect(body.location.totalPrice).toBe(30000 * expectedDays);
    expect(Number.isInteger(body.location.totalPrice)).toBe(true);
    expect(body.location.totalPrice).toBeGreaterThan(created.totalPrice);

    // Audit — action dédiée, historique avant/après conservé.
    const auditResponse = await apiFetch(`/api/audit?resource=Location&action=location.extended`, {
      headers: { Cookie: tenant.admin.sessionCookie },
    });
    const logs = (await auditResponse.json()).logs as {
      resourceId: string;
      metadata: { previousEndDate: string; previousTotalPrice: number; changes: { endDate: string } };
    }[];
    const entry = logs.find((log) => log.resourceId === created.id);
    expect(entry).toBeDefined();
    expect(new Date(entry!.metadata.previousEndDate).getTime()).toBe(new Date(created.endDate).getTime());
    expect(entry!.metadata.previousTotalPrice).toBe(created.totalPrice);
    expect(new Date(entry!.metadata.changes.endDate).getTime()).toBe(newEnd.getTime());
  });
});

describe("Prolongation — dates invalides refusées (400), aucune modification enregistrée", () => {
  async function setupActiveLocation(label: string) {
    const tenant = await setupTenant(label);
    const vehicle = await createVehicle(tenant, label.toUpperCase());
    const createResponse = await createLocation(
      tenant,
      vehicle.id,
      new Date("2030-06-01T08:00:00.000Z"),
      new Date("2030-06-04T10:00:00.000Z")
    );
    const created = (await createResponse.json()).location as { id: string; endDate: string };
    await activateLocation(tenant, created.id);
    return { tenant, created };
  }

  async function attemptExtend(tenant: Tenant, locationId: string, endDate: string) {
    return apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate }),
    });
  }

  it("date antérieure refusée", async () => {
    const { tenant, created } = await setupActiveLocation("baddate");
    const response = await attemptExtend(tenant, created.id, "2030-06-03T10:00:00.000Z");
    expect(response.status).toBe(400);
    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: created.id } });
    expect(unchanged.endDate.toISOString()).toBe(created.endDate);
  });

  it("date égale refusée", async () => {
    const { tenant, created } = await setupActiveLocation("eqdate");
    const response = await attemptExtend(tenant, created.id, created.endDate);
    expect(response.status).toBe(400);
    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: created.id } });
    expect(unchanged.endDate.toISOString()).toBe(created.endDate);
  });

  it("heure antérieure refusée (même jour)", async () => {
    const { tenant, created } = await setupActiveLocation("badtime");
    const response = await attemptExtend(tenant, created.id, "2030-06-04T09:00:00.000Z");
    expect(response.status).toBe(400);
    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: created.id } });
    expect(unchanged.endDate.toISOString()).toBe(created.endDate);
  });

  it("heure égale refusée (même instant exact)", async () => {
    const { tenant, created } = await setupActiveLocation("eqtime");
    const response = await attemptExtend(tenant, created.id, "2030-06-04T10:00:00.000Z");
    expect(response.status).toBe(400);
    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: created.id } });
    expect(unchanged.endDate.toISOString()).toBe(created.endDate);
  });

  it("date invalide (chaîne non-ISO) refusée", async () => {
    const { tenant, created } = await setupActiveLocation("invaliddate");
    const response = await attemptExtend(tenant, created.id, "pas-une-date");
    expect(response.status).toBe(400);
    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: created.id } });
    expect(unchanged.endDate.toISOString()).toBe(created.endDate);
  });

  it("startDate fourni avec extendReturnDate refusé (une prolongation ne déplace jamais le départ)", async () => {
    const { tenant, created } = await setupActiveLocation("withstart");
    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, startDate: "2030-06-01", endDate: "2030-06-10" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("Prolongation — resynchronisation de la facture", () => {
  it("une facture DRAFT est resynchronisée avec le nouveau totalPrice (solde recalculé)", async () => {
    const tenant = await setupTenant("draftinv");
    const vehicle = await createVehicle(tenant, "DRAFTINV");
    const createResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3), { deferred: true });
    const createdBody = await createResponse.json();
    const created = createdBody.location as { id: string; endDate: string };
    const invoiceBefore = createdBody.invoice as { id: string; status: string; totalAmount: number };
    expect(invoiceBefore.status).toBe("DRAFT");
    await activateLocation(tenant, created.id);

    const newEnd = addDays(new Date(created.endDate), 3);
    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(newEnd) }),
    });
    expect(response.status).toBe(200);
    const { location } = await response.json();

    const invoiceAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceBefore.id } });
    expect(invoiceAfter.status).toBe("DRAFT");
    expect(invoiceAfter.subtotal).toBe(location.totalPrice);
    expect(invoiceAfter.totalAmount).toBe(location.totalPrice);
    expect(invoiceAfter.amountPaid).toBe(0);
    expect(invoiceAfter.totalAmount).toBeGreaterThan(invoiceBefore.totalAmount);
  });

  it("une facture déjà PAID (verrouillée) n'est jamais modifiée par une prolongation", async () => {
    const tenant = await setupTenant("paidinv");
    const vehicle = await createVehicle(tenant, "PAIDINV");
    const createResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3), {
      method: "CASH",
      partial: false,
    });
    const createdBody = await createResponse.json();
    const created = createdBody.location as { id: string; endDate: string; totalPrice: number };
    const invoiceBefore = createdBody.invoice as { id: string; status: string; totalAmount: number; subtotal: number };
    expect(invoiceBefore.status).toBe("PAID");
    await activateLocation(tenant, created.id);

    const newEnd = addDays(new Date(created.endDate), 3);
    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(newEnd) }),
    });
    expect(response.status).toBe(200);
    const { location } = await response.json();
    expect(location.totalPrice).toBeGreaterThan(created.totalPrice);

    // La facture déjà verrouillée (PAID) reste inchangée à l'identique — limite documentée
    // (DOMAINRULES.md section 52), jamais un montant PAID silencieusement désynchronisé du
    // nouveau totalPrice ni corrompu.
    const invoiceAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceBefore.id } });
    expect(invoiceAfter.status).toBe("PAID");
    expect(invoiceAfter.subtotal).toBe(invoiceBefore.subtotal);
    expect(invoiceAfter.totalAmount).toBe(invoiceBefore.totalAmount);
    expect(invoiceAfter.amountPaid).toBe(invoiceBefore.totalAmount);
  });
});

describe("Prolongation — permission dédiée : extendReturnDate contourne le verrou sans exiger locations.maintenance_conflict.override", () => {
  it("un MEMBER avec seulement locations.edit peut prolonger sans conflit (200)", async () => {
    const tenant = await setupTenant("editonly");
    const vehicle = await createVehicle(tenant, "EDITONLY");
    const createResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const created = (await createResponse.json()).location as { id: string; endDate: string };
    await activateLocation(tenant, created.id);

    const member = await createScopedMember(tenant, "editonly", [
      "locations.view",
      "locations.edit",
      "locations.confirm",
      "locations.activate",
    ]);

    const newEnd = addDays(new Date(created.endDate), 2);
    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(newEnd) }),
    });
    expect(response.status).toBe(200);
  });

  it("un MEMBER sans locations.edit du tout reçoit 403, aucune modification", async () => {
    const tenant = await setupTenant("noedit");
    const vehicle = await createVehicle(tenant, "NOEDIT");
    const createResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const created = (await createResponse.json()).location as { id: string; endDate: string };
    await activateLocation(tenant, created.id);

    const member = await createScopedMember(tenant, "noedit", ["locations.view"]);

    const newEnd = addDays(new Date(created.endDate), 2);
    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(newEnd) }),
    });
    expect(response.status).toBe(403);

    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: created.id } });
    expect(unchanged.endDate.toISOString()).toBe(created.endDate);
  });
});

describe("Prolongation — conflit de maintenance : alerte, refus sans permission, confirmation avec permission", () => {
  it("bloque (409) avec conflictingMaintenances quand la prolongation chevauche une maintenance planifiée, maintenance inchangée", async () => {
    const tenant = await setupTenant("mconf");
    const vehicle = await createVehicle(tenant, "MCONF");
    const createResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const created = (await createResponse.json()).location as { id: string; endDate: string };
    await activateLocation(tenant, created.id);

    const maintenanceResponse = await createMaintenance(tenant, vehicle.id, daysFromNow(4), daysFromNow(6));
    const maintenance = (await maintenanceResponse.json()).maintenance;

    const newEnd = daysFromNow(5);
    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(newEnd) }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.conflictingMaintenances.length).toBeGreaterThan(0);

    const unchangedLocation = await prisma.location.findUniqueOrThrow({ where: { id: created.id } });
    expect(unchangedLocation.endDate.toISOString()).toBe(created.endDate);
    const unchangedMaintenance = await prisma.maintenance.findUniqueOrThrow({ where: { id: maintenance.id } });
    expect(unchangedMaintenance.scheduledDate.toISOString()).toBe(maintenance.scheduledDate);
    expect(unchangedMaintenance.status).toBe("SCHEDULED");
  });

  it("un MEMBER avec locations.edit mais sans locations.maintenance_conflict.override voit l'alerte (409) puis reçoit 403 en tentant de confirmer", async () => {
    const tenant = await setupTenant("mconfnoperm");
    const vehicle = await createVehicle(tenant, "MCONFNOPERM");
    const createResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const created = (await createResponse.json()).location as { id: string; endDate: string };
    await activateLocation(tenant, created.id);
    await createMaintenance(tenant, vehicle.id, daysFromNow(4), daysFromNow(6));

    const member = await createScopedMember(tenant, "mconfnoperm", [
      "locations.view",
      "locations.edit",
      "locations.confirm",
      "locations.activate",
    ]);

    const newEnd = daysFromNow(5);
    const alertResponse = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(newEnd) }),
    });
    expect(alertResponse.status).toBe(409);

    const confirmResponse = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(newEnd), confirmMaintenanceConflict: true }),
    });
    expect(confirmResponse.status).toBe(403);

    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: created.id } });
    expect(unchanged.endDate.toISOString()).toBe(created.endDate);
  });

  it("un MEMBER avec locations.edit ET locations.maintenance_conflict.override peut confirmer explicitement (200), maintenance toujours inchangée", async () => {
    const tenant = await setupTenant("mconfperm");
    const vehicle = await createVehicle(tenant, "MCONFPERM");
    const createResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const created = (await createResponse.json()).location as { id: string; endDate: string };
    await activateLocation(tenant, created.id);
    const maintenanceResponse = await createMaintenance(tenant, vehicle.id, daysFromNow(4), daysFromNow(6));
    const maintenance = (await maintenanceResponse.json()).maintenance;

    const member = await createScopedMember(tenant, "mconfperm", [
      "locations.view",
      "locations.edit",
      "locations.confirm",
      "locations.activate",
      "locations.maintenance_conflict.override",
    ]);

    const newEnd = daysFromNow(5);
    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(newEnd), confirmMaintenanceConflict: true }),
    });
    expect(response.status).toBe(200);
    const { location } = await response.json();
    expect(new Date(location.endDate).getTime()).toBe(newEnd.getTime());

    const unchangedMaintenance = await prisma.maintenance.findUniqueOrThrow({ where: { id: maintenance.id } });
    expect(unchangedMaintenance.scheduledDate.toISOString()).toBe(maintenance.scheduledDate);
    expect(unchangedMaintenance.status).toBe("SCHEDULED");
  });
});

describe("Prolongation — conflit avec une autre location", () => {
  it("refuse (409) une prolongation qui chevaucherait une autre location existante sur le même véhicule", async () => {
    const tenant = await setupTenant("vconf");
    const vehicle = await createVehicle(tenant, "VCONF");

    const firstResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const first = (await firstResponse.json()).location as { id: string; endDate: string };
    await activateLocation(tenant, first.id);

    // Deuxième location, PENDING (bloque déjà checkAvailability), sur une fenêtre qui
    // chevaucherait la prolongation visée ci-dessous.
    await createLocation(tenant, vehicle.id, daysFromNow(5), daysFromNow(8));

    const newEnd = daysFromNow(6); // chevauche [J+5, J+8[
    const response = await apiFetch(`/api/locations/${first.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(newEnd) }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.conflictingLocations).toBeDefined();
    expect(body.conflictingLocations.length).toBeGreaterThan(0);

    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: first.id } });
    expect(unchanged.endDate.toISOString()).toBe(first.endDate);
  });
});

describe("Isolation tenant/agence", () => {
  it("un contrat d'un autre tenant reste introuvable (404)", async () => {
    const tenantA = await setupTenant("isoa");
    const tenantB = await setupTenant("isob");
    const vehicleB = await createVehicle(tenantB, "ISOB");
    const createResponse = await createLocation(tenantB, vehicleB.id, daysFromNow(0), daysFromNow(3));
    const created = (await createResponse.json()).location as { id: string };
    await activateLocation(tenantB, created.id);

    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: tenantA.admin.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(daysFromNow(5)) }),
    });
    expect(response.status).toBe(404);
  });

  it("un MEMBER restreint à une autre agence du même tenant reçoit 404 (contrat introuvable pour lui)", async () => {
    const tenant = await setupTenant("isoagency");
    const vehicle = await createVehicle(tenant, "ISOAGENCY");
    const createResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const created = (await createResponse.json()).location as { id: string; endDate: string };
    await activateLocation(tenant, created.id);

    const otherAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ name: "Autre agence", slug: `le-other-agence-${runId}` }),
    });
    const otherAgencyId = (await otherAgencyResponse.json()).agency.id;

    const member = await createScopedMember(
      tenant,
      "isoagency",
      ["locations.view", "locations.edit", "locations.confirm", "locations.activate"],
      otherAgencyId
    );

    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(daysFromNow(5)) }),
    });
    expect(response.status).toBe(404);

    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: created.id } });
    expect(unchanged.endDate.toISOString()).toBe(created.endDate);
  });
});

/**
 * Sprint 13E tâche 2 (revue demandée après le rapport de clôture initial) : une agence de
 * retour (`Location.dropoffAgencyId`, Sprint 19, DOMAINRULES.md section 37) donne accès en
 * lecture (`canAccessLocationAgency`) sans jamais donner le droit de modifier les dates —
 * seule l'agence de départ (`Location.agencyId`) le peut (`hasPickupAccess`,
 * PATCH /api/locations/[id]). Distinct du test « MEMBER restreint à une autre agence »
 * ci-dessus (qui n'a de lien avec AUCUNE des deux agences de la location, donc 404 avant même
 * d'atteindre la restriction de champs) : ici le membre a un lien réel avec la location — via
 * l'agence de retour seule — donc la voit (pas 404), mais ne peut pas la modifier (403).
 * `Location.dropoffAgencyId` ne peut être positionné qu'à la conversion d'une réservation
 * (POST /api/reservations/[id]/convert, jamais par POST /api/locations directement) — ce
 * bloc reproduit donc ce parcours complet plutôt que de créer la location directement.
 */
describe("Isolation agence de retour — extendReturnDate refusé sans accès à l'agence de départ", () => {
  async function createLocationWithDistinctDropoffAgency(
    tenant: Tenant,
    pickupAgencyId: string,
    pickupAgencyName: string,
    dropoffAgencyName: string,
    vehicleId: string
  ) {
    const reservationResponse = await apiFetch("/api/reservations", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({
        voucherNumber: `LE-DROPOFF-${runId}-${Math.random().toString(36).slice(2, 8)}`,
        clientFirstName: "Dropoff",
        clientLastName: "Test",
        startDate: iso(daysFromNow(0)),
        endDate: iso(daysFromNow(3)),
        pickupAgency: pickupAgencyName,
        dropoffAgency: dropoffAgencyName,
      }),
    });
    expect(reservationResponse.status).toBe(201);
    const reservation = (await reservationResponse.json()).reservation as { id: string };

    const convertResponse = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        startDate: iso(daysFromNow(0)),
        endDate: iso(daysFromNow(3)),
        client: {
          firstName: "Dropoff",
          lastName: "Test",
          address: "1 rue du Test",
          city: "Casablanca",
          country: "Maroc",
          idType: "CIN",
          idNumber: `CIN-${runId}`,
          licenseNumber: `PERM-${runId}`,
          licenseIssueDate: "2015-01-01",
          licenseExpiryDate: "2099-12-31",
          birthDate: "1990-01-01",
        },
        payment: { deferred: true },
      }),
    });
    expect(convertResponse.status).toBe(201);
    const location = (await convertResponse.json()).location as {
      id: string;
      agencyId: string;
      dropoffAgencyId: string | null;
      contractNumber: string | null;
      endDate: string;
      totalPrice: number;
    };
    expect(location.agencyId).toBe(pickupAgencyId);
    return location;
  }

  it("un MEMBER lié uniquement à l'agence de retour (pas l'agence de départ) reçoit 403 sur extendReturnDate — la location reste inchangée", async () => {
    const tenant = await setupTenant("dropoffonly");
    // Agence de départ = tenant.agencyId (celle du véhicule/de la location, voir
    // createLocationWithDistinctDropoffAgency ci-dessus) — le membre n'y sera jamais lié.
    const pickupAgencyName = `Agence Depart ${runId}`;
    await apiFetch(`/api/agencies/${tenant.agencyId}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ name: pickupAgencyName }),
    });

    const dropoffAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ name: `Agence Retour ${runId}`, slug: `le-dropoff-${runId}` }),
    });
    const dropoffAgency = (await dropoffAgencyResponse.json()).agency as { id: string; name: string };

    const vehicle = await createVehicle(tenant, "DROPOFFONLY");
    const location = await createLocationWithDistinctDropoffAgency(
      tenant,
      tenant.agencyId,
      pickupAgencyName,
      dropoffAgency.name,
      vehicle.id
    );
    expect(location.dropoffAgencyId).toBe(dropoffAgency.id);
    await activateLocation(tenant, location.id);

    const invoiceBefore = await prisma.invoice.findFirstOrThrow({ where: { locationId: location.id } });

    // MEMBER lié UNIQUEMENT à l'agence de retour — locations.edit accordé (pour prouver que
    // la permission seule ne suffit pas sans l'accès à l'agence de départ, comme demandé).
    const member = await createScopedMember(
      tenant,
      "dropoffonly",
      ["locations.view", "locations.edit", "locations.confirm", "locations.activate", "locations.complete"],
      dropoffAgency.id
    );

    // Contrôle préalable : le membre VOIT bien la location (agence de retour donne accès en
    // lecture, Sprint 19) — donc un éventuel 404 ci-dessous ne serait pas dû à une visibilité
    // absente, mais bien à un refus explicite de modification.
    const getResponse = await apiFetch(`/api/locations/${location.id}`, {
      headers: { Cookie: member.sessionCookie },
    });
    expect(getResponse.status).toBe(200);

    const newEnd = addDays(new Date(location.endDate), 2);
    const patchResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(newEnd) }),
    });

    // Refus explicite (403 — la location est visible, pas introuvable) : « agence de retour
    // seule » ne donne accès qu'à la réception (statut → COMPLETED, kilométrage/carburant
    // retour), jamais aux dates. Voir PATCH /api/locations/[id]/route.ts, hasPickupAccess.
    expect(patchResponse.status).toBe(403);
    const patchBody = await patchResponse.json();
    expect(patchBody.error).toContain("L'agence de retour ne peut que gérer la réception");

    // Aucune donnée modifiée : dates, prix, numéro de contrat.
    const unchangedLocation = await prisma.location.findUniqueOrThrow({ where: { id: location.id } });
    expect(unchangedLocation.endDate.toISOString()).toBe(location.endDate);
    expect(unchangedLocation.totalPrice).toBe(location.totalPrice);
    expect(unchangedLocation.contractNumber).toBe(location.contractNumber);

    // Facture inchangée (aucune resynchronisation déclenchée par une tentative refusée).
    const unchangedInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceBefore.id } });
    expect(unchangedInvoice.subtotal).toBe(invoiceBefore.subtotal);
    expect(unchangedInvoice.totalAmount).toBe(invoiceBefore.totalAmount);

    // Aucun audit de prolongation enregistré pour cette tentative refusée.
    const auditResponse = await apiFetch(`/api/audit?resource=Location&action=location.extended`, {
      headers: { Cookie: tenant.admin.sessionCookie },
    });
    const auditLogs = (await auditResponse.json()).logs as { resourceId: string }[];
    expect(auditLogs.some((log) => log.resourceId === location.id)).toBe(false);
  });

  it("un ADMIN du même tenant conserve l'accès (extension acceptée, 200) malgré l'absence de lien UserAgency explicite", async () => {
    const tenant = await setupTenant("dropoffadmin");
    const pickupAgencyName = `Agence Depart Admin ${runId}`;
    await apiFetch(`/api/agencies/${tenant.agencyId}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ name: pickupAgencyName }),
    });
    const dropoffAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ name: `Agence Retour Admin ${runId}`, slug: `le-dropoff-admin-${runId}` }),
    });
    const dropoffAgency = (await dropoffAgencyResponse.json()).agency as { id: string; name: string };

    const vehicle = await createVehicle(tenant, "DROPOFFADMIN");
    const location = await createLocationWithDistinctDropoffAgency(
      tenant,
      tenant.agencyId,
      pickupAgencyName,
      dropoffAgency.name,
      vehicle.id
    );
    await activateLocation(tenant, location.id);

    // tenant.admin n'a aucun UserAgency explicite pour aucune des deux agences (un ADMIN n'en
    // a jamais besoin, voir src/lib/authz.ts canAccessAgency) — l'extension doit réussir.
    const newEnd = addDays(new Date(location.endDate), 2);
    const response = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(newEnd) }),
    });
    expect(response.status).toBe(200);
  });
});

describe("Concurrence", () => {
  it("une prolongation et une nouvelle location concurrentes disputant la même période libre sur le même véhicule : exactement un succès", async () => {
    const tenant = await setupTenant("conc1");
    const vehicle = await createVehicle(tenant, "CONC1");
    const createResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const created = (await createResponse.json()).location as { id: string; endDate: string };
    await activateLocation(tenant, created.id);

    const [extendResponse, newLocationResponse] = await Promise.all([
      apiFetch(`/api/locations/${created.id}`, {
        method: "PATCH",
        headers: { Cookie: tenant.admin.sessionCookie },
        body: JSON.stringify({ extendReturnDate: true, endDate: iso(daysFromNow(6)) }),
      }),
      createLocation(tenant, vehicle.id, daysFromNow(4), daysFromNow(7)),
    ]);

    // L'une des deux opérations gagne le verrou du véhicule (200 pour la prolongation, ou 201
    // pour la nouvelle location — l'ordre n'est pas déterministe), l'autre trouve un conflit
    // réel une fois le véhicule reverrouillé (409) — jamais les deux réussies (double
    // réservation de la même période), jamais les deux en échec.
    const successStatuses = [extendResponse.status, newLocationResponse.status].filter(
      (status) => status === 200 || status === 201
    );
    const conflictStatuses = [extendResponse.status, newLocationResponse.status].filter((status) => status === 409);
    expect(successStatuses.length).toBe(1);
    expect(conflictStatuses.length).toBe(1);

    // Nombre total de locations sur le véhicule cohérent avec l'issue de la course : 1 (la
    // location initiale, si la prolongation a gagné — aucune nouvelle ligne créée) ou 2 (si la
    // nouvelle location a gagné à la place) — jamais 3 (double succès, chevauchement réel non
    // empêché).
    const totalCount = await prisma.location.count({ where: { vehicleId: vehicle.id } });
    expect(totalCount).toBeLessThanOrEqual(2);
    expect(totalCount).toBeGreaterThanOrEqual(1);
  });

  it("deux prolongations concurrentes vers des périodes non chevauchantes sur le même véhicule réussissent toutes les deux", async () => {
    const tenant = await setupTenant("conc2");
    const vehicle = await createVehicle(tenant, "CONC2");

    const loc1Response = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));
    const loc1 = (await loc1Response.json()).location as { id: string };
    await activateLocation(tenant, loc1.id);

    const loc2Response = await createLocation(tenant, vehicle.id, daysFromNow(10), daysFromNow(12));
    const loc2 = (await loc2Response.json()).location as { id: string };
    await activateLocation(tenant, loc2.id);

    const [extend1, extend2] = await Promise.all([
      apiFetch(`/api/locations/${loc1.id}`, {
        method: "PATCH",
        headers: { Cookie: tenant.admin.sessionCookie },
        body: JSON.stringify({ extendReturnDate: true, endDate: iso(daysFromNow(3)) }),
      }),
      apiFetch(`/api/locations/${loc2.id}`, {
        method: "PATCH",
        headers: { Cookie: tenant.admin.sessionCookie },
        body: JSON.stringify({ extendReturnDate: true, endDate: iso(daysFromNow(13)) }),
      }),
    ]);
    expect(extend1.status).toBe(200);
    expect(extend2.status).toBe(200);
  });
});

describe("Non-régression — modification de dates ADMIN générique toujours possible sans extendReturnDate", () => {
  it("un ADMIN peut toujours raccourcir librement les dates d'un contrat ACTIVE via le formulaire générique (adminOverride, comportement Sprint 19 inchangé)", async () => {
    const tenant = await setupTenant("adminshorten");
    const vehicle = await createVehicle(tenant, "ADMINSHORTEN");
    const createResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(5));
    const created = (await createResponse.json()).location as { id: string; startDate: string };
    await activateLocation(tenant, created.id);

    // Raccourcir (nouvelle date de retour AVANT l'actuelle) : refusé pour une prolongation
    // (extendReturnDate), mais toujours accepté pour un ADMIN via le formulaire générique —
    // comportement préexistant, non affecté par ce sprint.
    const shortenedEnd = daysFromNow(2);
    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ endDate: iso(shortenedEnd) }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(new Date(body.location.endDate).getTime()).toBeCloseTo(shortenedEnd.getTime(), -2);
  });
});
