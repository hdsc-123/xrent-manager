import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

/**
 * Sprint technique 3 (DOMAINRULES.md section 60, règle 11) : l'ancien parcours dédié
 * « Prolonger la location » (`extendReturnDate`, PATCH /api/locations/[id], introduit Sprint
 * 13E tâche 2) est **retiré** — `createLocationExtension` (POST /api/locations/[id]/extend,
 * src/lib/location-chains.ts, voir location-chains.test.ts) est désormais l'unique mécanisme
 * officiel de prolongation. Ce fichier couvre :
 * 1. la compatibilité bloquée de l'ancien champ `extendReturnDate` — toute requête le portant
 *    encore échoue explicitement (LocationExtensionMechanismRemovedError), sans exception, sans
 *    aucune modification de donnée, quel que soit l'état du contrat ou la permission de
 *    l'appelant ;
 * 2. la protection de chaîne (LocationHasExtensionChainError) — une fois une prolongation créée
 *    via le mécanisme officiel, la contiguïté `child.startDate === parent.endDate` ne peut plus
 *    être rompue par le formulaire PATCH générique, ni par un ADMIN (`adminOverride`) ni par
 *    `confirmMaintenanceConflict` — bug identifié et corrigé ce sprint (avant ce correctif,
 *    prolonger un contrat parent au-delà du départ de son enfant réussissait silencieusement
 *    dès lors que le véhicule différait entre les deux) ;
 * 3. la non-régression du formulaire ADMIN générique de modification des dates
 *    (`adminOverride`) sur un contrat qui ne fait partie d'aucune chaîne ;
 * 4. le rendu de la fiche contrat : l'ancien bouton « Prolonger la location » n'apparaît plus
 *    nulle part, seul « Créer une prolongation » reste, et le formulaire administrateur générique
 *    de modification des dates est masqué (remplacé par une explication) une fois une chaîne
 *    créée.
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

async function createAndActivateLocation(tenant: Tenant, vehicleId: string, startDate: Date, endDate: Date) {
  const createResponse = await createLocation(tenant, vehicleId, startDate, endDate);
  const created = (await createResponse.json()).location as {
    id: string;
    contractNumber: string | null;
    startDate: string;
    endDate: string;
    totalPrice: number;
    parentLocationId: string | null;
  };
  const activateResponse = await activateLocation(tenant, created.id);
  return (await activateResponse.json()).location as typeof created;
}

function extendLocation(actor: AuthenticatedTestUser, parentId: string, body: Record<string, unknown>) {
  return apiFetch(`/api/locations/${parentId}/extend`, {
    method: "POST",
    headers: { Cookie: actor.sessionCookie },
    body: JSON.stringify(body),
  });
}

/** Membre restreint à `tenant.agencyId`, avec exactement les permissions demandées. */
async function createScopedMember(tenant: Tenant, label: string, permissions: string[]) {
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
    body: JSON.stringify({ agencyIds: [tenant.agencyId] }),
  });
  await apiFetch(`/api/users/${member.userId}/permissions`, {
    method: "PATCH",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ permissionGroupId: groupId, individualPermissions: [] }),
  });
  return member;
}

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
  await prisma.$disconnect();
});

