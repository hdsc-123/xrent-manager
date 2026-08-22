import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";
// Sprint 13E tâche 3 : @/lib/invoices n'a aucune dépendance transitive vers @/lib/authz/@/lib/auth
// (vérifié — invoices.ts → locations.ts/cash-register.ts, aucun des deux n'importe authz/auth),
// donc sûr à importer directement ici, contrairement à @/lib/authz lui-même (échouerait hors du
// serveur Next.js réel, voir helpers/http.ts et la convention déjà suivie par toute la suite).
import {
  getOrCreateMainInvoice,
  getOrCreateSupplementInvoice,
  getOrCreateExtensionInvoice,
  validateSupplementaryAmount,
  createCreditNote,
  getTotalCreditedAmount,
  InvoiceLocationNotFoundError,
  InvalidInvoiceAmountError,
  CreditNoteExceedsRemainingCreditError,
} from "@/lib/invoices";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let memberA: AuthenticatedTestUser;
let agencyAId: string;
let locationAId: string; // totalPrice = 15000 (3 jours x 5000)
let locationBId: string;
// Sprint 13E tâche 3 : promues en portée module (auparavant locales à beforeAll) pour permettre
// aux nouveaux tests getOrCreateMainInvoice de créer leurs propres locations fraîches, plutôt
// que de réutiliser locationAId/locationBId — indispensable depuis que POST /api/invoices est
// idempotent pour RENTAL (voir plus bas) : les scénarios ci-dessous ont besoin chacun d'une
// location n'ayant encore aucune facture RENTAL. Valeurs inchangées, aucun comportement modifié.
let vehicleAId: string;
let vehicleBId: string;
let clientAId: string;
let clientBId: string;

let freshLocationDateOffset = 5000; // loin de locationAId/locationBId/des autres locations codées en dur de ce fichier (2028-01/02), aucun chevauchement possible

/** Sprint 13E tâche 3 : crée une Location fraîche (jamais locationAId/locationBId), avec sa
 * propre facture RENTAL DRAFT auto-générée — indispensable depuis que POST /api/invoices est
 * idempotent pour RENTAL (au plus une facture RENTAL active par Location) : réutiliser une
 * location déjà dotée d'une facture (transitionnée par un test précédent dans ce même fichier)
 * ne créerait plus une seconde facture indépendante, ce qui casserait tout test supposant une
 * facture DRAFT fraîche. Dates dans une plage dédiée (2029+), déconnectée de celle des autres
 * locations codées en dur de ce fichier (2028-01/02).
 */
async function createFreshLocation(actor: AuthenticatedTestUser, vehicleId: string, clientId: string): Promise<string> {
  freshLocationDateOffset += 10;
  const base = new Date(Date.UTC(2029, 0, 1));
  const start = new Date(base.getTime() + freshLocationDateOffset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
  const response = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: actor.sessionCookie },
    body: JSON.stringify({ vehicleId, clientId, startDate: start.toISOString(), endDate: end.toISOString() }),
  });
  if (response.status !== 201) {
    throw new Error(`Échec de création de la location de test (${response.status}) : ${await response.text()}`);
  }
  return (await response.json()).location.id as string;
}

/** Sprint 13E tâche 3 : crée par défaut sa propre Location fraîche (jamais locationAId) —
 * POST /api/invoices étant désormais idempotent pour RENTAL, réutiliser une même location entre
 * appels indépendants ne produirait plus des factures DRAFT distinctes (voir
 * createFreshLocation ci-dessus). `overrides.locationId`, quand fourni explicitement (tests
 * d'isolation tenant/agence utilisant locationBId), est toujours respecté tel quel. */
async function createInvoice(admin: AuthenticatedTestUser, overrides: Record<string, unknown> = {}) {
  const locationId = (overrides.locationId as string | undefined) ?? (await createFreshLocation(adminA, vehicleAId, clientAId));
  return apiFetch("/api/invoices", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ ...overrides, locationId }),
  });
}

/** Finding F : un paiement ne peut être enregistré que sur une facture finalisée (SENT ou
 * au-delà, InvoiceNotFinalizedError sinon sur une facture encore DRAFT) — finalise d'abord la
 * facture avant tout paiement direct via POST /api/payments. */
async function finalizeInvoice(admin: AuthenticatedTestUser, invoiceId: string) {
  const response = await apiFetch(`/api/invoices/${invoiceId}`, {
    method: "PATCH",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ status: "ISSUED" }),
  });
  expect(response.status).toBe(200);
}

async function payInvoiceInFull(admin: AuthenticatedTestUser, invoiceId: string, amount: number) {
  await finalizeInvoice(admin, invoiceId);
  const response = await apiFetch("/api/payments", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ invoiceId, amount, method: "CASH" }),
  });
  expect(response.status).toBe(201);
}

/** Sprint 28 (Finding D2) : encaisse un paiement (facture déjà finalisée) et retourne le
 * Payment créé — contrairement à payInvoiceInFull, ne finalise pas et n'exige pas un montant
 * intégral, pour permettre plusieurs paiements successifs sur la même facture. */
async function payAmount(admin: AuthenticatedTestUser, invoiceId: string, amount: number) {
  const response = await apiFetch("/api/payments", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ invoiceId, amount, method: "CASH" }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).payment;
}

/** Sprint 28 (Finding D2) : crée une facture PARTIALLY_PAID avec un seul Payment ACTIVE
 * (totalAmount 15000 pour locationAId — un tiers laisse un solde restant, donc PARTIALLY_PAID). */
async function createPartiallyPaidInvoice(admin: AuthenticatedTestUser) {
  const createResponse = await createInvoice(admin);
  const invoice = (await createResponse.json()).invoice;
  await finalizeInvoice(admin, invoice.id);
  const payment = await payAmount(admin, invoice.id, Math.floor(invoice.totalAmount / 3));
  return { invoice, payment };
}

/** Sprint 26E : crée une facture SENT sans aucun Payment — seule éligibilité au versionnement. */
async function createSentInvoiceNoPayment(admin: AuthenticatedTestUser, overrides: Record<string, unknown> = {}) {
  const createResponse = await createInvoice(admin, overrides);
  const invoice = (await createResponse.json()).invoice;
  await finalizeInvoice(admin, invoice.id);
  return invoice;
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Invoices Test A",
    tenantSlug: `invoices-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Invoices Test B",
    tenantSlug: `invoices-test-b-${runId}`,
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

  const agencyAResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A1", slug: `agence-a1-${runId}` }),
  });
  agencyAId = (await agencyAResponse.json()).agency.id;

  const agencyBResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Agence B1", slug: `agence-b1-${runId}` }),
  });
  const agencyBId = (await agencyBResponse.json()).agency.id;

  const vehicleAResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      agencyId: agencyAId,
      name: "Clio",
      licensePlate: `INV-A-${runId}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay: 5000,
      chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
    }),
  });
  vehicleAId = (await vehicleAResponse.json()).vehicle.id;

  const vehicleBResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({
      agencyId: agencyBId,
      name: "208",
      licensePlate: `INV-B-${runId}`,
      make: "Peugeot",
      model: "208",
      year: 2022,
      category: "Citadine",
      pricePerDay: 4000,
      chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
    }),
  });
  vehicleBId = (await vehicleBResponse.json()).vehicle.id;

  const clientAResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Client A", email: `client-a-${runId}@test.local`, licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
  });
  clientAId = (await clientAResponse.json()).client.id;

  const clientBResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Client B", email: `client-b-${runId}@test.local`, licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
  });
  clientBId = (await clientBResponse.json()).client.id;

  const locationAResponse = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      vehicleId: vehicleAId,
      clientId: clientAId,
      startDate: "2028-01-10",
      endDate: "2028-01-13",
    }),
  });
  locationAId = (await locationAResponse.json()).location.id;

  const locationBResponse = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({
      vehicleId: vehicleBId,
      clientId: clientBId,
      startDate: "2028-01-10",
      endDate: "2028-01-13",
    }),
  });
  locationBId = (await locationBResponse.json()).location.id;
});

afterAll(async () => {
  // Sprint 26D (Finding D1) : ce fichier encaisse désormais de vrais paiements
  // (payInvoiceInFull) pour tester le gating DRAFT → SENT — CashEntry/CashRegister doivent
  // être purgées avant Payment/Tenant, même ordre que payments.test.ts.
  await prisma.cashEntry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashRegister.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.payment.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("POST /api/invoices", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/invoices", {
      method: "POST",
      body: JSON.stringify({ locationId: locationAId }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse une location d'un autre tenant (isolation multi-tenant)", async () => {
    const response = await createInvoice(adminA, { locationId: locationBId });
    expect(response.status).toBe(404);
  });

  it("refuse un MEMBER non rattaché à l'agence de la location", async () => {
    const response = await createInvoice(memberA);
    expect(response.status).toBe(403);
  });

  it("crée la facture DRAFT, numérotée INV-{année}-{5 chiffres}, sous-total = totalPrice de la location", async () => {
    // Sprint 13E tâche 3 : createInvoice() (helper de test) crée une Location fraîche, qui
    // auto-génère déjà sa facture RENTAL DRAFT (Sprint 12B) — l'appel POST /api/invoices qui
    // suit est donc désormais idempotent (200, facture existante retournée telle quelle), plus
    // jamais une création réelle (201) pour ce chemin. La facture elle-même (statut, sous-total,
    // devise, format du numéro) reste inchangée et intégralement vérifiée ci-dessous.
    const response = await createInvoice(adminA);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invoice.status).toBe("DRAFT");
    expect(body.invoice.subtotal).toBe(15000);
    expect(body.invoice.totalAmount).toBe(15000);
    expect(body.invoice.currency).toBe("MAD");
    expect(body.invoice.number).toMatch(/^INV-\d{4}-\d{5}$/);
  });

  it("calcule taxAmount et totalAmount à partir de taxRate (points de base) et discountAmount", async () => {
    // Sprint 13E tâche 3 : la facture RENTAL est déjà auto-générée (DRAFT, taxRate/discountAmount
    // par défaut 0) à la création de la Location — POST /api/invoices est idempotent et ignore
    // tout taxRate/discountAmount transmis dès qu'une facture RENTAL active existe déjà, ce champ
    // ne peut donc plus être vérifié à la création pour ce type. Le calcul lui-même
    // (computeInvoiceTotals) est partagé à l'identique entre createInvoice et updateInvoice — même
    // garantie exercée ici via PATCH sur la facture DRAFT fraîchement auto-générée.
    const createResponse = await createInvoice(adminA);
    const invoiceId = (await createResponse.json()).invoice.id;

    const response = await apiFetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ taxRate: 2000, discountAmount: 1000 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    // subtotal 15000, taxRate 20% => taxAmount 3000, total = 15000 - 1000 + 3000 = 17000
    expect(body.invoice.taxAmount).toBe(3000);
    expect(body.invoice.totalAmount).toBe(17000);
  });

  it("refuse une remise supérieure au sous-total + TVA", async () => {
    // Même raison que le test précédent : validateAmountInputs/computeInvoiceTotals sont
    // partagées entre créate et update — exercées ici via PATCH sur la facture DRAFT
    // auto-générée plutôt qu'à la création (devenue idempotente pour RENTAL).
    const createResponse = await createInvoice(adminA);
    const invoiceId = (await createResponse.json()).invoice.id;

    const response = await apiFetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ discountAmount: 999_999 }),
    });
    expect(response.status).toBe(400);
  });

  it("attribue des numéros de facture séquentiels distincts pour un même tenant", async () => {
    const first = await createInvoice(adminA);
    const second = await createInvoice(adminA);
    const firstNumber = (await first.json()).invoice.number;
    const secondNumber = (await second.json()).invoice.number;
    expect(firstNumber).not.toBe(secondNumber);
  });
});

