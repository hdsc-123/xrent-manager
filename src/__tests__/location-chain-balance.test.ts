import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

/**
 * Sprint technique 2 (DOMAINRULES.md section 60, règle 12) — affichage de la chaîne
 * contractuelle et soldes consolidés : GET /api/locations/[id]/chain (src/lib/location-chains.ts,
 * getLocationChain/getLocationBalance) et son rendu sur /dashboard/locations/[id]. Distinct de
 * location-chains.test.ts (Sprint technique 1, création de prolongations — non dupliqué ici) :
 * ce fichier couvre exclusivement la lecture (chaîne + soldes), jamais la création.
 *
 * Appelé via HTTP (comme le reste de la suite), jamais par import direct de
 * src/lib/location-chains.ts dans le process de test : ce module importe transitivement
 * src/lib/authz.ts → src/lib/auth.ts (NextAuth), dont la résolution échoue hors du process
 * `next dev` réel (Cannot find module 'next/server' depuis next-auth/lib/env.js quand chargé
 * directement par Vitest) — contrainte technique, pas un choix de conception. C'est aussi la
 * raison d'être de la route GET .../chain elle-même (voir son commentaire) : sans elle, aucune
 * assertion exacte sur des montants ne serait possible depuis ce fichier.
 */

interface BalanceTotals {
  totalInvoiced: number;
  totalPaid: number;
  totalCredited: number;
  totalRefunded: number;
  remainingBalance: number;
}

interface ChainNode {
  id: string;
  isCurrent: boolean;
  status: string;
  parentLocationId: string | null;
  balance: BalanceTotals & { currency: string; invoiceCount: number };
}

interface ChainResult {
  nodes: ChainNode[];
  parent: ChainNode | null;
  parentRestricted: boolean;
  root: ChainNode | null;
  rootRestricted: boolean;
  children: ChainNode[];
  hiddenChildrenCount: number;
  hiddenCount: number;
  consolidated: Record<string, BalanceTotals & { contractCount: number }>;
}

async function getChain(actor: AuthenticatedTestUser, locationId: string): Promise<ChainResult> {
  const response = await apiFetch(`/api/locations/${locationId}/chain`, {
    headers: { Cookie: actor.sessionCookie },
  });
  if (response.status !== 200) {
    throw new Error(`Échec de lecture de la chaîne de test (${response.status}) : ${await response.text()}`);
  }
  return (await response.json()).chain as ChainResult;
}

async function getBalance(actor: AuthenticatedTestUser, locationId: string): Promise<ChainNode["balance"]> {
  const chain = await getChain(actor, locationId);
  const node = chain.nodes.find((n) => n.id === locationId && n.isCurrent);
  if (!node) {
    throw new Error("Contrat courant introuvable dans sa propre chaîne (ne devrait jamais arriver).");
  }
  return node.balance;
}

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
    tenantName: `Loc Bal ${label} ${runId}`,
    tenantSlug: `loc-bal-${label}-${runId}`,
    name: "Admin",
    email: `admin-lb-${label}-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(admin.tenantId);

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: `Agence ${label}`, slug: `lb-agence-${label}-${runId}` }),
  });
  const agencyId = (await agencyResponse.json()).agency.id;

  const clientResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      name: `Client ${label}`,
      email: `client-lb-${label}-${runId}@test.local`,
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
      licensePlate: `LB-${Math.floor(Math.random() * 1_000_000)}-${label}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay,
      chassisNumber: `VF1LB${Math.floor(Math.random() * 1_000_000)}`,
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
    currency: string;
    status: string;
  };
}

async function createPendingLocation(tenant: Tenant, vehicleId: string, startDate: Date, endDate: Date) {
  const createResponse = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      clientId: tenant.clientId,
      startDate: iso(startDate),
      endDate: iso(endDate),
      payment: { deferred: true },
    }),
  });
  return (await createResponse.json()).location as { id: string; currency: string };
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
    body: JSON.stringify({ name: `LB-${label}-${runId}`, permissions }),
  });
  const groupId = (await groupResponse.json()).group.id;

  const member = await createAndLoginMember({
    tenantId: tenant.admin.tenantId,
    name: label,
    email: `lb-${label}-${runId}@test.local`,
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

async function getMainInvoice(tenant: Tenant, locationId: string) {
  const response = await apiFetch("/api/invoices", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ locationId }),
  });
  return (await response.json()).invoice as { id: string; totalAmount: number; currency: string };
}