describe("Ancien mécanisme extendReturnDate — retiré, refusé sans exception (Sprint technique 3)", () => {
  it("un ADMIN reçoit 409 avec des dates par ailleurs parfaitement valides — aucune modification", async () => {
    const tenant = await setupTenant("removed-admin");
    const vehicle = await createVehicle(tenant, "REMOVEDADMIN");
    const created = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));

    const newEnd = addDays(new Date(created.endDate), 2);
    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(newEnd) }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain("POST /api/locations/[id]/extend");

    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: created.id } });
    expect(unchanged.endDate.toISOString()).toBe(created.endDate);
    expect(unchanged.totalPrice).toBe(created.totalPrice);
    expect(unchanged.contractNumber).toBe(created.contractNumber);

    // Aucun audit de l'ancienne action, ni maintenant ni jamais (le code qui l'émettait a été
    // retiré, cette requête ne peut plus jamais l'atteindre).
    const auditResponse = await apiFetch(`/api/audit?resource=Location&action=location.extended`, {
      headers: { Cookie: tenant.admin.sessionCookie },
    });
    const logs = (await auditResponse.json()).logs as { resourceId: string }[];
    expect(logs.some((log) => log.resourceId === created.id)).toBe(false);
  });

  it("combiné à confirmMaintenanceConflict, reste refusé (409) — jamais un contournement possible", async () => {
    const tenant = await setupTenant("removed-conflict");
    const vehicle = await createVehicle(tenant, "REMOVEDCONFLICT");
    const created = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));

    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({
        extendReturnDate: true,
        endDate: iso(daysFromNow(5)),
        confirmMaintenanceConflict: true,
      }),
    });
    expect(response.status).toBe(409);

    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: created.id } });
    expect(unchanged.endDate.toISOString()).toBe(created.endDate);
  });

  it("sur un contrat encore PENDING (jamais activé), reste refusé (409) — le mécanisme n'existe plus, quel que soit le statut", async () => {
    const tenant = await setupTenant("removed-pending");
    const vehicle = await createVehicle(tenant, "REMOVEDPENDING");
    const createResponse = await createLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const created = (await createResponse.json()).location as { id: string; endDate: string };

    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(daysFromNow(5)) }),
    });
    expect(response.status).toBe(409);
  });

  it("un MEMBER avec locations.edit reçoit aussi 409 (le mécanisme est bloqué avant toute logique de conflit/permission de prolongation)", async () => {
    const tenant = await setupTenant("removed-member");
    const vehicle = await createVehicle(tenant, "REMOVEDMEMBER");
    const created = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));

    const member = await createScopedMember(tenant, "removedmember", [
      "locations.view",
      "locations.edit",
      "locations.confirm",
      "locations.activate",
    ]);

    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(daysFromNow(5)) }),
    });
    expect(response.status).toBe(409);

    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: created.id } });
    expect(unchanged.endDate.toISOString()).toBe(created.endDate);
  });

  it("un MEMBER sans locations.edit reçoit 403 (la garde de permission de la route intervient avant d'atteindre le mécanisme retiré)", async () => {
    const tenant = await setupTenant("removed-noperm");
    const vehicle = await createVehicle(tenant, "REMOVEDNOPERM");
    const created = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));

    const member = await createScopedMember(tenant, "removednoperm", ["locations.view"]);

    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(daysFromNow(5)) }),
    });
    expect(response.status).toBe(403);
  });

  it("un contrat d'un autre tenant reste 404 (l'isolation tenant est vérifiée avant d'atteindre le mécanisme retiré)", async () => {
    const tenantA = await setupTenant("removed-isoa");
    const tenantB = await setupTenant("removed-isob");
    const vehicleB = await createVehicle(tenantB, "REMOVEDISOB");
    const created = await createAndActivateLocation(tenantB, vehicleB.id, daysFromNow(0), daysFromNow(3));

    const response = await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: tenantA.admin.sessionCookie },
      body: JSON.stringify({ extendReturnDate: true, endDate: iso(daysFromNow(5)) }),
    });
    expect(response.status).toBe(404);
  });
});