describe("GET /api/invoices", () => {
  it("liste uniquement les factures du tenant connecté (isolation multi-tenant)", async () => {
    const createResponse = await createInvoice(adminA);
    const invoiceId = (await createResponse.json()).invoice.id;

    const response = await apiFetch("/api/invoices", { headers: { Cookie: adminA.sessionCookie } });
    const body = await response.json();
    const ids: string[] = body.invoices.map((i: { id: string }) => i.id);
    expect(ids).toContain(invoiceId);

    const otherTenantResponse = await apiFetch("/api/invoices", { headers: { Cookie: adminB.sessionCookie } });
    const otherBody = await otherTenantResponse.json();
    const otherIds: string[] = otherBody.invoices.map((i: { id: string }) => i.id);
    expect(otherIds).not.toContain(invoiceId);
  });

  it("filtre par statut", async () => {
    const response = await apiFetch("/api/invoices?status=DRAFT", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invoices.every((i: { status: string }) => i.status === "DRAFT")).toBe(true);
  });
});

describe("PATCH /api/invoices/[id]", () => {
  it("retourne 404 pour une facture d'un autre tenant", async () => {
    const otherResponse = await apiFetch("/api/invoices", {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({ locationId: locationBId }),
    });
    const otherInvoiceId = (await otherResponse.json()).invoice.id;

    const response = await apiFetch(`/api/invoices/${otherInvoiceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ISSUED" }),
    });
    expect(response.status).toBe(404);
  });

  // Finding F (Sprint 26F) : le gate Sprint 26D (InvoiceNotFullyPaidError) rendait SENT
  // structurellement inatteignable — recomputeInvoiceStatus (src/lib/payments.ts, Finding B,
  // inchangée) fait déjà passer une facture directement de DRAFT à PARTIALLY_PAID/PAID dès le
  // premier paiement, sans jamais s'arrêter à SENT, ce qui rendait la garde « solde intégral
  // requis » systématiquement vraie pour toute facture DRAFT. Retiré sur décision explicite du
  // propriétaire du projet : SENT signifie désormais « facture finalisée, verrouillée, en
  // attente de paiement », jamais « facture soldée » — la transition DRAFT → SENT est
  // inconditionnelle vis-à-vis du solde.
  it("Finding F — autorise DRAFT → SENT sans aucun paiement (facture finalisée, en attente de règlement)", async () => {
    const createResponse = await createInvoice(adminA);
    const invoice = (await createResponse.json()).invoice;

    const response = await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ISSUED" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invoice.status).toBe("ISSUED");
    expect(body.invoice.amountPaid).toBe(0);
  });

  it("Finding F — un paiement complet sur une facture SENT fait passer PAID", async () => {
    const createResponse = await createInvoice(adminA);
    const invoice = (await createResponse.json()).invoice;
    // payInvoiceInFull finalise (DRAFT → SENT) puis paie intégralement (SENT → PAID, dérivé).
    await payInvoiceInFull(adminA, invoice.id, invoice.totalAmount);

    const afterPayment = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    expect((await afterPayment.json()).invoice.status).toBe("PAID");

    // Une tentative de SENT après coup est refusée par la machine à états existante
    // (PAID n'a aucune transition sortante, canTransition/ALLOWED_TRANSITIONS, inchangée).
    const response = await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ISSUED" }),
    });
    expect(response.status).toBe(409);
  });

  it("Finding F — un paiement partiel sur une facture SENT fait passer PARTIALLY_PAID", async () => {
    const createResponse = await createInvoice(adminA);
    const invoice = (await createResponse.json()).invoice;
    // payInvoiceInFull finalise (DRAFT → SENT) puis paie partiellement (SENT → PARTIALLY_PAID).
    await payInvoiceInFull(adminA, invoice.id, Math.floor(invoice.totalAmount / 2));

    const afterPayment = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    expect((await afterPayment.json()).invoice.status).toBe("PARTIALLY_PAID");

    const response = await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ISSUED" }),
    });
    expect(response.status).toBe(409);
  });

  it("Finding F — refuse un paiement direct sur une facture encore DRAFT (non finalisée)", async () => {
    const createResponse = await createInvoice(adminA);
    const invoice = (await createResponse.json()).invoice;

    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: invoice.totalAmount, method: "CASH" }),
    });
    expect(response.status).toBe(409);
    const responseBody = await response.json();
    expect(responseBody.error).toMatch(/finalis/i);

    const unchanged = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    const unchangedBody = await unchanged.json();
    expect(unchangedBody.invoice.status).toBe("DRAFT");
    expect(unchangedBody.invoice.amountPaid).toBe(0);
  });

  it("refuse une transition manuelle vers PARTIALLY_PAID/PAID (dérivées des paiements)", async () => {
    const createResponse = await createInvoice(adminA);
    const invoiceId = (await createResponse.json()).invoice.id;

    const response = await apiFetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "PAID" }),
    });
    expect(response.status).toBe(409);
  });

  it("refuse de modifier taxRate/discountAmount après DRAFT", async () => {
    const createResponse = await createInvoice(adminA);
    const invoice = (await createResponse.json()).invoice;
    // payInvoiceInFull finalise (DRAFT → SENT) puis paie intégralement (SENT → PAID) —
    // suffisant pour quitter DRAFT et exercer la garde testée ici (InvoiceNotEditableError,
    // inchangée : non éditable dès SENT, pas seulement à partir de PAID).
    await payInvoiceInFull(adminA, invoice.id, invoice.totalAmount);

    const response = await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ taxRate: 1000 }),
    });
    expect(response.status).toBe(409);
  });

  it("Sprint 18 — une facture à 0 (remise intégrale) passe directement PAID à l'envoi, sans paiement", async () => {
    // subtotal 15000, discountAmount 15000, taxRate par défaut 0 => totalAmount 0. Sprint 13E
    // tâche 3 : la facture RENTAL DRAFT est déjà auto-générée à la création de la Location
    // (POST /api/invoices idempotent ne peut plus accepter discountAmount à la création) — la
    // remise intégrale est donc appliquée par un PATCH DRAFT préalable (même
    // computeInvoiceTotals que createInvoice, voir les deux tests précédents) avant l'envoi.
    const createResponse = await createInvoice(adminA);
    const invoiceId = (await createResponse.json()).invoice.id;
    const discountResponse = await apiFetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ discountAmount: 15000 }),
    });
    expect(discountResponse.status).toBe(200);
    expect((await discountResponse.json()).invoice.totalAmount).toBe(0);

    const response = await apiFetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ISSUED" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invoice.totalAmount).toBe(0);
    expect(body.invoice.amountPaid).toBe(0);
    expect(body.invoice.status).toBe("PAID");
  });
});

describe("POST /api/invoices/[id]/admin-cancel — Sprint 28 (Finding D2)", () => {
  it("refuse une requête non authentifiée", async () => {
    const { invoice } = await createPartiallyPaidInvoice(adminA);
    const response = await apiFetch(`/api/invoices/${invoice.id}/admin-cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "Erreur de facturation" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un utilisateur non ADMIN (403)", async () => {
    const { invoice } = await createPartiallyPaidInvoice(adminA);
    const response = await apiFetch(`/api/invoices/${invoice.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: memberA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur de facturation" }),
    });
    expect(response.status).toBe(403);

    const unchanged = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    expect((await unchanged.json()).invoice.status).toBe("PARTIALLY_PAID");
  });

  it("refuse un motif absent (400)", async () => {
    const { invoice } = await createPartiallyPaidInvoice(adminA);
    const response = await apiFetch(`/api/invoices/${invoice.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it("refuse un motif vide/blanc (400)", async () => {
    const { invoice } = await createPartiallyPaidInvoice(adminA);
    const response = await apiFetch(`/api/invoices/${invoice.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "   " }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse une facture PAID (409)", async () => {
    const createResponse = await createInvoice(adminA);
    const invoice = (await createResponse.json()).invoice;
    await payInvoiceInFull(adminA, invoice.id, invoice.totalAmount);

    const response = await apiFetch(`/api/invoices/${invoice.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur de facturation" }),
    });
    expect(response.status).toBe(409);

    const unchanged = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    expect((await unchanged.json()).invoice.status).toBe("PAID");
  });

  it("refuse une facture DRAFT (409, statut non concerné)", async () => {
    const createResponse = await createInvoice(adminA);
    const invoice = (await createResponse.json()).invoice;

    const response = await apiFetch(`/api/invoices/${invoice.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur de facturation" }),
    });
    expect(response.status).toBe(409);
  });

  it("refuse une facture SENT sans paiement (409, statut non concerné — s'annule directement via PATCH)", async () => {
    const invoice = await createSentInvoiceNoPayment(adminA);

    const response = await apiFetch(`/api/invoices/${invoice.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur de facturation" }),
    });
    expect(response.status).toBe(409);
  });

  it("annulation SENT sans paiement inchangée : PATCH direct fonctionne toujours, sans compensation ni exigence ADMIN", async () => {
    const invoice = await createSentInvoiceNoPayment(adminA);

    const response = await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "VOID" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).invoice.status).toBe("VOID");

    const cashEntries = await prisma.cashEntry.findMany({ where: { tenantId: adminA.tenantId, category: "ANNULATION_FACTURE" } });
    expect(cashEntries).toHaveLength(0);
  });

  it("PATCH /api/invoices/[id] refuse PARTIALLY_PAID → CANCELLED (403) et indique la route dédiée", async () => {
    const { invoice } = await createPartiallyPaidInvoice(adminA);

    const response = await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "VOID" }),
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/admin-cancel/);

    const unchanged = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    expect((await unchanged.json()).invoice.status).toBe("PARTIALLY_PAID");
  });

  it("ADMIN annule une facture PARTIALLY_PAID : statut CANCELLED, Payment ACTIVE passé REFUNDED, CashEntry de compensation créée, audit journalisé", async () => {
    const { invoice, payment } = await createPartiallyPaidInvoice(adminA);

    const originalEntry = await prisma.cashEntry.findFirst({ where: { paymentId: payment.id, parentEntryId: null } });
    expect(originalEntry).not.toBeNull();

    const response = await apiFetch(`/api/invoices/${invoice.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur de facturation, remboursement client hors application" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invoice.status).toBe("VOID");
    expect(body.reversedPaymentCount).toBe(1);
    expect(body.reversedAmountTotal).toBe(payment.amount);

    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentAfter.status).toBe("REFUNDED");
    // Sprint 28 (Finding D2) : une compensation ne rejoue jamais amount/method/paidAt du
    // Payment — seul son status change (même invariant que le Finding D1).
    expect(paymentAfter.amount).toBe(payment.amount);
    expect(paymentAfter.method).toBe(payment.method);

    const compensationEntry = await prisma.cashEntry.findFirst({
      where: { paymentId: payment.id, parentEntryId: originalEntry!.id },
    });
    expect(compensationEntry).not.toBeNull();
    expect(compensationEntry!.type).toBe("EXPENSE");
    expect(compensationEntry!.category).toBe("ANNULATION_FACTURE");
    expect(compensationEntry!.amount).toBe(payment.amount);
    expect(compensationEntry!.reason).toContain("Erreur de facturation");
    expect(compensationEntry!.performedByUserId).toBe(adminA.userId);

    const auditLog = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, action: "invoice.admin_cancelled", resourceId: invoice.id },
    });
    expect(auditLog).not.toBeNull();
    expect((auditLog!.metadata as Record<string, unknown>).reason).toContain("Erreur de facturation");
  });

  it("ignore un Payment déjà REFUNDED (ne le compense pas une seconde fois) et compense uniquement les Payment ACTIVE", async () => {
    const { invoice, payment: firstPayment } = await createPartiallyPaidInvoice(adminA);
    const secondPayment = await payAmount(adminA, invoice.id, Math.floor(invoice.totalAmount / 3));

    // Force directement en base un état REFUNDED préexistant sur le premier paiement — jamais
    // atteignable via l'API sur une facture encore PARTIALLY_PAID en usage normal (un Payment
    // REFUNDED implique aujourd'hui toujours une facture déjà CANCELLED via
    // adminCancelValidatedLocation) : vérifie la défense en profondeur de la requête
    // `status: "ACTIVE"` plutôt qu'un simple test heureux.
    await prisma.payment.update({ where: { id: firstPayment.id }, data: { status: "REFUNDED" } });
    const entriesBefore = await prisma.cashEntry.count({ where: { paymentId: firstPayment.id } });

    const response = await apiFetch(`/api/invoices/${invoice.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur de facturation" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reversedPaymentCount).toBe(1);
    expect(body.reversedAmountTotal).toBe(secondPayment.amount);

    // Le Payment déjà REFUNDED n'a reçu aucune compensation supplémentaire.
    const entriesAfter = await prisma.cashEntry.count({ where: { paymentId: firstPayment.id } });
    expect(entriesAfter).toBe(entriesBefore);

    const secondPaymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: secondPayment.id } });
    expect(secondPaymentAfter.status).toBe("REFUNDED");
  });

  it("rollback complet si une compensation échoue en cours de boucle : statut facture, Payment et CashEntry tous inchangés", async () => {
    const { invoice, payment: firstPayment } = await createPartiallyPaidInvoice(adminA);
    const secondPayment = await payAmount(adminA, invoice.id, Math.floor(invoice.totalAmount / 3));

    // Corrompt directement en base le montant du second Payment (jamais atteignable via l'API,
    // qui refuse tout montant <= 0) pour forcer InvalidCashEntryAmountError au moment de la
    // compensation de cette ligne, après que la première ligne a déjà été traitée dans la même
    // transaction — vérifie que Prisma défait bien l'intégralité de la transaction, pas
    // seulement l'itération en échec.
    await prisma.payment.update({ where: { id: secondPayment.id }, data: { amount: 0 } });

    const response = await apiFetch(`/api/invoices/${invoice.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur de facturation" }),
    });
    expect(response.status).toBe(500);

    const invoiceAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(invoiceAfter.status).toBe("PARTIALLY_PAID");

    const firstPaymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: firstPayment.id } });
    expect(firstPaymentAfter.status).toBe("ACTIVE");

    const compensationEntries = await prisma.cashEntry.count({ where: { category: "ANNULATION_FACTURE", paymentId: { in: [firstPayment.id, secondPayment.id] } } });
    expect(compensationEntries).toBe(0);
  });

  it("n'affecte pas adminCancelValidatedLocation (Sprint 23/26D) : l'annulation ADMIN d'un contrat validé fonctionne toujours normalement", async () => {
    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId: agencyAId,
        name: "Twingo",
        licensePlate: `INV-D2-REG-${runId}`,
        make: "Renault",
        model: "Twingo",
        year: 2022,
        category: "Citadine",
        pricePerDay: 3000,
        chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
        color: "Blanc",
        doors: 5,
        seats: 5,
        horsepower: 5,
        powerKW: 55,
        engineSize: 1.0,
      }),
    });
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const clientResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: "Client Régression D2",
        email: `client-d2-reg-${runId}@test.local`,
        licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01",
      }),
    });
    const clientId = (await clientResponse.json()).client.id;

    const locationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId, clientId, startDate: "2028-02-10", endDate: "2028-02-13" }),
    });
    const locationId = (await locationResponse.json()).location.id;

    await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const cancelResponse = await apiFetch(`/api/locations/${locationId}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Régression Sprint 28 — non-affectation de adminCancelValidatedLocation" }),
    });
    expect(cancelResponse.status).toBe(200);
    const cancelBody = await cancelResponse.json();
    expect(cancelBody.location.status).toBe("CANCELLED");
  });
});

