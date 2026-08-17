import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let memberA: AuthenticatedTestUser;
let agencyAId: string;
let locationAId: string; // totalPrice = 15000 (3 jours x 5000)
let locationBId: string;

async function createInvoice(admin: AuthenticatedTestUser, overrides: Record<string, unknown> = {}) {
  return apiFetch("/api/invoices", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ locationId: locationAId, ...overrides }),
  });
}

/** Finding F : un paiement ne peut être enregistré que sur une facture finalisée (SENT ou
 * au-delà, InvoiceNotFinalizedError sinon sur une facture encore DRAFT) — finalise d'abord la
 * facture avant tout paiement direct via POST /api/payments. */
async function finalizeInvoice(admin: AuthenticatedTestUser, invoiceId: string) {
  const response = await apiFetch(`/api/invoices/${invoiceId}`, {
    method: "PATCH",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ status: "SENT" }),
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
  const vehicleAId = (await vehicleAResponse.json()).vehicle.id;

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
  const vehicleBId = (await vehicleBResponse.json()).vehicle.id;

  const clientAResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Client A", email: `client-a-${runId}@test.local`, licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
  });
  const clientAId = (await clientAResponse.json()).client.id;

  const clientBResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Client B", email: `client-b-${runId}@test.local`, licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
  });
  const clientBId = (await clientBResponse.json()).client.id;

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
    const response = await createInvoice(adminA);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.invoice.status).toBe("DRAFT");
    expect(body.invoice.subtotal).toBe(15000);
    expect(body.invoice.totalAmount).toBe(15000);
    expect(body.invoice.currency).toBe("MAD");
    expect(body.invoice.number).toMatch(/^INV-\d{4}-\d{5}$/);
  });

  it("calcule taxAmount et totalAmount à partir de taxRate (points de base) et discountAmount", async () => {
    const response = await createInvoice(adminA, { taxRate: 2000, discountAmount: 1000 });
    expect(response.status).toBe(201);
    const body = await response.json();
    // subtotal 15000, taxRate 20% => taxAmount 3000, total = 15000 - 1000 + 3000 = 17000
    expect(body.invoice.taxAmount).toBe(3000);
    expect(body.invoice.totalAmount).toBe(17000);
  });

  it("refuse une remise supérieure au sous-total + TVA", async () => {
    const response = await createInvoice(adminA, { discountAmount: 999_999 });
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
      body: JSON.stringify({ status: "SENT" }),
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
      body: JSON.stringify({ status: "SENT" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invoice.status).toBe("SENT");
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
      body: JSON.stringify({ status: "SENT" }),
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
      body: JSON.stringify({ status: "SENT" }),
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
    // subtotal 15000, discountAmount 15000, taxRate par défaut 0 => totalAmount 0.
    const createResponse = await createInvoice(adminA, { discountAmount: 15000 });
    expect(createResponse.status).toBe(201);
    const invoiceId = (await createResponse.json()).invoice.id;

    const response = await apiFetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "SENT" }),
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
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).invoice.status).toBe("CANCELLED");

    const cashEntries = await prisma.cashEntry.findMany({ where: { tenantId: adminA.tenantId, category: "ANNULATION_FACTURE" } });
    expect(cashEntries).toHaveLength(0);
  });

  it("PATCH /api/invoices/[id] refuse PARTIALLY_PAID → CANCELLED (403) et indique la route dédiée", async () => {
    const { invoice } = await createPartiallyPaidInvoice(adminA);

    const response = await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
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
    expect(body.invoice.status).toBe("CANCELLED");
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

    const response = await createInvoice(grantedMember);
    expect(response.status).toBe(201);
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
      const response = await createInvoice(adminA);
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
      body: JSON.stringify({ status: "CANCELLED" }),
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
    expect(body.replacedInvoice.status).toBe("CANCELLED");
    // Sens inverse déjà couvert par body.invoice.replacesInvoiceId ci-dessus (relation 1:1 —
    // aucune colonne physique dupliquée sur l'ancienne facture, voir prisma/schema.prisma) et
    // par le test dédié « GET .../versions retourne l'historique complet » plus bas.

    const oldAfter = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    expect((await oldAfter.json()).invoice.status).toBe("CANCELLED");
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
    expect(oldInvoiceBody.status).toBe("CANCELLED");
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