async function finalizeInvoice(tenant: Tenant, invoiceId: string) {
  await apiFetch(`/api/invoices/${invoiceId}`, {
    method: "PATCH",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ status: "ISSUED" }),
  });
}

async function pay(tenant: Tenant, invoiceId: string, amount: number, method: string = "CASH") {
  const response = await apiFetch("/api/payments", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ invoiceId, amount, method }),
  });
  if (response.status !== 201) {
    throw new Error(`Échec de création du paiement de test (${response.status}) : ${await response.text()}`);
  }
  return (await response.json()).payment as { id: string };
}

async function payMixed(tenant: Tenant, invoiceId: string, lines: { amount: number; method: string }[]) {
  const response = await apiFetch("/api/payments", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ invoiceId, lines }),
  });
  if (response.status !== 201) {
    throw new Error(`Échec du paiement mixte de test (${response.status}) : ${await response.text()}`);
  }
  return response.json();
}

async function createCreditNote(tenant: Tenant, invoiceId: string, amount: number, reason: string) {
  const response = await apiFetch(`/api/invoices/${invoiceId}/credit-notes`, {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ amount, reason }),
  });
  if (response.status !== 201) {
    throw new Error(`Échec de création de l'avoir de test (${response.status}) : ${await response.text()}`);
  }
  return (await response.json()).invoice as { id: string };
}

async function refundCreditNote(tenant: Tenant, creditNoteId: string, amount: number, reason: string) {
  const response = await apiFetch(`/api/invoices/${creditNoteId}/refund`, {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ amount, reason, paymentMethod: "CASH" }),
  });
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`Échec du remboursement d'avoir de test (${response.status}) : ${await response.text()}`);
  }
  return response.json();
}

async function adminCancelInvoice(tenant: Tenant, invoiceId: string, reason: string) {
  const response = await apiFetch(`/api/invoices/${invoiceId}/admin-cancel`, {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ reason }),
  });
  if (response.status !== 200) {
    throw new Error(`Échec de l'annulation admin de test (${response.status}) : ${await response.text()}`);
  }
  return response.json();
}

async function createSupplementInvoice(tenant: Tenant, locationId: string, amount: number, supplementKey: string) {
  const response = await apiFetch("/api/invoices", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ locationId, type: "SUPPLEMENT", amount, supplementKey }),
  });
  if (response.status !== 201) {
    throw new Error(`Échec de création de la facture SUPPLEMENT de test (${response.status}) : ${await response.text()}`);
  }
  return (await response.json()).invoice as { id: string; totalAmount: number };
}