describe("DELETE /api/invoices/[id]", () => {
  it("supprime une facture DRAFT", async () => {
    const createResponse = await createInvoice(adminA);
    const invoiceId = (await createResponse.json()).invoice.id;

    const response = await apiFetch(`/api/invoices/${invoiceId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("refuse la suppression d'une facture payée (non-DRAFT)", async () => {
    const createResponse = await createInvoice(adminA);
    const invoice = (await createResponse.json()).invoice;
    // Sprint 26D (Finding D1) : voir le commentaire équivalent ci-dessus (PATCH) — un
    // paiement complet suffit à quitter DRAFT (directement vers PAID).
    await payInvoiceInFull(adminA, invoice.id, invoice.totalAmount);

    const response = await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(409);
  });
});

describe("GET /api/invoices/[id]/pdf", () => {
  it("génère le PDF de la facture (Sprint 14B : inclut désormais le numéro de contrat)", async () => {
    const createResponse = await createInvoice(adminA);
    const invoiceId = (await createResponse.json()).invoice.id;

    const response = await apiFetch(`/api/invoices/${invoiceId}/pdf`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });

  it("refuse l'accès à la facture d'un autre tenant", async () => {
    const createResponse = await createInvoice(adminA);
    const invoiceId = (await createResponse.json()).invoice.id;

    const response = await apiFetch(`/api/invoices/${invoiceId}/pdf`, {
      headers: { Cookie: adminB.sessionCookie },
    });
    expect(response.status).toBe(404);
  });
});

describe("Sprint 15 — permissions granulaires (invoices.create)", () => {
  it("refuse un MEMBER rattaché à l'agence mais dont le groupe personnalisé n'a pas invoices.create", async () => {
    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoInvoiceCreate-${runId}`, permissions: ["invoices.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Member",
      email: `restricted-invoices-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: restrictedMember.userId, agencyId: agencyAId } });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const response = await createInvoice(restrictedMember);
    expect(response.status).toBe(403);
  });

  it("autorise un MEMBER dont le groupe personnalisé accorde invoices.create", async () => {
    const grantedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `WithInvoiceCreate-${runId}`, permissions: ["invoices.view", "invoices.create"] }),
    });
    const grantedGroupId = (await grantedGroupResponse.json()).group.id;

    const grantedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Granted Member",
      email: `granted-invoices-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: grantedMember.userId, agencyId: agencyAId } });
    await apiFetch(`/api/users/${grantedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: grantedGroupId }),
    });

    // Sprint 13E tâche 3 : createInvoice() (helper de test) crée d'abord une Location fraîche
    // (comme admin A), qui auto-génère déjà sa facture RENTAL DRAFT — l'appel POST /api/invoices
    // de grantedMember qui suit est donc structurellement idempotent (200), jamais 201, quel que
    // soit l'acteur. Ce qui est réellement vérifié ici (accès autorisé, pas 403) reste intact.
    const response = await createInvoice(grantedMember);
    expect(response.status).toBe(200);
  });

  it("un ADMIN crée une facture même rattaché à un groupe personnalisé vide (bypass systématique)", async () => {
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
      // Sprint 13E tâche 3 : même raison que le test précédent — la Location fraîche créée par
      // createInvoice() a déjà sa facture RENTAL DRAFT auto-générée, l'appel devient idempotent
      // (200). Ce qui est vérifié ici (le bypass ADMIN fonctionne, pas de 403) reste intact.
      const response = await createInvoice(adminA);
      expect(response.status).toBe(200);
    } finally {
      await apiFetch(`/api/users/${adminA.userId}/permissions`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ permissionGroupId: null }),
      });
    }
  });
});

describe("POST /api/invoices/[id]/versions — Sprint 26E (versionnement documentaire)", () => {
  it("refuse une requête non authentifiée", async () => {
    const invoice = await createSentInvoiceNoPayment(adminA);
    const response = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ reason: "Erreur de TVA" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un motif vide", async () => {
    const invoice = await createSentInvoiceNoPayment(adminA);
    const response = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "   " }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse une facture d'un autre tenant (isolation multi-tenant)", async () => {
    const otherResponse = await apiFetch("/api/invoices", {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({ locationId: locationBId }),
    });
    const otherInvoice = (await otherResponse.json()).invoice;
    await finalizeInvoice(adminB, otherInvoice.id);

    const response = await apiFetch(`/api/invoices/${otherInvoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur de TVA" }),
    });
    expect(response.status).toBe(404);
  });

  it("refuse depuis DRAFT (pas encore finalisée)", async () => {
    const createResponse = await createInvoice(adminA);
    const invoice = (await createResponse.json()).invoice;

    const response = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur de TVA" }),
    });
    expect(response.status).toBe(409);
  });

  it("refuse depuis PARTIALLY_PAID", async () => {
    const createResponse = await createInvoice(adminA);
    const invoice = (await createResponse.json()).invoice;
    await payInvoiceInFull(adminA, invoice.id, Math.floor(invoice.totalAmount / 2));

    const response = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur de TVA" }),
    });
    expect(response.status).toBe(409);
  });

  it("refuse depuis PAID", async () => {
    const createResponse = await createInvoice(adminA);
    const invoice = (await createResponse.json()).invoice;
    await payInvoiceInFull(adminA, invoice.id, invoice.totalAmount);

    const response = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur de TVA" }),
    });
    expect(response.status).toBe(409);
  });

  it("refuse depuis CANCELLED", async () => {
    const invoice = await createSentInvoiceNoPayment(adminA);
    await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "VOID" }),
    });

    const response = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur de TVA" }),
    });
    expect(response.status).toBe(409);
  });

  it("crée une nouvelle version DRAFT numérotée -AV1 ; l'ancienne facture passe CANCELLED", async () => {
    const invoice = await createSentInvoiceNoPayment(adminA, { taxRate: 2000, discountAmount: 1000 });

    const response = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur de TVA" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();

    expect(body.invoice.status).toBe("DRAFT");
    expect(body.invoice.number).toBe(`${invoice.number}-AV1`);
    expect(body.invoice.versionNumber).toBe(2);
    expect(body.invoice.replacesInvoiceId).toBe(invoice.id);
    expect(body.invoice.rootInvoiceId).toBe(invoice.id);
    // Montants copiés à l'identique — aucune modification indirecte.
    expect(body.invoice.subtotal).toBe(invoice.subtotal);
    expect(body.invoice.taxRate).toBe(invoice.taxRate);
    expect(body.invoice.discountAmount).toBe(invoice.discountAmount);
    expect(body.invoice.taxAmount).toBe(invoice.taxAmount);
    expect(body.invoice.totalAmount).toBe(invoice.totalAmount);
    expect(body.invoice.amountPaid).toBe(0);
    expect(body.invoice.locationId).toBe(invoice.locationId);
    expect(body.invoice.clientId).toBe(invoice.clientId);
    expect(body.invoice.agencyId).toBe(invoice.agencyId);
    expect(body.invoice.currency).toBe(invoice.currency);

    expect(body.replacedInvoice.id).toBe(invoice.id);
    expect(body.replacedInvoice.status).toBe("VOID");
    // Sens inverse déjà couvert par body.invoice.replacesInvoiceId ci-dessus (relation 1:1 —
    // aucune colonne physique dupliquée sur l'ancienne facture, voir prisma/schema.prisma) et
    // par le test dédié « GET .../versions retourne l'historique complet » plus bas.

    const oldAfter = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    expect((await oldAfter.json()).invoice.status).toBe("VOID");
  });

  it("chaîne linéaire illimitée : une deuxième version obtient -AV2, rootInvoiceId toujours la racine", async () => {
    const invoice = await createSentInvoiceNoPayment(adminA);

    const v2Response = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Première correction" }),
    });
    const v2 = (await v2Response.json()).invoice;
    await finalizeInvoice(adminA, v2.id);

    const v3Response = await apiFetch(`/api/invoices/${v2.id}/versions`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Deuxième correction" }),
    });
    expect(v3Response.status).toBe(201);
    const v3 = (await v3Response.json()).invoice;
    expect(v3.number).toBe(`${invoice.number}-AV2`);
    expect(v3.versionNumber).toBe(3);
    expect(v3.rootInvoiceId).toBe(invoice.id);
    expect(v3.replacesInvoiceId).toBe(v2.id);
  });

  it("concurrence : une seule création concurrente réussit (201), l'autre reçoit 409", async () => {
    const invoice = await createSentInvoiceNoPayment(adminA);

    const [r1, r2] = await Promise.all([
      apiFetch(`/api/invoices/${invoice.id}/versions`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ reason: "Concurrence 1" }),
      }),
      apiFetch(`/api/invoices/${invoice.id}/versions`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ reason: "Concurrence 2" }),
      }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);

    const versions = await prisma.invoice.findMany({ where: { replacesInvoiceId: invoice.id } });
    expect(versions.length).toBe(1);
  });

  it("une facture née d'un versionnement n'est jamais supprimable, même DRAFT sans paiement", async () => {
    const invoice = await createSentInvoiceNoPayment(adminA);
    const versionResponse = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Motif" }),
    });
    const newInvoice = (await versionResponse.json()).invoice;

    const deleteResponse = await apiFetch(`/api/invoices/${newInvoice.id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(409);
  });

  it("audit : une entrée invoice.versioned journalisée avec le motif et les deux factures", async () => {
    const invoice = await createSentInvoiceNoPayment(adminA);
    const response = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Motif audité" }),
    });
    const newInvoice = (await response.json()).invoice;

    const logs = await prisma.auditLog.findMany({
      where: { tenantId: adminA.tenantId, action: "invoice.versioned", resourceId: invoice.id },
    });
    expect(logs.length).toBe(1);
    const metadata = logs[0].metadata as Record<string, unknown>;
    expect(metadata.reason).toBe("Motif audité");
    expect(metadata.reasonCode).toBe("FACTURE_VERSIONNEE");
    expect(metadata.newInvoiceId).toBe(newInvoice.id);
  });

  it("GET /api/invoices/[id]/versions retourne l'historique complet, trié par versionNumber croissant", async () => {
    const invoice = await createSentInvoiceNoPayment(adminA);
    const v2Response = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Motif" }),
    });
    const v2 = (await v2Response.json()).invoice;

    const historyResponse = await apiFetch(`/api/invoices/${v2.id}/versions`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(historyResponse.status).toBe(200);
    const body = await historyResponse.json();
    expect(body.history.map((i: { id: string }) => i.id)).toEqual([invoice.id, v2.id]);
  });

  it("le PDF d'une version affiche 200 (Version N / facture remplacée)", async () => {
    const invoice = await createSentInvoiceNoPayment(adminA);
    const v2Response = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Motif" }),
    });
    const v2 = (await v2Response.json()).invoice;

    const pdfResponse = await apiFetch(`/api/invoices/${v2.id}/pdf`, { headers: { Cookie: adminA.sessionCookie } });
    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers.get("content-type")).toBe("application/pdf");
  });
});

describe("Sprint 26E — permissions granulaires (invoices.version)", () => {
  it("refuse un MEMBER rattaché à l'agence mais dont le groupe personnalisé n'a pas invoices.version", async () => {
    const invoice = await createSentInvoiceNoPayment(adminA);

    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoVersion-${runId}`, permissions: ["invoices.view", "invoices.edit"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Version Member",
      email: `restricted-version-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: restrictedMember.userId, agencyId: agencyAId } });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const response = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: restrictedMember.sessionCookie },
      body: JSON.stringify({ reason: "Motif" }),
    });
    expect(response.status).toBe(403);
  });

  it("autorise un MEMBER dont le groupe personnalisé accorde invoices.version", async () => {
    const invoice = await createSentInvoiceNoPayment(adminA);

    const grantedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `WithVersion-${runId}`, permissions: ["invoices.view", "invoices.version"] }),
    });
    const grantedGroupId = (await grantedGroupResponse.json()).group.id;

    const grantedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Granted Version Member",
      email: `granted-version-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: grantedMember.userId, agencyId: agencyAId } });
    await apiFetch(`/api/users/${grantedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: grantedGroupId }),
    });

    const response = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: grantedMember.sessionCookie },
      body: JSON.stringify({ reason: "Motif" }),
    });
    expect(response.status).toBe(201);
  });
});

describe("Sprint 26E — non-régression : annulation ADMIN d'un contrat après versionnement de sa facture", () => {
  it("adminCancelValidatedLocation reste correcte (v1 déjà CANCELLED exclue, v2 DRAFT non affectée, aucun crash)", async () => {
    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId: agencyAId,
        name: "208 Versioning",
        licensePlate: `INV-VER-${runId}`,
        make: "Peugeot",
        model: "208",
        year: 2023,
        category: "Citadine",
        pricePerDay: 4500,
        chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
        color: "Noir",
        doors: 5,
        seats: 5,
        horsepower: 6,
        powerKW: 75,
        engineSize: 1.5,
      }),
    });
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const clientResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: "Client Versioning",
        email: `client-versioning-${runId}@test.local`,
        licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01",
      }),
    });
    const clientId = (await clientResponse.json()).client.id;

    const locationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId, clientId, startDate: "2028-02-10", endDate: "2028-02-13" }),
    });
    const location = (await locationResponse.json()).location;

    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const invoice = await createSentInvoiceNoPayment(adminA, { locationId: location.id });
    const versionResponse = await apiFetch(`/api/invoices/${invoice.id}/versions`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Correction avant annulation" }),
    });
    const newInvoice = (await versionResponse.json()).invoice;

    const cancelResponse = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Annulation ADMIN après versionnement" }),
    });
    expect(cancelResponse.status).toBe(200);
    const cancelBody = await cancelResponse.json();
    // Ni v1 (déjà CANCELLED par le versionnement) ni v2 (DRAFT, amountPaid 0) ne qualifient
    // pour la boucle de réversibilité financière d'adminCancelValidatedLocation — comportement
    // inchangé, aucune modification de src/lib/locations.ts nécessaire pour ce sprint.
    expect(cancelBody.cancelledInvoiceCount).toBe(0);
    expect(cancelBody.reversedPaymentCount).toBe(0);

    const oldInvoiceAfter = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    const oldInvoiceBody = (await oldInvoiceAfter.json()).invoice;
    expect(oldInvoiceBody.status).toBe("VOID");
    // Sens inverse (old → new) déjà couvert par newInvoiceBody.replacesInvoiceId ci-dessous —
    // relation 1:1 réelle, aucune colonne physique dupliquée sur l'ancienne facture.

    const newInvoiceAfter = await apiFetch(`/api/invoices/${newInvoice.id}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const newInvoiceBody = (await newInvoiceAfter.json()).invoice;
    expect(newInvoiceBody.status).toBe("DRAFT");
    expect(newInvoiceBody.replacesInvoiceId).toBe(invoice.id);

    const locationAfter = await apiFetch(`/api/locations/${location.id}`, { headers: { Cookie: adminA.sessionCookie } });
    expect((await locationAfter.json()).location.status).toBe("CANCELLED");
  });
});