describe("Protection de chaîne — dates verrouillées une fois une prolongation créée (Sprint technique 3)", () => {
  async function setupChain(label: string) {
    const tenant = await setupTenant(label);
    const vehicle = await createVehicle(tenant, label.toUpperCase());
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const extendResponse = await extendLocation(tenant.admin, parent.id, { endDate: iso(daysFromNow(6)) });
    expect(extendResponse.status).toBe(201);
    const child = (await extendResponse.json()).location as {
      id: string;
      startDate: string;
      endDate: string;
      parentLocationId: string | null;
    };
    return { tenant, vehicle, parent, child };
  }

  it("bug corrigé : un ADMIN ne peut plus repousser endDate du contrat parent au-delà du départ de son enfant (409), même avec un véhicule différent sur l'enfant", async () => {
    // Reproduction exacte du scénario de désynchronisation identifié pendant l'audit : la
    // prolongation change de véhicule (règle 4, DOMAINRULES.md section 60), donc
    // checkAvailability (portée sur un seul véhicule) n'aurait jamais détecté le chevauchement
    // temporel entre le parent et son propre enfant.
    const { tenant, vehicle, parent, child } = await setupChain("chainveh");
    const otherVehicle = await createVehicle(tenant, "CHAINVEHOTHER");
    // Recrée une chaîne avec changement de véhicule explicite sur l'enfant.
    const parent2 = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(10), daysFromNow(13));
    const extendResponse = await extendLocation(tenant.admin, parent2.id, {
      endDate: iso(daysFromNow(16)),
      vehicleId: otherVehicle.id,
    });
    expect(extendResponse.status).toBe(201);
    const child2 = (await extendResponse.json()).location as { id: string; startDate: string };

    const response = await apiFetch(`/api/locations/${parent2.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ endDate: iso(addDays(new Date(child2.startDate), 1)) }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain("chaîne de prolongations");

    const unchangedParent = await prisma.location.findUniqueOrThrow({ where: { id: parent2.id } });
    expect(unchangedParent.endDate.toISOString()).toBe(child2.startDate);
    const unchangedChild = await prisma.location.findUniqueOrThrow({ where: { id: child2.id } });
    expect(unchangedChild.startDate.toISOString()).toBe(child2.startDate);

    // Non-régression du scénario original (véhicule inchangé, déjà indirectement bloqué avant ce
    // sprint par checkAvailability, mais désormais bloqué explicitement par la même garde).
    const sameVehicleResponse = await apiFetch(`/api/locations/${parent.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ endDate: iso(addDays(new Date(child.startDate), 1)) }),
    });
    expect(sameVehicleResponse.status).toBe(409);
  });

  it("un ADMIN ne peut plus modifier startDate du contrat enfant (409) — romprait la contiguïté avec le parent", async () => {
    const { tenant, child } = await setupChain("chainstart");

    const response = await apiFetch(`/api/locations/${child.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ startDate: iso(addDays(new Date(child.startDate), -1)) }),
    });
    expect(response.status).toBe(409);

    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: child.id } });
    expect(unchanged.startDate.toISOString()).toBe(child.startDate);
  });

  it("confirmMaintenanceConflict ne contourne jamais la protection de chaîne (409)", async () => {
    const { tenant, parent, child } = await setupChain("chainoverride");

    const response = await apiFetch(`/api/locations/${parent.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({
        endDate: iso(addDays(new Date(child.startDate), 1)),
        confirmMaintenanceConflict: true,
      }),
    });
    expect(response.status).toBe(409);

    const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: parent.id } });
    expect(unchanged.endDate.toISOString()).toBe(child.startDate);
  });

  it("la protection ne bloque que le bord partagé : endDate du contrat ENFANT reste librement modifiable (200)", async () => {
    const { tenant, child } = await setupChain("chainchildend");

    const newChildEnd = addDays(new Date(child.endDate), 2);
    const response = await apiFetch(`/api/locations/${child.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ endDate: iso(newChildEnd) }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(new Date(body.location.endDate).getTime()).toBe(newChildEnd.getTime());
  });

  it("la protection ne bloque que le bord partagé : startDate du contrat PARENT (racine, aucun parent au-dessus) reste librement modifiable (200)", async () => {
    const { tenant, parent } = await setupChain("chainparentstart");

    const newParentStart = addDays(new Date(parent.startDate), -1);
    const response = await apiFetch(`/api/locations/${parent.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ startDate: iso(newParentStart) }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(new Date(body.location.startDate).getTime()).toBe(newParentStart.getTime());
  });
});

describe("Non-régression — modification de dates ADMIN générique toujours possible sans chaîne", () => {
  it("un ADMIN peut toujours raccourcir librement les dates d'un contrat ACTIVE sans chaîne (adminOverride, comportement Sprint 19 inchangé)", async () => {
    const tenant = await setupTenant("adminshorten");
    const vehicle = await createVehicle(tenant, "ADMINSHORTEN");
    const created = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(5));

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

describe("Rendu de la fiche contrat — ancien bouton retiré, formulaire administrateur masqué sur une chaîne (Sprint technique 3)", () => {
  it("un contrat ACTIVE sans chaîne affiche « Créer une prolongation » mais jamais « Prolonger la location »", async () => {
    const tenant = await setupTenant("render-nochain");
    const vehicle = await createVehicle(tenant, "RENDERNOCHAIN");
    const created = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));

    const response = await apiFetch(`/dashboard/locations/${created.id}`, {
      headers: { Cookie: tenant.admin.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Créer une prolongation");
    expect(html).not.toContain("Prolonger la location");
    expect(html).toContain("Modifier les dates");
  });

  it("un contrat parent déjà chaîné n'affiche plus le formulaire « Modifier les dates », remplacé par une explication", async () => {
    const tenant = await setupTenant("render-chain");
    const vehicle = await createVehicle(tenant, "RENDERCHAIN");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(3));
    const extendResponse = await extendLocation(tenant.admin, parent.id, { endDate: iso(daysFromNow(6)) });
    expect(extendResponse.status).toBe(201);

    const response = await apiFetch(`/dashboard/locations/${parent.id}`, {
      headers: { Cookie: tenant.admin.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("Prolonger la location");
    expect(html).not.toContain("Modifier les dates");
    expect(html).toContain("chaîne de prolongations");
    // Le contrat parent a déjà un enfant direct — le bouton de création d'une nouvelle
    // prolongation reste masqué (chaîne strictement linéaire, DOMAINRULES.md section 60 règle 3).
    expect(html).not.toContain("Créer une prolongation");
  });
});