afterAll(async () => {
  for (const tenantId of createdTenantIds) {
    await prisma.location.deleteMany({ where: { tenantId } }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------------------------
// getLocationBalance — solde individuel d'un contrat
// ---------------------------------------------------------------------------------------------

describe("getLocationBalance — solde individuel d'un contrat", () => {
  it("un contrat sans paiement a un solde égal au montant facturé", async () => {
    const tenant = await setupTenant("unpaid");
    const vehicle = await createVehicle(tenant, "UNPAID", tenant.agencyId, 10000);
    const location = await createPendingLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));
    const invoice = await getMainInvoice(tenant, location.id);

    const balance = await getBalance(tenant.admin, location.id);
    expect(balance.invoiceCount).toBe(1);
    expect(balance.totalInvoiced).toBe(invoice.totalAmount);
    expect(balance.totalPaid).toBe(0);
    expect(balance.totalCredited).toBe(0);
    expect(balance.totalRefunded).toBe(0);
    expect(balance.remainingBalance).toBe(invoice.totalAmount);
  });

  it("une prolongation gratuite (pricePerDay 0) a un solde nul", async () => {
    const tenant = await setupTenant("free");
    const vehicle = await createVehicle(tenant, "FREE", tenant.agencyId, 40000);
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    const response = await extendLocation(tenant.admin, parent.id, {
      endDate: iso(daysFromNow(4)),
      pricePerDay: 0,
    });
    expect(response.status).toBe(201);
    const { location } = await response.json();

    const balance = await getBalance(tenant.admin, location.id);
    expect(balance.totalInvoiced).toBe(0);
    expect(balance.totalPaid).toBe(0);
    expect(balance.remainingBalance).toBe(0);
  });

  it("paiement partiel — solde restant = total - payé", async () => {
    const tenant = await setupTenant("partial");
    const vehicle = await createVehicle(tenant, "PARTIAL", tenant.agencyId, 10000);
    const location = await createPendingLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));
    const invoice = await getMainInvoice(tenant, location.id);
    await finalizeInvoice(tenant, invoice.id);
    await pay(tenant, invoice.id, Math.floor(invoice.totalAmount / 2));

    const balance = await getBalance(tenant.admin, location.id);
    expect(balance.totalPaid).toBe(Math.floor(invoice.totalAmount / 2));
    expect(balance.remainingBalance).toBe(invoice.totalAmount - Math.floor(invoice.totalAmount / 2));
  });

  it("paiement mixte (espèces + carte) — soldé intégralement", async () => {
    const tenant = await setupTenant("mixed");
    const vehicle = await createVehicle(tenant, "MIXED", tenant.agencyId, 10000);
    const location = await createPendingLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));
    const invoice = await getMainInvoice(tenant, location.id);
    await finalizeInvoice(tenant, invoice.id);
    const half = Math.floor(invoice.totalAmount / 2);
    await payMixed(tenant, invoice.id, [
      { amount: half, method: "CASH" },
      { amount: invoice.totalAmount - half, method: "CARD" },
    ]);

    const balance = await getBalance(tenant.admin, location.id);
    expect(balance.totalPaid).toBe(invoice.totalAmount);
    expect(balance.remainingBalance).toBe(0);
  });

  it("remise et TVA propres à une prolongation sont reflétées dans le solde", async () => {
    const tenant = await setupTenant("taxdisc");
    const vehicle = await createVehicle(tenant, "TAXDISC", tenant.agencyId, 10000);
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(1));

    const extensionEnd = new Date(new Date(parent.endDate).getTime() + 2 * DAY_MS);
    const response = await extendLocation(tenant.admin, parent.id, {
      endDate: iso(extensionEnd),
      taxRate: 1000,
      discountAmount: 5000,
    });
    expect(response.status).toBe(201);
    const { location, invoice } = await response.json();
    // 2 jours à 10000 = 20000 ; TVA 10% = 2000 ; remise 5000 ; total = 17000.
    expect(invoice.totalAmount).toBe(20000 - 5000 + 2000);

    const balance = await getBalance(tenant.admin, location.id);
    expect(balance.totalInvoiced).toBe(invoice.totalAmount);
    expect(balance.remainingBalance).toBe(invoice.totalAmount);
  });

  it("avoir (créditant intégralement un solde déjà payé) — totalCredited renseigné, solde ramené à 0", async () => {
    const tenant = await setupTenant("credit");
    const vehicle = await createVehicle(tenant, "CREDIT", tenant.agencyId, 10000);
    const location = await createPendingLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(1));
    const invoice = await getMainInvoice(tenant, location.id);
    await finalizeInvoice(tenant, invoice.id);
    await pay(tenant, invoice.id, invoice.totalAmount);

    const creditNote = await createCreditNote(tenant, invoice.id, 3000, "Geste commercial");

    const balance = await getBalance(tenant.admin, location.id);
    expect(balance.totalCredited).toBe(3000);
    // Sur-encaissement (amountPaid déjà supérieur au nouveau netAmount) : ramené à 0, jamais
    // négatif — DOMAINRULES.md section 56, comportement déjà validé de getInvoiceNetAmounts.
    expect(balance.remainingBalance).toBe(0);
    // L'avoir lui-même (type CREDIT_NOTE) n'est jamais compté comme une facture "facturée" en
    // plus — sinon totalInvoiced doublerait artificiellement le montant déjà facturé.
    expect(balance.totalInvoiced).toBe(invoice.totalAmount);
    expect(balance.invoiceCount).toBe(1);

    // Remboursement partiel de cet avoir : totalRefunded renseigné, sans toucher au reste.
    await refundCreditNote(tenant, creditNote.id, 1200, "Remboursement partiel client");
    const afterRefund = await getBalance(tenant.admin, location.id);
    expect(afterRefund.totalRefunded).toBe(1200);
    expect(afterRefund.totalCredited).toBe(3000);
    expect(afterRefund.remainingBalance).toBe(0);
  });

  it("remboursement via annulation admin d'une facture PARTIALLY_PAID — totalRefunded renseigné, amountPaid jamais réinitialisé", async () => {
    const tenant = await setupTenant("admincancel");
    const vehicle = await createVehicle(tenant, "ADMINCANCEL", tenant.agencyId, 10000);
    const location = await createPendingLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(1));
    const invoice = await getMainInvoice(tenant, location.id);
    await finalizeInvoice(tenant, invoice.id);
    await pay(tenant, invoice.id, 4000);

    await adminCancelInvoice(tenant, invoice.id, "Erreur de réservation");

    const balance = await getBalance(tenant.admin, location.id);
    // adminCancelInvoice ne réinitialise jamais amountPaid (src/lib/invoices.ts) : le paiement
    // reste compté comme "payé" tout en étant désormais également compté comme "remboursé" —
    // deux informations distinctes affichées côte à côte, jamais l'une soustraite de l'autre.
    expect(balance.totalPaid).toBe(4000);
    expect(balance.totalRefunded).toBe(4000);
    expect(balance.remainingBalance).toBe(invoice.totalAmount - 4000);
  });

  it("plusieurs factures (RENTAL + SUPPLEMENT) — sommées sans double comptage, paiements jamais croisés", async () => {
    const tenant = await setupTenant("multi");
    const vehicle = await createVehicle(tenant, "MULTI", tenant.agencyId, 10000);
    const location = await createPendingLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(1));
    const rentalInvoice = await getMainInvoice(tenant, location.id);
    await finalizeInvoice(tenant, rentalInvoice.id);
    await pay(tenant, rentalInvoice.id, 3000);

    const supplementInvoice = await createSupplementInvoice(tenant, location.id, 2000, `sup-${runId}`);
    await finalizeInvoice(tenant, supplementInvoice.id);
    await pay(tenant, supplementInvoice.id, 500);

    const balance = await getBalance(tenant.admin, location.id);
    expect(balance.invoiceCount).toBe(2);
    expect(balance.totalInvoiced).toBe(rentalInvoice.totalAmount + 2000);
    expect(balance.totalPaid).toBe(3000 + 500);
    expect(balance.remainingBalance).toBe(rentalInvoice.totalAmount - 3000 + (2000 - 500));
  });
});