/**
 * Sprint 13E tâche 3 — getOrCreateMainInvoice : au plus une facture RENTAL active par Location.
 * Chaque scénario crée sa propre Location fraîche (jamais locationAId/locationBId ci-dessus) :
 * depuis que POST /api/invoices est idempotent pour RENTAL, réutiliser une location déjà dotée
 * d'une facture (auto-générée par POST /api/locations, ou transitionnée par un test précédent)
 * ne créerait plus une seconde facture indépendante — c'est précisément le comportement que
 * cette tâche implémente, pas un défaut à contourner ici.
 */
describe("getOrCreateMainInvoice — facture RENTAL unique par Location (Sprint 13E tâche 3)", () => {
  // createFreshLocation est désormais définie au niveau module (voir plus haut, réutilisée par
  // createInvoice) — plus de définition locale dupliquée ici.

  it("POST /api/locations auto-génère exactement une facture RENTAL DRAFT", async () => {
    const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
    const invoices = await prisma.invoice.findMany({ where: { locationId } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].type).toBe("RENTAL");
    expect(invoices[0].status).toBe("DRAFT");
  });

  it("deux appels séquentiels POST /api/invoices sur la même location retournent le même id — aucun doublon", async () => {
    const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
    const auto = await prisma.invoice.findMany({ where: { locationId, type: "RENTAL" } });
    expect(auto).toHaveLength(1);
    const autoInvoiceId = auto[0].id;

    const first = await apiFetch("/api/invoices", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ locationId }),
    });
    expect(first.status).toBe(200);
    expect((await first.json()).invoice.id).toBe(autoInvoiceId);

    const second = await apiFetch("/api/invoices", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ locationId }),
    });
    expect(second.status).toBe(200);
    expect((await second.json()).invoice.id).toBe(autoInvoiceId);

    const allRental = await prisma.invoice.findMany({ where: { locationId, type: "RENTAL" } });
    expect(allRental).toHaveLength(1);
  });

  it("deux appels directs concurrents (Promise.all, jamais une course HTTP) retournent le même id, une seule ligne créée", async () => {
    const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
    // Repart d'une Location sans aucune facture RENTAL, pour exercer réellement la branche
    // "création" sous concurrence (jamais seulement sa branche "déjà existante").
    await prisma.invoice.deleteMany({ where: { locationId, type: "RENTAL" } });

    const [resultA, resultB] = await Promise.all([
      getOrCreateMainInvoice(adminA.tenantId, locationId),
      getOrCreateMainInvoice(adminA.tenantId, locationId),
    ]);

    expect(resultA.invoice.id).toBe(resultB.invoice.id);
    // Exactement un des deux appels a réellement créé la facture — jamais les deux, jamais aucun.
    expect([resultA.created, resultB.created].filter(Boolean)).toHaveLength(1);

    const allRental = await prisma.invoice.findMany({ where: { locationId, type: "RENTAL" } });
    expect(allRental).toHaveLength(1);
  });

  it("une facture SUPPLEMENT ou EXTENSION déjà présente n'empêche pas la récupération de la RENTAL", async () => {
    const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);

    // Sprint 13E tâche 3, sous-phase 2b : createSupplementInvoice/createExtensionInvoice
    // existent désormais (src/lib/invoices.ts) — utilisées ici plutôt qu'une insertion brute,
    // qui échouerait de toute façon contre Invoice_supplement_extension_fields_consistency
    // (supplementKey/extensionEndDate obligatoires selon le type, migration 2b).
    await getOrCreateSupplementInvoice(adminA.tenantId, locationId, "PRE_EXISTING_SUPPLEMENT", { amount: 1000 });
    await getOrCreateExtensionInvoice(adminA.tenantId, locationId, new Date("2032-01-01T00:00:00.000Z"), {
      amount: 500,
    });

    const response = await apiFetch("/api/invoices", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ locationId }),
    });
    expect(response.status).toBe(200); // récupère la RENTAL auto-générée par POST /api/locations
    expect((await response.json()).invoice.type).toBe("RENTAL");

    const rentalInvoices = await prisma.invoice.findMany({ where: { locationId, type: "RENTAL" } });
    expect(rentalInvoices).toHaveLength(1);
    const allInvoices = await prisma.invoice.findMany({ where: { locationId } });
    expect(allInvoices).toHaveLength(3); // RENTAL + SUPPLEMENT + EXTENSION, coexistent sans conflit
  });

  it("isolation tenant : un tenantId erroné ne peut jamais voir/créer la facture RENTAL d'une location d'un autre tenant", async () => {
    const locationAFresh = await createFreshLocation(adminA, vehicleAId, clientAId);
    const locationBFresh = await createFreshLocation(adminB, vehicleBId, clientBId);

    const { invoice: invoiceA } = await getOrCreateMainInvoice(adminA.tenantId, locationAFresh);
    const { invoice: invoiceB } = await getOrCreateMainInvoice(adminB.tenantId, locationBFresh);
    expect(invoiceA.tenantId).toBe(adminA.tenantId);
    expect(invoiceB.tenantId).toBe(adminB.tenantId);
    expect(invoiceA.id).not.toBe(invoiceB.id);

    await expect(getOrCreateMainInvoice(adminB.tenantId, locationAFresh)).rejects.toThrow(InvoiceLocationNotFoundError);
    await expect(getOrCreateMainInvoice(adminA.tenantId, locationBFresh)).rejects.toThrow(InvoiceLocationNotFoundError);
  });

  it("isolation agence : un MEMBER non rattaché à l'agence de la location est refusé (403) avant toute logique de facture", async () => {
    const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
    const response = await apiFetch("/api/invoices", {
      method: "POST",
      headers: { Cookie: memberA.sessionCookie },
      body: JSON.stringify({ locationId }),
    });
    expect(response.status).toBe(403);

    // Aucune facture supplémentaire n'a pu être créée par cette tentative refusée — seule
    // l'unique facture RENTAL déjà auto-générée par POST /api/locations subsiste.
    const invoices = await prisma.invoice.findMany({ where: { locationId } });
    expect(invoices).toHaveLength(1);
  });

  it("collision P2002 sur l'index unique partiel : une création directe hors verrou est bien rejetée par PostgreSQL (protection réelle, pas seulement applicative)", async () => {
    const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
    // La facture RENTAL auto-générée par POST /api/locations existe déjà : une seconde tentative
    // de création directe (contournant délibérément getOrCreateMainInvoice, qui ne l'aurait
    // jamais tentée) doit être rejetée par l'index lui-même — preuve que la protection ne repose
    // pas uniquement sur le verrou applicatif.
    const location = await prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    // Le message d'erreur Prisma pour une violation de cet index partiel est le message
    // générique "Unique constraint failed on the fields: (`locationId`)" — le nom de l'index
    // lui-même n'apparaît jamais dans le message, seulement dans error.meta.target (vérifié
    // empiriquement). C'est donc meta.target, pas le message, qui prouve sans ambiguïté que
    // c'est bien CET index (et non @@unique([tenantId, number])) qui a rejeté l'insertion.
    let caught: unknown;
    try {
      await prisma.invoice.create({
        data: {
          tenantId: adminA.tenantId,
          agencyId: location.agencyId,
          locationId,
          clientId: location.clientId,
          number: `DIRECT-BYPASS-${runId}`,
          type: "RENTAL",
          status: "DRAFT",
          subtotal: 1000,
          totalAmount: 1000,
          currency: "MAD",
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const prismaError = caught as Prisma.PrismaClientKnownRequestError;
    expect(prismaError.code).toBe("P2002");
    expect(prismaError.meta?.target).toEqual(["locationId"]);

    // getOrCreateMainInvoice, lui, absorbe ce même type de collision de façon idempotente —
    // revérifié explicitement ici plutôt que supposé à partir du test de concurrence ci-dessus.
    const { invoice, created } = await getOrCreateMainInvoice(adminA.tenantId, locationId);
    expect(created).toBe(false);
    const allRental = await prisma.invoice.findMany({ where: { locationId, type: "RENTAL" } });
    expect(allRental).toHaveLength(1);
    expect(allRental[0].id).toBe(invoice.id);
  });

  it("non-régression de la numérotation : plusieurs factures RENTAL fraîches restent uniques et séquentielles", async () => {
    const before = await prisma.invoice.count({ where: { tenantId: adminA.tenantId } });

    const locationOne = await createFreshLocation(adminA, vehicleAId, clientAId);
    const locationTwo = await createFreshLocation(adminA, vehicleAId, clientAId);
    const locationThree = await createFreshLocation(adminA, vehicleAId, clientAId);

    const [invoiceOne, invoiceTwo, invoiceThree] = await Promise.all(
      [locationOne, locationTwo, locationThree].map(
        async (id) => (await prisma.invoice.findFirstOrThrow({ where: { locationId: id, type: "RENTAL" } })).number
      )
    );

    const numbers = [invoiceOne, invoiceTwo, invoiceThree];
    expect(new Set(numbers).size).toBe(3); // uniques
    for (const number of numbers) {
      expect(number).toMatch(/^INV-\d{4}-\d{5}$/);
    }

    const after = await prisma.invoice.count({ where: { tenantId: adminA.tenantId } });
    expect(after).toBe(before + 3);
  });
});

/**
 * Sprint 13E tâche 3, sous-phase 2b — SUPPLEMENT/EXTENSION : factures additionnelles rattachées
 * à une Location, jamais soumises à la contrainte « une seule facture active » propre à RENTAL.
 * Montant (amount) toujours explicite, fourni par l'appelant — aucune formule automatique.
 * Chaque scénario crée sa propre Location fraîche (createFreshLocation, décrite plus haut).
 */
describe("SUPPLEMENT/EXTENSION — factures additionnelles (Sprint 13E tâche 3, sous-phase 2b)", () => {
  describe("validateSupplementaryAmount (unitaire, direct — Infinity/NaN non représentables en JSON HTTP)", () => {
    it("rejette une valeur absente, non numérique, NaN, non finie, non entière, nulle ou négative ; accepte un entier positif", () => {
      const invalid = [undefined, null, "100", NaN, Infinity, -Infinity, 10.5, 0, -100];
      for (const value of invalid) {
        expect(() => validateSupplementaryAmount(value)).toThrow(InvalidInvoiceAmountError);
      }
      expect(() => validateSupplementaryAmount(1)).not.toThrow();
      expect(() => validateSupplementaryAmount(500000)).not.toThrow();
    });
  });

  describe("SUPPLEMENT", () => {
    it("création réussie via POST /api/invoices (201), montant explicite, taxRate/discountAmount réutilisent computeInvoiceTotals", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({
          locationId,
          type: "SUPPLEMENT",
          supplementKey: "EXTRA_KM",
          amount: 5000,
          taxRate: 2000,
          discountAmount: 1000,
        }),
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.invoice.type).toBe("SUPPLEMENT");
      expect(body.invoice.status).toBe("DRAFT");
      expect(body.invoice.subtotal).toBe(5000);
      // subtotal 5000, taxRate 20% => taxAmount 1000, total = 5000 - 1000 + 1000 = 5000
      expect(body.invoice.taxAmount).toBe(1000);
      expect(body.invoice.totalAmount).toBe(5000);
      expect(body.invoice.supplementKey).toBe("EXTRA_KM");
      expect(body.invoice.extensionEndDate).toBeNull();
      expect(body.invoice.number).toMatch(/^INV-\d{4}-\d{5}$/);
    });

    it("répétition du même supplementKey via POST /api/invoices est idempotente (200, même id, aucun doublon)", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const first = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "SUPPLEMENT", supplementKey: "LATE_FEE", amount: 3000 }),
      });
      expect(first.status).toBe(201);
      const firstId = (await first.json()).invoice.id;

      const second = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "SUPPLEMENT", supplementKey: "LATE_FEE", amount: 3000 }),
      });
      expect(second.status).toBe(200);
      expect((await second.json()).invoice.id).toBe(firstId);

      const all = await prisma.invoice.findMany({ where: { locationId, type: "SUPPLEMENT", supplementKey: "LATE_FEE" } });
      expect(all).toHaveLength(1);
    });

    it("normalisation de supplementKey : espaces de bord ignorés, même clé effective pour la recherche et l'insertion", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const first = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "SUPPLEMENT", supplementKey: "  SECOND_DRIVER  ", amount: 2000 }),
      });
      expect(first.status).toBe(201);
      const firstBody = await first.json();
      expect(firstBody.invoice.supplementKey).toBe("SECOND_DRIVER");

      const second = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "SUPPLEMENT", supplementKey: "SECOND_DRIVER", amount: 2000 }),
      });
      expect(second.status).toBe(200);
      expect((await second.json()).invoice.id).toBe(firstBody.invoice.id);
    });

    it("plusieurs SUPPLEMENT distincts (clés différentes) coexistent librement sur la même Location", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const keys = ["EXTRA_KM", "LATE_FEE", "SECOND_DRIVER"];
      for (const key of keys) {
        const response = await apiFetch("/api/invoices", {
          method: "POST",
          headers: { Cookie: adminA.sessionCookie },
          body: JSON.stringify({ locationId, type: "SUPPLEMENT", supplementKey: key, amount: 1000 }),
        });
        expect(response.status).toBe(201);
      }
      const all = await prisma.invoice.findMany({ where: { locationId, type: "SUPPLEMENT" } });
      expect(all).toHaveLength(3);
      expect(new Set(all.map((i) => i.supplementKey)).size).toBe(3);
    });

    it("deux appels concurrents avec la même clé (service direct, Promise.all — jamais une course HTTP) : une seule facture créée", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const [r1, r2] = await Promise.all([
        getOrCreateSupplementInvoice(adminA.tenantId, locationId, "CONCURRENT_KEY", { amount: 4000 }),
        getOrCreateSupplementInvoice(adminA.tenantId, locationId, "CONCURRENT_KEY", { amount: 4000 }),
      ]);
      expect([r1.created, r2.created].sort()).toEqual([false, true]);
      expect(r1.invoice.id).toBe(r2.invoice.id);

      const all = await prisma.invoice.findMany({ where: { locationId, type: "SUPPLEMENT", supplementKey: "CONCURRENT_KEY" } });
      expect(all).toHaveLength(1);
    });

    it("amount absent -> 400", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "SUPPLEMENT", supplementKey: "X" }),
      });
      expect(response.status).toBe(400);
    });

    it("amount nul -> 400", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "SUPPLEMENT", supplementKey: "X", amount: 0 }),
      });
      expect(response.status).toBe(400);
    });

    it("amount négatif -> 400", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "SUPPLEMENT", supplementKey: "X", amount: -500 }),
      });
      expect(response.status).toBe(400);
    });

    it("amount non entier -> 400", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "SUPPLEMENT", supplementKey: "X", amount: 10.5 }),
      });
      expect(response.status).toBe(400);
    });

    it("supplementKey absente -> 400", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "SUPPLEMENT", amount: 1000 }),
      });
      expect(response.status).toBe(400);
    });

    it("supplementKey vide/blanche -> 400", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "SUPPLEMENT", supplementKey: "   ", amount: 1000 }),
      });
      expect(response.status).toBe(400);
    });

    it("champ incompatible : extensionEndDate fourni avec type SUPPLEMENT -> 400", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({
          locationId,
          type: "SUPPLEMENT",
          supplementKey: "X",
          amount: 1000,
          extensionEndDate: new Date().toISOString(),
        }),
      });
      expect(response.status).toBe(400);
    });

    it("factures VOID exclues de l'idempotence active : un nouveau SUPPLEMENT avec la même clé peut être créé après passage manuel à VOID", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const first = await getOrCreateSupplementInvoice(adminA.tenantId, locationId, "VOID_TEST_KEY", { amount: 1000 });
      expect(first.created).toBe(true);

      // Passage à VOID directement en base — voidInvoice n'est pas implémentée à ce stade
      // (hors périmètre 2b), même idiome que les autres tests de ce fichier forçant un état non
      // encore atteignable via l'API (ex. describe admin-cancel, Payment.status REFUNDED).
      await prisma.invoice.update({ where: { id: first.invoice.id }, data: { status: "VOID" } });

      const second = await getOrCreateSupplementInvoice(adminA.tenantId, locationId, "VOID_TEST_KEY", { amount: 1500 });
      expect(second.created).toBe(true);
      expect(second.invoice.id).not.toBe(first.invoice.id);

      const all = await prisma.invoice.findMany({ where: { locationId, type: "SUPPLEMENT", supplementKey: "VOID_TEST_KEY" } });
      expect(all).toHaveLength(2);
    });

    it("isolation tenant : locationId d'un autre tenant -> 404", async () => {
      const locationBFresh = await createFreshLocation(adminB, vehicleBId, clientBId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId: locationBFresh, type: "SUPPLEMENT", supplementKey: "X", amount: 1000 }),
      });
      expect(response.status).toBe(404);
    });

    it("isolation agence : un MEMBER non rattaché à l'agence de la location est refusé (403) avant toute logique de facture", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: memberA.sessionCookie },
        body: JSON.stringify({ locationId, type: "SUPPLEMENT", supplementKey: "X", amount: 1000 }),
      });
      expect(response.status).toBe(403);
      const all = await prisma.invoice.findMany({ where: { locationId, type: "SUPPLEMENT" } });
      expect(all).toHaveLength(0);
    });
  });

  describe("EXTENSION", () => {
    it("création réussie via POST /api/invoices (201), montant explicite, taxRate/discountAmount réutilisent computeInvoiceTotals", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const targetDate = new Date("2031-03-01T00:00:00.000Z").toISOString();
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({
          locationId,
          type: "EXTENSION",
          extensionEndDate: targetDate,
          amount: 6000,
          taxRate: 1000,
          discountAmount: 500,
        }),
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.invoice.type).toBe("EXTENSION");
      expect(body.invoice.status).toBe("DRAFT");
      expect(body.invoice.subtotal).toBe(6000);
      // subtotal 6000, taxRate 10% => taxAmount 600, total = 6000 - 500 + 600 = 6100
      expect(body.invoice.taxAmount).toBe(600);
      expect(body.invoice.totalAmount).toBe(6100);
      expect(new Date(body.invoice.extensionEndDate).toISOString()).toBe(targetDate);
      expect(body.invoice.supplementKey).toBeNull();
    });

    it("répétition de la même extensionEndDate via POST /api/invoices est idempotente (200, même id, aucun doublon)", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const targetDate = new Date("2031-04-01T00:00:00.000Z").toISOString();
      const first = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "EXTENSION", extensionEndDate: targetDate, amount: 2500 }),
      });
      expect(first.status).toBe(201);
      const firstId = (await first.json()).invoice.id;

      const second = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "EXTENSION", extensionEndDate: targetDate, amount: 2500 }),
      });
      expect(second.status).toBe(200);
      expect((await second.json()).invoice.id).toBe(firstId);

      const all = await prisma.invoice.findMany({ where: { locationId, type: "EXTENSION" } });
      expect(all).toHaveLength(1);
    });

    it("plusieurs EXTENSION vers des dates cibles distinctes coexistent librement sur la même Location", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const dates = [
        new Date("2031-05-01T00:00:00.000Z").toISOString(),
        new Date("2031-05-02T00:00:00.000Z").toISOString(),
        new Date("2031-05-03T00:00:00.000Z").toISOString(),
      ];
      for (const extensionEndDate of dates) {
        const response = await apiFetch("/api/invoices", {
          method: "POST",
          headers: { Cookie: adminA.sessionCookie },
          body: JSON.stringify({ locationId, type: "EXTENSION", extensionEndDate, amount: 1000 }),
        });
        expect(response.status).toBe(201);
      }
      const all = await prisma.invoice.findMany({ where: { locationId, type: "EXTENSION" } });
      expect(all).toHaveLength(3);
    });

    it("une extension vers une date déjà existante est récupérée idempotemment (service direct)", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const targetDate = new Date("2031-06-15T00:00:00.000Z");
      const first = await getOrCreateExtensionInvoice(adminA.tenantId, locationId, targetDate, { amount: 3000 });
      expect(first.created).toBe(true);
      const second = await getOrCreateExtensionInvoice(adminA.tenantId, locationId, targetDate, { amount: 3000 });
      expect(second.created).toBe(false);
      expect(second.invoice.id).toBe(first.invoice.id);
    });

    it("deux appels concurrents vers la même date cible (service direct, Promise.all) : une seule facture créée", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const targetDate = new Date("2031-07-20T00:00:00.000Z");
      const [r1, r2] = await Promise.all([
        getOrCreateExtensionInvoice(adminA.tenantId, locationId, targetDate, { amount: 4500 }),
        getOrCreateExtensionInvoice(adminA.tenantId, locationId, targetDate, { amount: 4500 }),
      ]);
      expect([r1.created, r2.created].sort()).toEqual([false, true]);
      expect(r1.invoice.id).toBe(r2.invoice.id);

      const all = await prisma.invoice.findMany({ where: { locationId, type: "EXTENSION" } });
      expect(all).toHaveLength(1);
    });

    it("amount absent -> 400", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "EXTENSION", extensionEndDate: new Date().toISOString() }),
      });
      expect(response.status).toBe(400);
    });

    it("amount nul -> 400", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "EXTENSION", extensionEndDate: new Date().toISOString(), amount: 0 }),
      });
      expect(response.status).toBe(400);
    });

    it("amount négatif -> 400", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "EXTENSION", extensionEndDate: new Date().toISOString(), amount: -1 }),
      });
      expect(response.status).toBe(400);
    });

    it("amount non entier -> 400", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "EXTENSION", extensionEndDate: new Date().toISOString(), amount: 2.2 }),
      });
      expect(response.status).toBe(400);
    });

    it("extensionEndDate absente -> 400", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "EXTENSION", amount: 1000 }),
      });
      expect(response.status).toBe(400);
    });

    it("extensionEndDate invalide (chaîne non parseable) -> 400", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId, type: "EXTENSION", extensionEndDate: "pas-une-date", amount: 1000 }),
      });
      expect(response.status).toBe(400);
    });

    it("champ incompatible : supplementKey fourni avec type EXTENSION -> 400", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({
          locationId,
          type: "EXTENSION",
          extensionEndDate: new Date().toISOString(),
          amount: 1000,
          supplementKey: "X",
        }),
      });
      expect(response.status).toBe(400);
    });

    it("isolation tenant : locationId d'un autre tenant -> 404", async () => {
      const locationBFresh = await createFreshLocation(adminB, vehicleBId, clientBId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ locationId: locationBFresh, type: "EXTENSION", extensionEndDate: new Date().toISOString(), amount: 1000 }),
      });
      expect(response.status).toBe(404);
    });

    it("isolation agence : un MEMBER non rattaché à l'agence de la location est refusé (403) avant toute logique de facture", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        headers: { Cookie: memberA.sessionCookie },
        body: JSON.stringify({ locationId, type: "EXTENSION", extensionEndDate: new Date().toISOString(), amount: 1000 }),
      });
      expect(response.status).toBe(403);
      const all = await prisma.invoice.findMany({ where: { locationId, type: "EXTENSION" } });
      expect(all).toHaveLength(0);
    });
  });

  describe("RENTAL non affectée / validations croisées / protection de syncDraftInvoiceTotal", () => {
    it("champ incompatible : supplementKey/extensionEndDate/amount refusés avec type RENTAL (ou type absent)", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      for (const overrides of [
        { supplementKey: "X" },
        { extensionEndDate: new Date().toISOString() },
        { amount: 1000 },
      ]) {
        const response = await apiFetch("/api/invoices", {
          method: "POST",
          headers: { Cookie: adminA.sessionCookie },
          body: JSON.stringify({ locationId, ...overrides }),
        });
        expect(response.status).toBe(400);
      }
    });

    it("type invalide (CREDIT_NOTE ou toute autre valeur) -> 400, CREDIT_NOTE non exposée à ce stade", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      for (const type of ["CREDIT_NOTE", "UNKNOWN_TYPE"]) {
        const response = await apiFetch("/api/invoices", {
          method: "POST",
          headers: { Cookie: adminA.sessionCookie },
          body: JSON.stringify({ locationId, type }),
        });
        expect(response.status).toBe(400);
      }
    });

    it("la facture RENTAL d'une Location reste strictement inchangée après création de SUPPLEMENT et EXTENSION", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const rentalBefore = await prisma.invoice.findFirstOrThrow({ where: { locationId, type: "RENTAL" } });

      await getOrCreateSupplementInvoice(adminA.tenantId, locationId, "NO_IMPACT_ON_RENTAL", { amount: 1000 });
      await getOrCreateExtensionInvoice(adminA.tenantId, locationId, new Date("2031-08-01T00:00:00.000Z"), { amount: 2000 });

      const rentalAfter = await prisma.invoice.findFirstOrThrow({ where: { locationId, type: "RENTAL" } });
      expect(rentalAfter).toEqual(rentalBefore);

      const allForLocation = await prisma.invoice.findMany({ where: { locationId } });
      expect(allForLocation).toHaveLength(3); // RENTAL + SUPPLEMENT + EXTENSION
      expect(allForLocation.filter((i) => i.type === "RENTAL")).toHaveLength(1);
    });

    it("syncDraftInvoiceTotal (src/lib/locations.ts) ne resynchronise jamais une facture SUPPLEMENT/EXTENSION à la place de la RENTAL", async () => {
      const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
      const rentalBefore = await prisma.invoice.findFirstOrThrow({ where: { locationId, type: "RENTAL" } });
      expect(rentalBefore.subtotal).toBe(15000); // 3 jours x 5000 (createFreshLocation)

      // La facture SUPPLEMENT créée ensuite est plus récente (createdAt) que la RENTAL — c'est
      // précisément le scénario qui aurait fait échouer syncDraftInvoiceTotal sans le filtre
      // type: "RENTAL" (elle aurait sélectionné cette facture-ci, la plus récente, au lieu de
      // la RENTAL, lors du recalcul de totalPrice ci-dessous).
      const supplement = await getOrCreateSupplementInvoice(adminA.tenantId, locationId, "SYNC_PROTECTION_TEST", {
        amount: 7777,
      });
      expect(supplement.invoice.status).toBe("DRAFT");
      expect(supplement.invoice.createdAt.getTime()).toBeGreaterThan(rentalBefore.createdAt.getTime());

      const location = await prisma.location.findUniqueOrThrow({ where: { id: locationId } });
      const newEndDate = new Date(location.endDate.getTime() + 24 * 60 * 60 * 1000); // +1 jour
      const patchResponse = await apiFetch(`/api/locations/${locationId}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ endDate: newEndDate.toISOString() }),
      });
      expect(patchResponse.status).toBe(200);
      expect((await patchResponse.json()).location.totalPrice).toBe(20000); // 4 jours x 5000

      const rentalAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: rentalBefore.id } });
      expect(rentalAfter.subtotal).toBe(20000); // resynchronisée avec le nouveau totalPrice
      expect(rentalAfter.totalAmount).toBe(20000);

      const supplementAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: supplement.invoice.id } });
      expect(supplementAfter.subtotal).toBe(7777); // jamais touchée
      expect(supplementAfter.totalAmount).toBe(7777);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// CREDIT_NOTE (avoir) — Sprint 13E tâche 3, sous-phase 2c1
// ---------------------------------------------------------------------------------------------
// Périmètre strict, décidé explicitement par le propriétaire du projet : montant plafonné au
// cumul déjà crédité (A1), purement documentaire — jamais Payment/CashEntry modifiés, jamais de
// remboursement automatique (B1), sources RENTAL/SUPPLEMENT/EXTENSION uniquement (C2, jamais
// CREDIT_NOTE/VOID/DRAFT en source), numérotation AV-{année}-{5 chiffres} dédiée (D1), ADMIN
// strict sans nouvelle permission granulaire (E2), aucune idempotence par clé — un avoir est un
// document ponctuel, plusieurs avoirs distincts peuvent référencer la même source.

async function createRentalSourceWithStatus(
  status: "DRAFT" | "ISSUED" | "PARTIALLY_PAID" | "PAID" | "VOID"
) {
  const createResponse = await createInvoice(adminA);
  const created = (await createResponse.json()).invoice;
  if (status === "DRAFT") {
    return created;
  }
  await finalizeInvoice(adminA, created.id);
  if (status === "ISSUED") {
    return prisma.invoice.findUniqueOrThrow({ where: { id: created.id } });
  }
  if (status === "VOID") {
    const patchResponse = await apiFetch(`/api/invoices/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "VOID" }),
    });
    expect(patchResponse.status).toBe(200);
    return prisma.invoice.findUniqueOrThrow({ where: { id: created.id } });
  }
  if (status === "PARTIALLY_PAID") {
    await payAmount(adminA, created.id, Math.floor(created.totalAmount / 3));
    return prisma.invoice.findUniqueOrThrow({ where: { id: created.id } });
  }
  await payAmount(adminA, created.id, created.totalAmount); // PAID
  return prisma.invoice.findUniqueOrThrow({ where: { id: created.id } });
}

