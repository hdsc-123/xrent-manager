import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

/**
 * Sprint technique 1 (DOMAINRULES.md section 60, HANDOFF.md point 43) — prolongations comme
 * nouveaux contrats liés : POST /api/locations/[id]/extend (src/lib/location-chains.ts), unique
 * mécanisme officiel de prolongation depuis le Sprint technique 3 (règle 11 — retrait complet de
 * l'ancien parcours `extendReturnDate`, voir location-extension.test.ts pour sa compatibilité
 * bloquée et la protection de chaîne). Ce fichier couvre spécifiquement le modèle de chaîne :
 * nouveau contrat, propre numéro, propre facture RENTAL, chaînage parent/racine, statuts
 * interdits, chaîne strictement linéaire, isolation tenant/agence, permission dédiée, changement
 * de véhicule/agence, tarification propre (y compris gratuite), audit, rollback transactionnel
 * complet, et la contrainte CHECK de la migration (auto-rattachement).
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];
const password = "Correct-Horse-Battery-Staple9!";
const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
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
    tenantName: `Loc Chain ${label} ${runId}`,
    tenantSlug: `loc-chain-${label}-${runId}`,
    name: "Admin",
    email: `admin-lc-${label}-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(admin.tenantId);

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: `Agence ${label}`, slug: `lc-agence-${label}-${runId}` }),
  });
  const agencyId = (await agencyResponse.json()).agency.id;

  const clientResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      name: `Client ${label}`,
      email: `client-lc-${label}-${runId}@test.local`,
      licenseExpiryDate: "2099-12-31",
      birthDate: "1990-01-01",
    }),
  });
  const clientId = (await clientResponse.json()).client.id;

  return { admin, agencyId, clientId };
}

async function createVehicle(tenant: Tenant, label: string, agencyId: string = tenant.agencyId, pricePerDay = 30000) {
  const response = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({
      agencyId,
      name: "Clio",
      licensePlate: `LC-${Math.floor(Math.random() * 1_000_000)}-${label}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay,
      chassisNumber: `VF1LC${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 90,
      powerKW: 67,
      engineSize: 1.5,
    }),
  });
  return (await response.json()).vehicle as { id: string; agencyId: string };
}

async function createAndActivateLocation(
  tenant: Tenant,
  vehicleId: string,
  startDate: Date,
  endDate: Date,
  actor: AuthenticatedTestUser = tenant.admin
) {
  const createResponse = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: actor.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      clientId: tenant.clientId,
      startDate: iso(startDate),
      endDate: iso(endDate),
      payment: { deferred: true },
    }),
  });
  if (createResponse.status !== 201) {
    throw new Error(`Échec de création de la location de test (${createResponse.status}) : ${await createResponse.text()}`);
  }
  const { location } = await createResponse.json();

  await apiFetch(`/api/locations/${location.id}`, {
    method: "PATCH",
    headers: { Cookie: actor.sessionCookie },
    body: JSON.stringify({ status: "CONFIRMED" }),
  });
  const activateResponse = await apiFetch(`/api/locations/${location.id}`, {
    method: "PATCH",
    headers: { Cookie: actor.sessionCookie },
    body: JSON.stringify({ status: "ACTIVE" }),
  });
  return (await activateResponse.json()).location as {
    id: string;
    contractNumber: string | null;
    agencyId: string;
    vehicleId: string;
    endDate: string;
    status: string;
  };
}

async function createScopedMember(
  tenant: Tenant,
  label: string,
  permissions: string[],
  agencyIds: string[] = [tenant.agencyId]
) {
  const groupResponse = await apiFetch("/api/permission-groups", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ name: `LC-${label}-${runId}`, permissions }),
  });
  const groupId = (await groupResponse.json()).group.id;

  const member = await createAndLoginMember({
    tenantId: tenant.admin.tenantId,
    name: label,
    email: `lc-${label}-${runId}@test.local`,
    password,
  });
  await apiFetch(`/api/users/${member.userId}`, {
    method: "PATCH",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ agencyIds }),
  });
  await apiFetch(`/api/users/${member.userId}/permissions`, {
    method: "PATCH",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ permissionGroupId: groupId }),
  });
  return member;
}

function extendLocation(actor: AuthenticatedTestUser, parentId: string, body: Record<string, unknown>) {
  return apiFetch(`/api/locations/${parentId}/extend`, {
    method: "POST",
    headers: { Cookie: actor.sessionCookie },
    body: JSON.stringify(body),
  });
}

afterAll(async () => {
  for (const tenantId of createdTenantIds) {
    await prisma.location.deleteMany({ where: { tenantId } }).catch(() => undefined);
  }
});

describe("Prolongation — création depuis un contrat ACTIVE", () => {
  it("crée un nouveau contrat lié, chaîné, avec son propre numéro, statut ACTIVE ; le parent reste inchangé", async () => {
    const tenant = await setupTenant("basic");
    const vehicle = await createVehicle(tenant, "BASIC");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));

    const newEnd = daysFromNow(6);
    const response = await extendLocation(tenant.admin, parent.id, { endDate: iso(newEnd) });
    expect(response.status).toBe(201);
    const { location } = await response.json();

    expect(location.id).not.toBe(parent.id);
    expect(location.contractKind).toBe("EXTENSION");
    expect(location.status).toBe("ACTIVE");
    expect(location.parentLocationId).toBe(parent.id);
    expect(location.rootLocationId).toBe(parent.id);
    expect(location.contractNumber).not.toBe(parent.contractNumber);
    expect(location.contractNumber).not.toBeNull();
    expect(new Date(location.startDate).getTime()).toBe(new Date(parent.endDate).getTime());
    expect(new Date(location.endDate).getTime()).toBe(newEnd.getTime());

    // Le contrat parent n'est jamais modifié par la création d'une prolongation.
    const unchangedParent = await prisma.location.findUniqueOrThrow({ where: { id: parent.id } });
    expect(unchangedParent.status).toBe("ACTIVE");
    expect(unchangedParent.contractNumber).toBe(parent.contractNumber);
    expect(unchangedParent.endDate.toISOString()).toBe(parent.endDate);
    expect(unchangedParent.parentLocationId).toBeNull();
    expect(unchangedParent.rootLocationId).toBe(parent.id);
  });

  it("crée une facture RENTAL indépendante, distincte de celle du contrat parent", async () => {
    const tenant = await setupTenant("invoice");
    const vehicle = await createVehicle(tenant, "INVOICE");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));
    const parentInvoice = await prisma.invoice.findFirst({ where: { locationId: parent.id } });

    const response = await extendLocation(tenant.admin, parent.id, { endDate: iso(daysFromNow(5)) });
    expect(response.status).toBe(201);
    const { location, invoice } = await response.json();

    expect(invoice).not.toBeNull();
    expect(invoice.locationId).toBe(location.id);
    expect(invoice.type).toBe("RENTAL");
    expect(invoice.id).not.toBe(parentInvoice?.id);

    const invoicesForParent = await prisma.invoice.findMany({ where: { locationId: parent.id } });
    expect(invoicesForParent).toHaveLength(1);
    expect(invoicesForParent[0].id).toBe(parentInvoice?.id);
  });

  it("journalise location.extension_created avec le chaînage complet en métadonnées", async () => {
    const tenant = await setupTenant("audit");
    const vehicle = await createVehicle(tenant, "AUDIT");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    const response = await extendLocation(tenant.admin, parent.id, { endDate: iso(daysFromNow(4)) });
    expect(response.status).toBe(201);
    const { location } = await response.json();

    const entry = await prisma.auditLog.findFirst({
      where: { tenantId: tenant.admin.tenantId, action: "location.extension_created", resourceId: location.id },
    });
    expect(entry).not.toBeNull();
    const metadata = entry?.metadata as Record<string, unknown>;
    expect(metadata.parentLocationId).toBe(parent.id);
    expect(metadata.rootLocationId).toBe(parent.id);
    expect(metadata.contractNumber).toBe(location.contractNumber);
  });
});

describe("Prolongation — statuts interdits", () => {
  it("refuse (409) depuis un contrat PENDING (jamais activé)", async () => {
    const tenant = await setupTenant("pending");
    const vehicle = await createVehicle(tenant, "PENDING");
    const createResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({
        vehicleId: vehicle.id,
        clientId: tenant.clientId,
        startDate: iso(daysFromNow(0)),
        endDate: iso(daysFromNow(2)),
        payment: { deferred: true },
      }),
    });
    const { location } = await createResponse.json();

    const response = await extendLocation(tenant.admin, location.id, { endDate: iso(daysFromNow(5)) });
    expect(response.status).toBe(409);
    expect(await prisma.location.findFirst({ where: { parentLocationId: location.id } })).toBeNull();
  });

  it("refuse (409) depuis un contrat déjà retourné (COMPLETED)", async () => {
    const tenant = await setupTenant("completed");
    const vehicle = await createVehicle(tenant, "COMPLETED");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(-3), daysFromNow(0));
    await apiFetch(`/api/locations/${parent.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });

    const response = await extendLocation(tenant.admin, parent.id, { endDate: iso(daysFromNow(3)) });
    expect(response.status).toBe(409);
  });

  it("refuse (409) sur un contrat CANCELLED", async () => {
    const tenant = await setupTenant("cancelled");
    const vehicle = await createVehicle(tenant, "CANCELLED");
    const createResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({
        vehicleId: vehicle.id,
        clientId: tenant.clientId,
        startDate: iso(daysFromNow(0)),
        endDate: iso(daysFromNow(2)),
        payment: { deferred: true },
      }),
    });
    const { location } = await createResponse.json();
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });

    const response = await extendLocation(tenant.admin, location.id, { endDate: iso(daysFromNow(5)) });
    expect(response.status).toBe(409);
  });
});

describe("Prolongation — chaîne strictement linéaire", () => {
  it("autorise la prolongation d'une prolongation, avec le même rootLocationId que le contrat initial", async () => {
    const tenant = await setupTenant("chain");
    const vehicle = await createVehicle(tenant, "CHAIN");
    const root = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    const firstExtResponse = await extendLocation(tenant.admin, root.id, { endDate: iso(daysFromNow(4)) });
    expect(firstExtResponse.status).toBe(201);
    const { location: firstExt } = await firstExtResponse.json();
    expect(firstExt.rootLocationId).toBe(root.id);

    const secondExtResponse = await extendLocation(tenant.admin, firstExt.id, { endDate: iso(daysFromNow(6)) });
    expect(secondExtResponse.status).toBe(201);
    const { location: secondExt } = await secondExtResponse.json();

    expect(secondExt.parentLocationId).toBe(firstExt.id);
    expect(secondExt.rootLocationId).toBe(root.id);
    expect(secondExt.id).not.toBe(root.id);
    expect(secondExt.id).not.toBe(firstExt.id);
  });

  it("refuse (409) un second enfant direct sur le même contrat parent", async () => {
    const tenant = await setupTenant("branch");
    const vehicle = await createVehicle(tenant, "BRANCH");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    const firstResponse = await extendLocation(tenant.admin, parent.id, { endDate: iso(daysFromNow(4)) });
    expect(firstResponse.status).toBe(201);

    const secondResponse = await extendLocation(tenant.admin, parent.id, { endDate: iso(daysFromNow(5)) });
    expect(secondResponse.status).toBe(409);

    const children = await prisma.location.findMany({ where: { parentLocationId: parent.id } });
    expect(children).toHaveLength(1);
  });
});

describe("Prolongation — isolation et permissions", () => {
  it("refuse (404) un contrat d'un autre tenant", async () => {
    const tenantA = await setupTenant("isoA");
    const tenantB = await setupTenant("isoB");
    const vehicleA = await createVehicle(tenantA, "ISOA");
    const parentA = await createAndActivateLocation(tenantA, vehicleA.id, daysFromNow(0), daysFromNow(2));

    const response = await extendLocation(tenantB.admin, parentA.id, { endDate: iso(daysFromNow(5)) });
    expect(response.status).toBe(404);
  });

  it("refuse (403) sans la permission locations.extension.create", async () => {
    const tenant = await setupTenant("noperm");
    const vehicle = await createVehicle(tenant, "NOPERM");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    const member = await createScopedMember(tenant, "noperm", [
      "locations.view",
      "locations.edit",
      "locations.confirm",
      "locations.activate",
      "locations.complete",
    ]);

    const response = await extendLocation(member, parent.id, { endDate: iso(daysFromNow(5)) });
    expect(response.status).toBe(403);
    expect(await prisma.location.findFirst({ where: { parentLocationId: parent.id } })).toBeNull();
  });

  it("autorise avec la permission locations.extension.create", async () => {
    const tenant = await setupTenant("withperm");
    const vehicle = await createVehicle(tenant, "WITHPERM");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    const member = await createScopedMember(tenant, "withperm", ["locations.view", "locations.extension.create"]);

    const response = await extendLocation(member, parent.id, { endDate: iso(daysFromNow(5)) });
    expect(response.status).toBe(201);
  });

  it("refuse (403) une agence de référence à laquelle l'appelant n'a pas accès", async () => {
    const tenant = await setupTenant("agencyperm");
    const vehicle = await createVehicle(tenant, "AGENCYPERM");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    const otherAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ name: "Autre agence", slug: `lc-other-${runId}` }),
    });
    const otherAgencyId = (await otherAgencyResponse.json()).agency.id;

    const member = await createScopedMember(tenant, "agencyperm", ["locations.view", "locations.extension.create"], [
      tenant.agencyId,
    ]);

    const response = await extendLocation(member, parent.id, {
      endDate: iso(daysFromNow(5)),
      agencyId: otherAgencyId,
    });
    expect(response.status).toBe(403);
  });
});

describe("Prolongation — numérotation", () => {
  it("génère un numéro de contrat propre, distinct de celui du parent", async () => {
    const tenant = await setupTenant("number");
    const vehicle = await createVehicle(tenant, "NUMBER");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    const response = await extendLocation(tenant.admin, parent.id, { endDate: iso(daysFromNow(5)) });
    const { location } = await response.json();

    // Pas de préfixe configuré pour cette agence de test (contractNumberPrefix optionnel,
    // generateContractNumber) : seul le compteur à 5 chiffres est garanti dans tous les cas.
    expect(location.contractNumber).toMatch(/\d{5}$/);
    expect(location.contractNumber).not.toBe(parent.contractNumber);

    const totalWithThisNumber = await prisma.location.count({
      where: { tenantId: tenant.admin.tenantId, contractNumber: location.contractNumber },
    });
    expect(totalWithThisNumber).toBe(1);
  });

  it("reste sans collision sous création concurrente sur deux contrats parents différents de la même agence", async () => {
    const tenant = await setupTenant("concurrent");
    const vehicleA = await createVehicle(tenant, "CONCA");
    const vehicleB = await createVehicle(tenant, "CONCB");
    const [parentA, parentB] = await Promise.all([
      createAndActivateLocation(tenant, vehicleA.id, daysFromNow(0), daysFromNow(2)),
      createAndActivateLocation(tenant, vehicleB.id, daysFromNow(0), daysFromNow(2)),
    ]);

    const [responseA, responseB] = await Promise.all([
      extendLocation(tenant.admin, parentA.id, { endDate: iso(daysFromNow(5)) }),
      extendLocation(tenant.admin, parentB.id, { endDate: iso(daysFromNow(5)) }),
    ]);
    expect(responseA.status).toBe(201);
    expect(responseB.status).toBe(201);

    const { location: locationA } = await responseA.json();
    const { location: locationB } = await responseB.json();
    expect(locationA.contractNumber).not.toBe(locationB.contractNumber);
  });
});

describe("Prolongation — véhicule", () => {
  it("refuse (409) si le nouveau véhicule n'est pas disponible sur la nouvelle période", async () => {
    const tenant = await setupTenant("vehunavail");
    const vehicle = await createVehicle(tenant, "VU1");
    const otherVehicle = await createVehicle(tenant, "VU2");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));
    // Le second véhicule est déjà occupé sur exactement la période visée par la prolongation.
    await createAndActivateLocation(tenant, otherVehicle.id, daysFromNow(2), daysFromNow(5));

    const response = await extendLocation(tenant.admin, parent.id, {
      endDate: iso(daysFromNow(5)),
      vehicleId: otherVehicle.id,
    });
    expect(response.status).toBe(409);
  });

  it("autorise le changement de véhicule si le nouveau véhicule est disponible", async () => {
    const tenant = await setupTenant("vehok");
    const vehicle = await createVehicle(tenant, "VOK1");
    const freeVehicle = await createVehicle(tenant, "VOK2");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    const response = await extendLocation(tenant.admin, parent.id, {
      endDate: iso(daysFromNow(5)),
      vehicleId: freeVehicle.id,
    });
    expect(response.status).toBe(201);
    const { location } = await response.json();
    expect(location.vehicleId).toBe(freeVehicle.id);
    expect(location.vehicleId).not.toBe(parent.vehicleId);
  });
});

describe("Prolongation — changement d'agence", () => {
  it("utilise la nouvelle agence comme agence de référence, y compris pour la numérotation", async () => {
    const tenant = await setupTenant("agencychange");
    const vehicle = await createVehicle(tenant, "AGCHANGE");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    const secondAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ name: "Deuxième agence", slug: `lc-second-${runId}` }),
    });
    const secondAgencyId = (await secondAgencyResponse.json()).agency.id;

    const response = await extendLocation(tenant.admin, parent.id, {
      endDate: iso(daysFromNow(5)),
      agencyId: secondAgencyId,
    });
    expect(response.status).toBe(201);
    const { location } = await response.json();
    expect(location.agencyId).toBe(secondAgencyId);
    expect(location.agencyId).not.toBe(parent.agencyId);
  });
});

describe("Prolongation — tarification propre au nouveau contrat", () => {
  it("autorise une prolongation gratuite (pricePerDay 0, facture à 0)", async () => {
    const tenant = await setupTenant("free");
    const vehicle = await createVehicle(tenant, "FREE", tenant.agencyId, 40000);
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    const response = await extendLocation(tenant.admin, parent.id, {
      endDate: iso(daysFromNow(4)),
      pricePerDay: 0,
    });
    expect(response.status).toBe(201);
    const { location, invoice } = await response.json();
    expect(location.pricePerDay).toBe(0);
    expect(location.totalPrice).toBe(0);
    expect(invoice.totalAmount).toBe(0);
  });

  it("applique une remise et une TVA propres à la prolongation, indépendantes du contrat parent", async () => {
    const tenant = await setupTenant("taxdiscount");
    const vehicle = await createVehicle(tenant, "TAXDISC", tenant.agencyId, 10000);
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(1));
    const parentInvoice = await prisma.invoice.findFirstOrThrow({ where: { locationId: parent.id } });
    expect(parentInvoice.taxRate).toBe(0);
    expect(parentInvoice.discountAmount).toBe(0);

    // 2 jours à 10000 = 20000 sous-total ; taxRate 1000 points de base (10 %) = 2000 ; remise 5000.
    // endDate dérivée de l'endDate réelle du parent (jamais un nouvel appel indépendant à
    // daysFromNow) pour garantir un écart exact de 2 jours, insensible au temps réseau écoulé
    // entre la création du parent et cet appel.
    const extensionEnd = new Date(new Date(parent.endDate).getTime() + 2 * DAY_MS);
    const response = await extendLocation(tenant.admin, parent.id, {
      endDate: iso(extensionEnd),
      taxRate: 1000,
      discountAmount: 5000,
    });
    expect(response.status).toBe(201);
    const { invoice } = await response.json();
    expect(invoice.subtotal).toBe(20000);
    expect(invoice.taxAmount).toBe(2000);
    expect(invoice.discountAmount).toBe(5000);
    expect(invoice.totalAmount).toBe(20000 - 5000 + 2000);
  });
});

describe("Prolongation — validité du permis de conduire", () => {
  it("refuse (400) une prolongation dont la nouvelle date de retour dépasse l'expiration du permis du client", async () => {
    const tenant = await setupTenant("license");
    const vehicle = await createVehicle(tenant, "LICENSE");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(1));

    // Permis expirant après le retour du contrat parent (sa création n'est donc pas affectée)
    // mais avant la nouvelle date de retour visée par la prolongation.
    const expiry = new Date(new Date(parent.endDate).getTime() + 1 * DAY_MS);
    await prisma.client.update({ where: { id: tenant.clientId }, data: { licenseExpiryDate: expiry } });

    const tooFar = new Date(new Date(parent.endDate).getTime() + 3 * DAY_MS);
    const response = await extendLocation(tenant.admin, parent.id, { endDate: iso(tooFar) });
    expect(response.status).toBe(400);
    expect(await prisma.location.findFirst({ where: { parentLocationId: parent.id } })).toBeNull();
  });

  it("autorise une prolongation dont la nouvelle date de retour reste couverte par le permis", async () => {
    const tenant = await setupTenant("licenseok");
    const vehicle = await createVehicle(tenant, "LICENSEOK");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(1));

    const expiry = new Date(new Date(parent.endDate).getTime() + 5 * DAY_MS);
    await prisma.client.update({ where: { id: tenant.clientId }, data: { licenseExpiryDate: expiry } });

    const withinLicense = new Date(new Date(parent.endDate).getTime() + 3 * DAY_MS);
    const response = await extendLocation(tenant.admin, parent.id, { endDate: iso(withinLicense) });
    expect(response.status).toBe(201);
  });
});

describe("Prolongation — rollback transactionnel", () => {
  it("n'écrit aucune Location si la facturation échoue (remise supérieure au sous-total + TVA)", async () => {
    const tenant = await setupTenant("rollback");
    const vehicle = await createVehicle(tenant, "ROLLBACK", tenant.agencyId, 10000);
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(1));

    const response = await extendLocation(tenant.admin, parent.id, {
      endDate: iso(daysFromNow(2)),
      discountAmount: 999_999_999,
    });
    expect(response.status).toBe(400);

    const children = await prisma.location.findMany({ where: { parentLocationId: parent.id } });
    expect(children).toHaveLength(0);
    const unchangedParent = await prisma.location.findUniqueOrThrow({ where: { id: parent.id } });
    expect(unchangedParent.status).toBe("ACTIVE");
  });
});

describe("Prolongation — contrainte d'intégrité de la chaîne (migration)", () => {
  it("rejette au niveau base un auto-rattachement forcé (parentLocationId = id)", async () => {
    const tenant = await setupTenant("selfref");
    const vehicle = await createVehicle(tenant, "SELFREF");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    await expect(
      prisma.$executeRaw`UPDATE "Location" SET "contractKind" = 'EXTENSION', "parentLocationId" = id WHERE id = ${parent.id}`
    ).rejects.toThrow();

    // État inchangé après le rejet — la contrainte protège réellement la ligne existante.
    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: parent.id } });
    expect(unchanged.contractKind).toBe("INITIAL");
    expect(unchanged.parentLocationId).toBeNull();
  });
});