// ---------------------------------------------------------------------------------------------
// getLocationChain — structure de la chaîne
// ---------------------------------------------------------------------------------------------

describe("getLocationChain — structure de la chaîne", () => {
  it("contrat INITIAL sans prolongation : chaîne vide, root et parent nuls", async () => {
    const tenant = await setupTenant("lonely");
    const vehicle = await createVehicle(tenant, "LONELY");
    const location = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    const chain = await getChain(tenant.admin, location.id);
    expect(chain.nodes).toHaveLength(1);
    expect(chain.nodes[0].isCurrent).toBe(true);
    expect(chain.parent).toBeNull();
    expect(chain.parentRestricted).toBe(false);
    expect(chain.root).toBeNull();
    expect(chain.rootRestricted).toBe(false);
    expect(chain.children).toHaveLength(0);
    expect(chain.hiddenCount).toBe(0);
  });

  it("contrat INITIAL avec une prolongation directe : parent/enfant résolus dans les deux sens", async () => {
    const tenant = await setupTenant("pair");
    const vehicle = await createVehicle(tenant, "PAIR");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));
    const extResponse = await extendLocation(tenant.admin, parent.id, { endDate: iso(daysFromNow(5)) });
    const { location: ext } = await extResponse.json();

    const parentChain = await getChain(tenant.admin, parent.id);
    expect(parentChain.nodes).toHaveLength(2);
    expect(parentChain.parent).toBeNull();
    expect(parentChain.root).toBeNull(); // le contrat courant EST déjà la racine
    expect(parentChain.children).toHaveLength(1);
    expect(parentChain.children[0].id).toBe(ext.id);

    const extChain = await getChain(tenant.admin, ext.id);
    expect(extChain.nodes).toHaveLength(2);
    expect(extChain.parent?.id).toBe(parent.id);
    expect(extChain.root?.id).toBe(parent.id);
    expect(extChain.children).toHaveLength(0);
  });

  it("chaîne de profondeur 3 : la racine reste le contrat initial depuis n'importe quel maillon", async () => {
    const tenant = await setupTenant("deep");
    const vehicle = await createVehicle(tenant, "DEEP");
    const root = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));
    const firstExtResponse = await extendLocation(tenant.admin, root.id, { endDate: iso(daysFromNow(4)) });
    const { location: firstExt } = await firstExtResponse.json();
    const secondExtResponse = await extendLocation(tenant.admin, firstExt.id, { endDate: iso(daysFromNow(6)) });
    const { location: secondExt } = await secondExtResponse.json();

    const chain = await getChain(tenant.admin, secondExt.id);

    expect(chain.nodes).toHaveLength(3);
    expect(chain.nodes.map((n) => n.id)).toEqual([root.id, firstExt.id, secondExt.id]);
    expect(chain.root?.id).toBe(root.id);
    expect(chain.parent?.id).toBe(firstExt.id);
  });

  it("isolation tenant : la chaîne d'un tenant ne contient jamais un contrat d'un autre tenant", async () => {
    const tenantA = await setupTenant("isoA2");
    const tenantB = await setupTenant("isoB2");
    const vehicleA = await createVehicle(tenantA, "ISOA2");
    const vehicleB = await createVehicle(tenantB, "ISOB2");
    const locationA = await createAndActivateLocation(tenantA, vehicleA.id, daysFromNow(0), daysFromNow(2));
    await createAndActivateLocation(tenantB, vehicleB.id, daysFromNow(0), daysFromNow(2));

    const chain = await getChain(tenantA.admin, locationA.id);

    expect(chain.nodes).toHaveLength(1);
    expect(chain.nodes[0].id).toBe(locationA.id);
  });

  it("isolation agence : un enfant d'une agence non accessible est compté mais jamais détaillé", async () => {
    const tenant = await setupTenant("hiddenchild");
    const vehicle1 = await createVehicle(tenant, "HC1", tenant.agencyId);
    const parent = await createAndActivateLocation(tenant, vehicle1.id, daysFromNow(0), daysFromNow(2));

    const otherAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ name: "Agence B", slug: `lb-hc-otherb-${runId}` }),
    });
    const otherAgencyId = (await otherAgencyResponse.json()).agency.id;

    const extResponse = await extendLocation(tenant.admin, parent.id, {
      endDate: iso(daysFromNow(5)),
      agencyId: otherAgencyId,
    });
    expect(extResponse.status).toBe(201);
    const { location: ext } = await extResponse.json();

    const memberA = await createScopedMember(tenant, "hcmembera", ["locations.view"], [tenant.agencyId]);

    const chain = await getChain(memberA, parent.id);

    expect(chain.nodes).toHaveLength(1); // uniquement le contrat courant, jamais l'enfant en agence B
    expect(chain.children).toHaveLength(0);
    expect(chain.hiddenChildrenCount).toBe(1);
    expect(chain.hiddenCount).toBe(1);
    // Aucune trace de l'identifiant/numéro du contrat caché nulle part dans la réponse.
    const serialized = JSON.stringify(chain);
    expect(serialized).not.toContain(ext.id);
  });

  it("isolation agence : un parent d'une agence non accessible est signalé restreint, jamais détaillé", async () => {
    const tenant = await setupTenant("hiddenparent");
    const vehicle1 = await createVehicle(tenant, "HP1", tenant.agencyId);
    const parent = await createAndActivateLocation(tenant, vehicle1.id, daysFromNow(0), daysFromNow(2));

    const otherAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ name: "Agence B", slug: `lb-hp-otherb-${runId}` }),
    });
    const otherAgencyId = (await otherAgencyResponse.json()).agency.id;

    const extResponse = await extendLocation(tenant.admin, parent.id, {
      endDate: iso(daysFromNow(5)),
      agencyId: otherAgencyId,
    });
    const { location: ext } = await extResponse.json();

    // memberB a accès uniquement à l'agence B (celle de l'extension), jamais à l'agence de
    // départ (celle du parent) : depuis l'extension, le parent doit apparaître restreint.
    const memberB = await createScopedMember(tenant, "hpmemberb", ["locations.view"], [otherAgencyId]);

    const chain = await getChain(memberB, ext.id);

    expect(chain.nodes).toHaveLength(1); // uniquement le contrat courant (extension)
    expect(chain.parent).toBeNull();
    expect(chain.parentRestricted).toBe(true);
    expect(chain.root).toBeNull();
    expect(chain.rootRestricted).toBe(true);
    expect(chain.hiddenCount).toBe(1);
    // parent.id lui-même peut légitimement apparaître (nodes[0].parentLocationId : un champ du
    // contrat COURANT, déjà pleinement accessible à memberB) — ce qui ne doit jamais fuiter, ce
    // sont les DÉTAILS du contrat parent caché : son numéro et le nom de son agence.
    const serialized = JSON.stringify(chain);
    expect(serialized).not.toContain(parent.contractNumber);
    expect(serialized).not.toContain("Agence hiddenparent");
  });

  it("contrat CANCELLED sans prolongation : géré sans erreur, solde égal au montant facturé non payé", async () => {
    const tenant = await setupTenant("cancelledchain");
    const vehicle = await createVehicle(tenant, "CANCELCHAIN", tenant.agencyId, 10000);
    const created = await createPendingLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));
    await apiFetch(`/api/locations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });

    const chain = await getChain(tenant.admin, created.id);

    expect(chain.nodes).toHaveLength(1);
    expect(chain.nodes[0].status).toBe("CANCELLED");
    expect(chain.nodes[0].balance.remainingBalance).toBe(chain.nodes[0].balance.totalInvoiced);
  });
});

// ---------------------------------------------------------------------------------------------
// Solde consolidé — obligatoirement égal à la somme des soldes individuels
// ---------------------------------------------------------------------------------------------

describe("Solde consolidé de la chaîne", () => {
  it("est toujours strictement égal à la somme des soldes individuels des contrats affichés", async () => {
    const tenant = await setupTenant("consolidated");
    const vehicle = await createVehicle(tenant, "CONSOL", tenant.agencyId, 10000);

    // Contrat 1 (INITIAL) : payé partiellement.
    const root = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(1));
    const rootInvoice = await getMainInvoice(tenant, root.id);
    await finalizeInvoice(tenant, rootInvoice.id);
    await pay(tenant, rootInvoice.id, 3000);

    // Contrat 2 (prolongation) : gratuit.
    const ext1Response = await extendLocation(tenant.admin, root.id, { endDate: iso(daysFromNow(2)), pricePerDay: 0 });
    const { location: ext1 } = await ext1Response.json();

    // Contrat 3 (prolongation de la prolongation) : remise + TVA, non payé.
    const ext2Response = await extendLocation(tenant.admin, ext1.id, {
      endDate: iso(daysFromNow(4)),
      taxRate: 1000,
      discountAmount: 1000,
    });
    const { location: ext2 } = await ext2Response.json();

    const chain = await getChain(tenant.admin, ext2.id);

    expect(chain.nodes).toHaveLength(3);
    expect(chain.nodes.map((n) => n.id).sort()).toEqual([root.id, ext1.id, ext2.id].sort());

    // Recalcul indépendant, directement via getLocationBalance sur chaque contrat — jamais en
    // relisant chain.consolidated (ce serait circulaire) : la somme manuelle des trois soldes
    // individuels doit être rigoureusement égale au solde consolidé retourné par la chaîne.
    const manualBalances = await Promise.all(
      [root.id, ext1.id, ext2.id].map((id) => getBalance(tenant.admin, id))
    );
    const manualSum = manualBalances.reduce(
      (acc, b) => ({
        totalInvoiced: acc.totalInvoiced + b.totalInvoiced,
        totalPaid: acc.totalPaid + b.totalPaid,
        totalCredited: acc.totalCredited + b.totalCredited,
        totalRefunded: acc.totalRefunded + b.totalRefunded,
        remainingBalance: acc.remainingBalance + b.remainingBalance,
      }),
      { totalInvoiced: 0, totalPaid: 0, totalCredited: 0, totalRefunded: 0, remainingBalance: 0 }
    );

    const consolidated = chain.consolidated.MAD;
    expect(consolidated).toBeDefined();
    expect(consolidated.contractCount).toBe(3);
    expect(consolidated.totalInvoiced).toBe(manualSum.totalInvoiced);
    expect(consolidated.totalPaid).toBe(manualSum.totalPaid);
    expect(consolidated.totalCredited).toBe(manualSum.totalCredited);
    expect(consolidated.totalRefunded).toBe(manualSum.totalRefunded);
    expect(consolidated.remainingBalance).toBe(manualSum.remainingBalance);

    // Doit aussi être égal à la somme des soldes individuels tels qu'exposés dans `nodes`
    // (ce que l'interface affiche réellement pour chaque contrat listé) — jamais une
    // soustraction globale recalculée sur l'ensemble de la chaîne (DOMAINRULES.md section 60).
    const sumFromNodes = chain.nodes.reduce((sum, node) => sum + node.balance.remainingBalance, 0);
    expect(consolidated.remainingBalance).toBe(sumFromNodes);
    expect(consolidated.remainingBalance).toBeGreaterThan(0); // non trivialement 0 partout
  });
});

// ---------------------------------------------------------------------------------------------
// Rendu de la page /dashboard/locations/[id] (chaîne + soldes)
// ---------------------------------------------------------------------------------------------

describe("Page /dashboard/locations/[id] — chaîne contractuelle", () => {
  it("affiche la chaîne, les contrats liés et le solde consolidé pour un ADMIN", async () => {
    const tenant = await setupTenant("pagehtml");
    const vehicle = await createVehicle(tenant, "PAGEHTML");
    const parent = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));
    const extResponse = await extendLocation(tenant.admin, parent.id, { endDate: iso(daysFromNow(5)) });
    const { location: ext } = await extResponse.json();

    const response = await apiFetch(`/dashboard/locations/${parent.id}`, {
      headers: { Cookie: tenant.admin.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Chaîne contractuelle");
    expect(html).toContain("Solde consolidé");
    expect(html).toContain(ext.contractNumber);
  });

  it("état vide : un contrat initial sans prolongation affiche le message dédié", async () => {
    const tenant = await setupTenant("pageempty");
    const vehicle = await createVehicle(tenant, "PAGEEMPTY");
    const location = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    const response = await apiFetch(`/dashboard/locations/${location.id}`, {
      headers: { Cookie: tenant.admin.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Ce contrat ne fait partie d");
  });

  it("refuse l'accès à la page sans la permission locations.view (gate corrigé ce sprint)", async () => {
    const tenant = await setupTenant("pagenoperm");
    const vehicle = await createVehicle(tenant, "PAGENOPERM");
    const location = await createAndActivateLocation(tenant, vehicle.id, daysFromNow(0), daysFromNow(2));

    // Groupe n'accordant explicitement aucune permission "locations.*" — accès à l'agence
    // (UserAgency) présent, ce qui aurait suffi à voir la page complète avant la correction de
    // ce sprint (canAccessLocationAgency seule ne suffisait pas à bloquer l'accès).
    const memberNoPerm = await createScopedMember(tenant, "pagenopermmember", ["clients.view"], [tenant.agencyId]);

    const response = await apiFetch(`/dashboard/locations/${location.id}`, {
      headers: { Cookie: memberNoPerm.sessionCookie },
    });
    // Correctif sprint soft 404 : le garde centralisé (src/lib/route-guards.ts, exécuté depuis
    // src/proxy.ts avant toute frontière Suspense) renvoie désormais un vrai statut HTTP 404
    // pour ce cas — plus un "soft 404" (200 + noindex). Voir SECURITY.md section 35.
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).not.toContain(location.contractNumber ?? "__none__");
    expect(html).not.toContain("Chaîne contractuelle");
  });

  it("n'expose aucune donnée d'un contrat lié d'une agence non accessible", async () => {
    const tenant = await setupTenant("pagehidden");
    const vehicle1 = await createVehicle(tenant, "PAGEHIDDEN1", tenant.agencyId);
    const parent = await createAndActivateLocation(tenant, vehicle1.id, daysFromNow(0), daysFromNow(2));

    const otherAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ name: "Agence cachée", slug: `lb-pagehidden-otherb-${runId}` }),
    });
    const otherAgencyId = (await otherAgencyResponse.json()).agency.id;

    const extResponse = await extendLocation(tenant.admin, parent.id, {
      endDate: iso(daysFromNow(5)),
      agencyId: otherAgencyId,
    });
    const { location: ext } = await extResponse.json();

    const memberA = await createScopedMember(tenant, "pagehiddenmember", ["locations.view"], [tenant.agencyId]);

    const response = await apiFetch(`/dashboard/locations/${parent.id}`, {
      headers: { Cookie: memberA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Chaîne contractuelle");
    expect(html).not.toContain(ext.contractNumber);
    expect(html).not.toContain(ext.id);
    // Compte agrégé honnête malgré l'absence de détail.
    expect(html).toContain("non accessible");
  });
});