let creditNoteSupplementCounter = 0;
async function createFreshSupplementInvoice(admin: AuthenticatedTestUser, amount: number) {
  const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
  creditNoteSupplementCounter += 1;
  const response = await apiFetch("/api/invoices", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      locationId,
      type: "SUPPLEMENT",
      supplementKey: `CREDIT_NOTE_TEST_${creditNoteSupplementCounter}`,
      amount,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).invoice;
}

let creditNoteExtensionDateOffset = 0;
async function createFreshExtensionInvoice(admin: AuthenticatedTestUser, amount: number) {
  const locationId = await createFreshLocation(adminA, vehicleAId, clientAId);
  creditNoteExtensionDateOffset += 1;
  const targetDate = new Date(Date.UTC(2032, 0, 1 + creditNoteExtensionDateOffset)).toISOString();
  const response = await apiFetch("/api/invoices", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ locationId, type: "EXTENSION", extensionEndDate: targetDate, amount }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).invoice;
}

async function createCreditNoteHttp(admin: AuthenticatedTestUser, sourceId: string, body: Record<string, unknown>) {
  return apiFetch(`/api/invoices/${sourceId}/credit-notes`, {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify(body),
  });
}

describe("POST /api/invoices/[id]/credit-notes — avoir (Sprint 13E tâche 3, sous-phase 2c1)", () => {
  describe("Sources éligibles et montants", () => {
    it("avoir total sur RENTAL (ISSUED) : montant = totalAmount, plafond atteint à 0", async () => {
      const source = await createRentalSourceWithStatus("ISSUED");
      const response = await createCreditNoteHttp(adminA, source.id, {
        amount: source.totalAmount,
        reason: "Avoir total",
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.invoice.type).toBe("CREDIT_NOTE");
      expect(body.invoice.status).toBe("CREDIT_NOTE");
      expect(body.invoice.originalInvoiceId).toBe(source.id);
      expect(body.invoice.totalAmount).toBe(source.totalAmount);
      expect(body.invoice.supplementKey).toBeNull();
      expect(body.invoice.extensionEndDate).toBeNull();
      expect(body.invoice.number).toMatch(/^AV-\d{4}-\d{5}$/);

      const remaining = source.totalAmount - (await getTotalCreditedAmount(source.id));
      expect(remaining).toBe(0);
    });

    it("avoir partiel sur RENTAL (PARTIALLY_PAID) : montant < totalAmount", async () => {
      const source = await createRentalSourceWithStatus("PARTIALLY_PAID");
      const partial = Math.floor(source.totalAmount / 2);
      const response = await createCreditNoteHttp(adminA, source.id, { amount: partial, reason: "Avoir partiel" });
      expect(response.status).toBe(201);
      const remaining = source.totalAmount - (await getTotalCreditedAmount(source.id));
      expect(remaining).toBe(source.totalAmount - partial);
    });

    it("avoir sur une facture PAID — seul mécanisme de réversibilité pour une facture intégralement soldée (voidInvoice ne couvre pas ce cas)", async () => {
      const source = await createRentalSourceWithStatus("PAID");
      const response = await createCreditNoteHttp(adminA, source.id, {
        amount: source.totalAmount,
        reason: "Avoir après solde complet",
      });
      expect(response.status).toBe(201);
    });

    it("avoir sur une facture SUPPLEMENT", async () => {
      const supplement = await createFreshSupplementInvoice(adminA, 5000);
      await finalizeInvoice(adminA, supplement.id);
      const response = await createCreditNoteHttp(adminA, supplement.id, {
        amount: 5000,
        reason: "Avoir sur supplément",
      });
      expect(response.status).toBe(201);
      expect((await response.json()).invoice.originalInvoiceId).toBe(supplement.id);
    });

    it("avoir sur une facture EXTENSION", async () => {
      const extension = await createFreshExtensionInvoice(adminA, 6000);
      await finalizeInvoice(adminA, extension.id);
      const response = await createCreditNoteHttp(adminA, extension.id, {
        amount: 6000,
        reason: "Avoir sur extension",
      });
      expect(response.status).toBe(201);
      expect((await response.json()).invoice.originalInvoiceId).toBe(extension.id);
    });

    it("second avoir jusqu'au plafond exact accepté, troisième refusé (409)", async () => {
      const source = await createRentalSourceWithStatus("ISSUED"); // totalAmount 15000
      const first = await createCreditNoteHttp(adminA, source.id, { amount: 10000, reason: "Premier avoir" });
      expect(first.status).toBe(201);
      const second = await createCreditNoteHttp(adminA, source.id, { amount: 5000, reason: "Solde exact" });
      expect(second.status).toBe(201);
      const third = await createCreditNoteHttp(adminA, source.id, { amount: 1, reason: "Dépassement" });
      expect(third.status).toBe(409);
    });

    it("montant dépasse le montant encore créditable -> 409", async () => {
      const source = await createRentalSourceWithStatus("ISSUED");
      const response = await createCreditNoteHttp(adminA, source.id, { amount: source.totalAmount + 5000, reason: "Dépassement" });
      expect(response.status).toBe(409);
    });
  });

  describe("Validation du montant", () => {
    it("montant nul -> 400", async () => {
      const source = await createRentalSourceWithStatus("ISSUED");
      const response = await createCreditNoteHttp(adminA, source.id, { amount: 0, reason: "X" });
      expect(response.status).toBe(400);
    });

    it("montant négatif -> 400", async () => {
      const source = await createRentalSourceWithStatus("ISSUED");
      const response = await createCreditNoteHttp(adminA, source.id, { amount: -500, reason: "X" });
      expect(response.status).toBe(400);
    });

    it("montant non entier -> 400", async () => {
      const source = await createRentalSourceWithStatus("ISSUED");
      const response = await createCreditNoteHttp(adminA, source.id, { amount: 10.5, reason: "X" });
      expect(response.status).toBe(400);
    });

    it("montant non fini (Infinity, service direct — non représentable en JSON HTTP)", async () => {
      const source = await createRentalSourceWithStatus("ISSUED");
      await expect(
        createCreditNote({
          tenantId: adminA.tenantId,
          locationId: source.locationId,
          originalInvoiceId: source.id,
          amount: Infinity,
          reason: "X",
        })
      ).rejects.toThrow(InvalidInvoiceAmountError);
    });
  });

  describe("Validation du motif", () => {
    it("motif absent -> 400", async () => {
      const source = await createRentalSourceWithStatus("ISSUED");
      const response = await createCreditNoteHttp(adminA, source.id, { amount: 1000 });
      expect(response.status).toBe(400);
    });

    it("motif vide (espaces uniquement) -> 400", async () => {
      const source = await createRentalSourceWithStatus("ISSUED");
      const response = await createCreditNoteHttp(adminA, source.id, { amount: 1000, reason: "   " });
      expect(response.status).toBe(400);
    });
  });

  describe("Éligibilité de la source", () => {
    it("source inexistante -> 404", async () => {
      const response = await createCreditNoteHttp(adminA, "nonexistent-invoice-id-xyz", { amount: 1000, reason: "X" });
      expect(response.status).toBe(404);
    });

    it("source d'un autre tenant -> 404", async () => {
      const locationId = await createFreshLocation(adminB, vehicleBId, clientBId);
      const invoice = await prisma.invoice.findFirstOrThrow({ where: { locationId, type: "RENTAL" } });
      await finalizeInvoice(adminB, invoice.id);
      const response = await createCreditNoteHttp(adminA, invoice.id, { amount: 1000, reason: "Tentative cross-tenant" });
      expect(response.status).toBe(404);
      // Note : la route étant réservée ADMIN strict (canAccessAgency retourne toujours true pour
      // un ADMIN sur son propre tenant), le scénario "autre agence accessible du même tenant,
      // mais non rattachée" est structurellement inatteignable ici — il se confond avec le cas
      // "autre tenant" ci-dessus, qui est le seul cas réel de 404 lié à l'accès. Documenté plutôt
      // que testé séparément (voir DOMAINRULES.md, section 2c1).
    });

    it("source DRAFT -> 409", async () => {
      const source = await createRentalSourceWithStatus("DRAFT");
      const response = await createCreditNoteHttp(adminA, source.id, { amount: 1000, reason: "Source encore DRAFT" });
      expect(response.status).toBe(409);
    });

    it("source VOID -> 409", async () => {
      const source = await createRentalSourceWithStatus("VOID");
      const response = await createCreditNoteHttp(adminA, source.id, { amount: 1000, reason: "Source déjà VOID" });
      expect(response.status).toBe(409);
    });

    it("source de type CREDIT_NOTE (avoir sur avoir) -> 409", async () => {
      const source = await createRentalSourceWithStatus("ISSUED");
      const first = await createCreditNoteHttp(adminA, source.id, { amount: 1000, reason: "Avoir initial" });
      expect(first.status).toBe(201);
      const creditNoteId = (await first.json()).invoice.id;
      const second = await createCreditNoteHttp(adminA, creditNoteId, { amount: 500, reason: "Avoir sur avoir" });
      expect(second.status).toBe(409);
    });
  });

  describe("Permission", () => {
    it("rôle non-ADMIN (MEMBER) -> 403", async () => {
      const source = await createRentalSourceWithStatus("ISSUED");
      const response = await createCreditNoteHttp(memberA, source.id, { amount: 1000, reason: "Tentative MEMBER" });
      expect(response.status).toBe(403);
    });
  });

  describe("Audit", () => {
    it("l'audit invoice.credit_note_created est créé avec les métadonnées attendues", async () => {
      const source = await createRentalSourceWithStatus("ISSUED");
      const response = await createCreditNoteHttp(adminA, source.id, { amount: 4000, reason: "Vérification audit" });
      expect(response.status).toBe(201);
      const creditNoteId = (await response.json()).invoice.id;

      const auditEntry = await prisma.auditLog.findFirst({
        where: { tenantId: adminA.tenantId, action: "invoice.credit_note_created", resourceId: creditNoteId },
      });
      expect(auditEntry).not.toBeNull();
      const metadata = auditEntry!.metadata as Record<string, unknown>;
      expect(metadata.originalInvoiceId).toBe(source.id);
      expect(metadata.sourceType).toBe("RENTAL");
      expect(metadata.sourceStatus).toBe("ISSUED");
      expect(metadata.originalTotal).toBe(source.totalAmount);
      expect(metadata.creditNoteAmount).toBe(4000);
      expect(metadata.reason).toBe("Vérification audit");
      expect(metadata.agencyId).toBe(source.agencyId);
    });
  });

  describe("Immuabilité de la source et absence d'effet financier (B1)", () => {
    it("la facture source n'est jamais modifiée (status/amountPaid/totalAmount/subtotal/taxAmount/reason)", async () => {
      const source = await createRentalSourceWithStatus("PARTIALLY_PAID");
      const before = await prisma.invoice.findUniqueOrThrow({ where: { id: source.id } });
      const response = await createCreditNoteHttp(adminA, source.id, { amount: 1000, reason: "Vérification immuabilité" });
      expect(response.status).toBe(201);
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: source.id } });
      expect(after.status).toBe(before.status);
      expect(after.amountPaid).toBe(before.amountPaid);
      expect(after.totalAmount).toBe(before.totalAmount);
      expect(after.subtotal).toBe(before.subtotal);
      expect(after.taxAmount).toBe(before.taxAmount);
      expect(after.reason).toBe(before.reason);
      expect(after.updatedAt).toEqual(before.updatedAt);
    });

    it("aucun Payment n'est modifié par la création de l'avoir", async () => {
      const source = await createRentalSourceWithStatus("PARTIALLY_PAID");
      const paymentsBefore = await prisma.payment.findMany({ where: { invoiceId: source.id } });
      const response = await createCreditNoteHttp(adminA, source.id, { amount: 1000, reason: "Vérification Payment" });
      expect(response.status).toBe(201);
      const paymentsAfter = await prisma.payment.findMany({ where: { invoiceId: source.id } });
      expect(paymentsAfter).toEqual(paymentsBefore);
    });

    it("aucune CashEntry n'est créée par l'avoir", async () => {
      const source = await createRentalSourceWithStatus("PARTIALLY_PAID");
      const cashBefore = await prisma.cashEntry.count({ where: { tenantId: adminA.tenantId } });
      const response = await createCreditNoteHttp(adminA, source.id, { amount: 1000, reason: "Vérification caisse" });
      expect(response.status).toBe(201);
      const cashAfter = await prisma.cashEntry.count({ where: { tenantId: adminA.tenantId } });
      expect(cashAfter).toBe(cashBefore);
    });
  });

  describe("Concurrence (service direct — jamais une course HTTP, next dev sérialise une même route dynamique)", () => {
    it("deux créations concurrentes référençant la même source dont la somme dépasse le plafond : une seule réussit", async () => {
      const source = await createRentalSourceWithStatus("ISSUED"); // totalAmount 15000
      const [r1, r2] = await Promise.allSettled([
        createCreditNote({
          tenantId: adminA.tenantId,
          locationId: source.locationId,
          originalInvoiceId: source.id,
          amount: 9000,
          reason: "Concurrence A",
        }),
        createCreditNote({
          tenantId: adminA.tenantId,
          locationId: source.locationId,
          originalInvoiceId: source.id,
          amount: 9000,
          reason: "Concurrence B",
        }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual(["fulfilled", "rejected"]);
      const rejected = (r1.status === "rejected" ? r1 : r2) as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(CreditNoteExceedsRemainingCreditError);

      const total = await getTotalCreditedAmount(source.id);
      expect(total).toBe(9000);
      expect(total).toBeLessThanOrEqual(source.totalAmount);
    });

    it("deux créations concurrentes référençant la même source dont la somme reste sous le plafond : les deux réussissent", async () => {
      const source = await createRentalSourceWithStatus("ISSUED"); // totalAmount 15000
      const [r1, r2] = await Promise.all([
        createCreditNote({
          tenantId: adminA.tenantId,
          locationId: source.locationId,
          originalInvoiceId: source.id,
          amount: 3000,
          reason: "Concurrence C",
        }),
        createCreditNote({
          tenantId: adminA.tenantId,
          locationId: source.locationId,
          originalInvoiceId: source.id,
          amount: 4000,
          reason: "Concurrence D",
        }),
      ]);
      expect(r1.id).not.toBe(r2.id);
      const total = await getTotalCreditedAmount(source.id);
      expect(total).toBe(7000);
    });

    it("numéro AV : collision entre sources différentes absorbée par réessai de la transaction entière (concurrence réelle)", async () => {
      const sources = await Promise.all(
        Array.from({ length: 5 }, () => createRentalSourceWithStatus("ISSUED"))
      );
      const results = await Promise.all(
        sources.map((source, i) =>
          createCreditNote({
            tenantId: adminA.tenantId,
            locationId: source.locationId,
            originalInvoiceId: source.id,
            amount: 1000,
            reason: `Réessai numérotation ${i}`,
          })
        )
      );
      expect(results).toHaveLength(5);
      const numbers = results.map((r) => r.number);
      expect(new Set(numbers).size).toBe(5); // aucun doublon malgré la concurrence
      for (const number of numbers) {
        expect(number).toMatch(/^AV-\d{4}-\d{5}$/);
      }
    });
  });
});
