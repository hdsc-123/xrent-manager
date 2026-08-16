import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";
import { updatePayment } from "@/lib/payments";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;

// Chaque appel réserve une fenêtre de dates distincte (offset croissant de 10 jours)
// pour ne jamais entrer en conflit avec les locations déjà créées sur le même véhicule.
let freshInvoiceDateOffset = 0;

/** Crée une nouvelle location + facture (totalAmount = 15000) pour adminA, finalisée (SENT),
 * prête à recevoir des paiements. Finding F : un paiement direct (POST /api/payments) est
 * refusé sur une facture encore DRAFT — la facture doit donc être finalisée avant d'être
 * retournée par ce helper, utilisé par la quasi-totalité des tests de ce fichier. */
async function createFreshInvoice(admin: AuthenticatedTestUser, vehicleId: string, clientId: string) {
  freshInvoiceDateOffset += 10;
  const base = new Date(Date.UTC(2029, 0, 1));
  const start = new Date(base.getTime() + freshInvoiceDateOffset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);

  const locationResponse = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      clientId,
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    }),
  });
  const location = (await locationResponse.json()).location;

  const invoiceResponse = await apiFetch("/api/invoices", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ locationId: location.id }),
  });
  const invoice = (await invoiceResponse.json()).invoice;

  const finalizeResponse = await apiFetch(`/api/invoices/${invoice.id}`, {
    method: "PATCH",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ status: "SENT" }),
  });
  const finalized = (await finalizeResponse.json()).invoice;
  return finalized as { id: string; totalAmount: number; locationId: string; status: string };
}

/** Crée une location + facture DRAFT (non finalisée) — pour les tests qui exercent
 * spécifiquement le rejet d'un paiement direct sur DRAFT (Finding F). */
async function createFreshDraftInvoice(admin: AuthenticatedTestUser, vehicleId: string, clientId: string) {
  freshInvoiceDateOffset += 10;
  const base = new Date(Date.UTC(2029, 0, 1));
  const start = new Date(base.getTime() + freshInvoiceDateOffset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);

  const locationResponse = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      clientId,
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    }),
  });
  const location = (await locationResponse.json()).location;

  const invoiceResponse = await apiFetch("/api/invoices", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ locationId: location.id }),
  });
  const invoice = (await invoiceResponse.json()).invoice;
  return invoice as { id: string; totalAmount: number; locationId: string; status: string };
}

let agencyAId: string;
let vehicleAId: string;
let clientAId: string;
let invoiceBId: string;

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Payments Test A",
    tenantSlug: `payments-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Payments Test B",
    tenantSlug: `payments-test-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminB.tenantId);

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
      licensePlate: `PAY-A-${runId}`,
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
      licensePlate: `PAY-B-${runId}`,
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
    body: JSON.stringify({ name: "Client A", email: `client-a-${runId}@test.local`, licenseExpiryDate: "2099-12-31" }),
  });
  clientAId = (await clientAResponse.json()).client.id;

  const clientBResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Client B", email: `client-b-${runId}@test.local`, licenseExpiryDate: "2099-12-31" }),
  });
  const clientBId = (await clientBResponse.json()).client.id;

  const locationBResponse = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ vehicleId: vehicleBId, clientId: clientBId, startDate: "2029-02-01", endDate: "2029-02-04" }),
  });
  const locationB = (await locationBResponse.json()).location;

  const invoiceBResponse = await apiFetch("/api/invoices", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ locationId: locationB.id }),
  });
  invoiceBId = (await invoiceBResponse.json()).invoice.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("POST /api/payments", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/payments", {
      method: "POST",
      body: JSON.stringify({ invoiceId: invoiceBId, amount: 1000, method: "CASH" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse une facture d'un autre tenant (isolation multi-tenant)", async () => {
    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoiceBId, amount: 1000, method: "CASH" }),
    });
    expect(response.status).toBe(404);
  });

  it("Finding F — refuse un paiement direct sur une facture encore DRAFT (non finalisée)", async () => {
    const invoice = await createFreshDraftInvoice(adminA, vehicleAId, clientAId);
    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: invoice.totalAmount, method: "CASH" }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/finalis/i);

    const paymentsResponse = await apiFetch(`/api/payments?invoiceId=${invoice.id}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect((await paymentsResponse.json()).payments).toHaveLength(0);

    const invoiceResponse = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    expect((await invoiceResponse.json()).invoice.status).toBe("DRAFT");
  });

  it("Finding F — refuse un paiement mixte direct sur une facture encore DRAFT (non finalisée)", async () => {
    const invoice = await createFreshDraftInvoice(adminA, vehicleAId, clientAId);
    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        invoiceId: invoice.id,
        lines: [{ amount: invoice.totalAmount, method: "CASH" }],
      }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/finalis/i);
  });

  it("refuse un montant dépassant le solde restant dû", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);
    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: invoice.totalAmount + 1, method: "CASH" }),
    });
    expect(response.status).toBe(409);
  });

  it("enregistre un paiement partiel et passe la facture en PARTIALLY_PAID", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);
    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: 5000, method: "CASH" }),
    });
    expect(response.status).toBe(201);

    const updated = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    const updatedBody = await updated.json();
    expect(updatedBody.invoice.amountPaid).toBe(5000);
    expect(updatedBody.invoice.status).toBe("PARTIALLY_PAID");
  });

  it("passe la facture en PAID une fois le solde intégralement réglé", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);
    await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: invoice.totalAmount, method: "BANK_TRANSFER" }),
    });

    const updated = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    const updatedBody = await updated.json();
    expect(updatedBody.invoice.amountPaid).toBe(invoice.totalAmount);
    expect(updatedBody.invoice.status).toBe("PAID");
  });

  it("refuse un paiement sur une facture CANCELLED", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);
    await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });

    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: 1000, method: "CASH" }),
    });
    expect(response.status).toBe(409);
  });
});

describe("GET /api/payments", () => {
  it("liste uniquement les paiements du tenant connecté (isolation multi-tenant)", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);
    const createResponse = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: 1000, method: "CASH" }),
    });
    const paymentId = (await createResponse.json()).payment.id;

    const response = await apiFetch("/api/payments", { headers: { Cookie: adminA.sessionCookie } });
    const body = await response.json();
    const ids: string[] = body.payments.map((p: { id: string }) => p.id);
    expect(ids).toContain(paymentId);

    const otherTenantResponse = await apiFetch("/api/payments", { headers: { Cookie: adminB.sessionCookie } });
    const otherBody = await otherTenantResponse.json();
    const otherIds: string[] = otherBody.payments.map((p: { id: string }) => p.id);
    expect(otherIds).not.toContain(paymentId);
  });
});

describe("PATCH/DELETE /api/payments/[id]", () => {
  it("recalcule amountPaid/status de la facture après modification du montant d'un paiement", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);
    const createResponse = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: 5000, method: "CASH" }),
    });
    const paymentId = (await createResponse.json()).payment.id;

    const patchResponse = await apiFetch(`/api/payments/${paymentId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      // Sprint 26D (Finding D1) : motif obligatoire dès que amount change réellement.
      body: JSON.stringify({ amount: invoice.totalAmount, reason: "Solde ajusté au retour du véhicule" }),
    });
    expect(patchResponse.status).toBe(200);

    const updated = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    const updatedBody = await updated.json();
    expect(updatedBody.invoice.status).toBe("PAID");
  });

  // Sprint 26D (Finding D1) : deletePayment est désormais réservé aux paiements jamais
  // reflétés en caisse — un paiement créé via POST /api/payments a toujours une CashEntry
  // (recordPaymentCashEntry, systématique depuis le Sprint 18), donc sa suppression physique
  // est refusée (409) ; le scénario "recalcul après suppression" pour un paiement sans
  // CashEntry est couvert séparément (describe "Sprint 26D, Finding D1" plus bas).
  it("refuse la suppression physique d'un paiement déjà reflété en caisse (409) — jamais un retour à DRAFT ni une perte d'historique", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);
    const createResponse = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: invoice.totalAmount, method: "CASH" }),
    });
    const paymentId = (await createResponse.json()).payment.id;

    const deleteResponse = await apiFetch(`/api/payments/${paymentId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(409);

    const updated = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    const updatedBody = await updated.json();
    // Facture inchangée — la suppression a été refusée avant toute écriture.
    expect(updatedBody.invoice.amountPaid).toBe(invoice.totalAmount);
    expect(updatedBody.invoice.status).toBe("PAID");

    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(paymentAfter.status).toBe("ACTIVE");
  });
});

describe("Sprint 15 — permissions granulaires (payments.create)", () => {
  it("refuse un MEMBER rattaché à l'agence mais dont le groupe personnalisé n'a pas payments.create", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);

    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoPaymentCreate-${runId}`, permissions: ["payments.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Member",
      email: `restricted-payments-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: restrictedMember.userId, agencyId: agencyAId } });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: restrictedMember.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: 1000, method: "CASH" }),
    });
    expect(response.status).toBe(403);
  });

  it("autorise un MEMBER dont le groupe personnalisé accorde payments.create", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);

    const grantedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `WithPaymentCreate-${runId}`, permissions: ["payments.view", "payments.create"] }),
    });
    const grantedGroupId = (await grantedGroupResponse.json()).group.id;

    const grantedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Granted Member",
      email: `granted-payments-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: grantedMember.userId, agencyId: agencyAId } });
    await apiFetch(`/api/users/${grantedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: grantedGroupId }),
    });

    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: grantedMember.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: 1000, method: "CASH" }),
    });
    expect(response.status).toBe(201);
  });

  it("un ADMIN enregistre un paiement même rattaché à un groupe personnalisé vide (bypass systématique)", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);

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
      const response = await apiFetch("/api/payments", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ invoiceId: invoice.id, amount: 1000, method: "CASH" }),
      });
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

describe("Sprint 17 — POST /api/payments avec lines (paiement mixte atomique depuis la fiche facture)", () => {
  it("crée les deux lignes en une seule requête et met à jour le statut de la facture", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);

    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        invoiceId: invoice.id,
        lines: [
          { amount: 10000, method: "CASH" },
          { amount: 5000, method: "CARD" },
        ],
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.payments).toHaveLength(2);
    expect(body.payments[0].amount).toBe(10000);
    expect(body.payments[1].amount).toBe(5000);

    const invoiceResponse = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    const updatedInvoice = (await invoiceResponse.json()).invoice;
    expect(updatedInvoice.status).toBe("PAID");
    expect(updatedInvoice.amountPaid).toBe(invoice.totalAmount);
  });

  it("refuse un paiement mixte dont le total dépasse le solde restant sans écrire aucune ligne (même garantie que processLocationPayment)", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);

    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        invoiceId: invoice.id,
        lines: [
          { amount: invoice.totalAmount, method: "CASH" },
          { amount: 1, method: "CARD" },
        ],
      }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("solde restant dû");

    // Aucun paiement partiel orphelin — même si la première ligne à elle seule aurait été valide.
    const paymentsResponse = await apiFetch(`/api/payments?invoiceId=${invoice.id}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const payments = (await paymentsResponse.json()).payments;
    expect(payments).toHaveLength(0);

    const invoiceResponse = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    const untouchedInvoice = (await invoiceResponse.json()).invoice;
    expect(untouchedInvoice.status).toBe("SENT");
    expect(untouchedInvoice.amountPaid).toBe(0);
  });

  it("revalide le solde au moment de l'appel, pas contre une valeur obsolète : refuse si le solde a déjà diminué depuis le chargement de la page", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);

    // Simule un autre paiement déjà enregistré entretemps (ex. un autre onglet), qui aurait
    // rendu obsolète un `remainingBalance` lu par le client avant l'ouverture du dialogue.
    await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: invoice.totalAmount - 100, method: "CASH" }),
    });

    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        invoiceId: invoice.id,
        lines: [
          { amount: 60, method: "CASH" },
          { amount: 60, method: "CARD" },
        ],
      }),
    });
    expect(response.status).toBe(409);

    const paymentsResponse = await apiFetch(`/api/payments?invoiceId=${invoice.id}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    // Toujours un seul paiement (celui simulé ci-dessus) — le paiement mixte refusé n'a rien écrit.
    expect((await paymentsResponse.json()).payments).toHaveLength(1);
  });
});

describe("Sprint 26A, Finding B — verrouillage concurrent (Σ Payment.amount <= Invoice.totalAmount)", () => {
  async function getCashRegisterBalance(tenantId: string): Promise<number> {
    const register = await prisma.cashRegister.findUnique({ where: { tenantId } });
    return register?.currentBalance ?? 0;
  }

  it("deux POST concurrents sur la même facture, somme > solde : un seul succès, jamais deux, Σ Payment <= totalAmount", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId); // totalAmount = 15000
    const balanceBefore = await getCashRegisterBalance(adminA.tenantId);

    const [responseA, responseB] = await Promise.all([
      apiFetch("/api/payments", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ invoiceId: invoice.id, amount: 10000, method: "CASH" }),
      }),
      apiFetch("/api/payments", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ invoiceId: invoice.id, amount: 10000, method: "CARD" }),
      }),
    ]);

    // Chaque requête est individuellement valide (10000 <= 15000) : sans le verrou de ligne
    // (Finding B), les deux passeraient la validation contre une lecture périmée du solde.
    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const payments = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(10000);
    const paymentsSum = payments.reduce((sum, p) => sum + p.amount, 0);
    expect(paymentsSum).toBeLessThanOrEqual(invoice.totalAmount);

    const dbInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(dbInvoice.amountPaid).toBe(paymentsSum);
    expect(dbInvoice.status).toBe("PARTIALLY_PAID");

    // CashEntry : une seule, correspondant exactement au paiement effectivement accepté —
    // le refusé n'a jamais atteint recordPaymentCashEntry.
    const cashEntries = await prisma.cashEntry.findMany({ where: { contractId: invoice.locationId } });
    expect(cashEntries).toHaveLength(1);
    expect(cashEntries[0].amount).toBe(10000);

    // CashRegister : le solde tenant-wide progresse d'exactement le montant accepté, jamais
    // des deux montants cumulés (vérifié en delta, le registre étant partagé par tout le fichier).
    const balanceAfter = await getCashRegisterBalance(adminA.tenantId);
    expect(balanceAfter - balanceBefore).toBe(10000);
  });

  it("deux PATCH concurrents sur deux paiements différents de la même facture, nouvelle somme > total : aucun dépassement", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId); // totalAmount = 15000

    const create1 = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: 3000, method: "CASH" }),
    });
    const payment1 = (await create1.json()).payment;
    const create2 = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: 3000, method: "CARD" }),
    });
    const payment2 = (await create2.json()).payment;
    // amountPaid = 6000, remaining = 9000 — chaque PATCH à 9000 est individuellement valide
    // (remainingExcludingThis = 15000 - (6000 - 3000) = 12000), mais les deux ensemble
    // porteraient la somme à 18000 > 15000.

    const [responseA, responseB] = await Promise.all([
      apiFetch(`/api/payments/${payment1.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ amount: 9000, reason: "Ajustement concurrent 1" }),
      }),
      apiFetch(`/api/payments/${payment2.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ amount: 9000, reason: "Ajustement concurrent 2" }),
      }),
    ]);

    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const payments = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    const paymentsSum = payments.reduce((sum, p) => sum + p.amount, 0);
    expect(paymentsSum).toBeLessThanOrEqual(invoice.totalAmount);

    const dbInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(dbInvoice.amountPaid).toBe(paymentsSum);
  });

  it("un paiement mixte concurrent à un paiement simple sur la même facture : jamais de dépassement, aucune ligne partielle", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId); // totalAmount = 15000

    const [responseSimple, responseMixed] = await Promise.all([
      apiFetch("/api/payments", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ invoiceId: invoice.id, amount: 10000, method: "CASH" }),
      }),
      apiFetch("/api/payments", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({
          invoiceId: invoice.id,
          lines: [
            { amount: 8000, method: "CASH" },
            { amount: 2000, method: "CARD" },
          ],
        }),
      }),
    ]);

    const statuses = [responseSimple.status, responseMixed.status].sort();
    expect(statuses).toEqual([201, 409]);

    const payments = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    const paymentsSum = payments.reduce((sum, p) => sum + p.amount, 0);
    expect(paymentsSum).toBeLessThanOrEqual(invoice.totalAmount);

    // Le gagnant s'identifie sans ambiguïté : le simple laisse exactement 1 Payment (10000),
    // le mixte en laisse exactement 2 (8000 + 2000) — jamais 1 ligne orpheline d'un mixte perdant.
    if (responseMixed.status === 201) {
      expect(payments).toHaveLength(2);
    } else {
      expect(payments).toHaveLength(1);
      expect(payments[0].amount).toBe(10000);
    }

    const dbInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(dbInvoice.amountPaid).toBe(paymentsSum);

    const cashEntries = await prisma.cashEntry.findMany({ where: { contractId: invoice.locationId } });
    expect(cashEntries).toHaveLength(payments.length);
  });
});

describe("Sprint 18 — paiement enregistré depuis la fiche facture alimente la caisse", () => {
  it("crée une écriture de caisse pour un paiement simple", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);
    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: 5000, method: "CASH" }),
    });
    expect(response.status).toBe(201);

    const cashEntries = await prisma.cashEntry.findMany({ where: { contractId: invoice.locationId } });
    expect(cashEntries).toHaveLength(1);
    expect(cashEntries[0].amount).toBe(5000);
    expect(cashEntries[0].type).toBe("ENTRY");
    expect(cashEntries[0].paymentMethod).toBe("CASH");
  });

  it("crée une écriture de caisse par ligne pour un paiement mixte", async () => {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);
    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        invoiceId: invoice.id,
        lines: [
          { amount: 10000, method: "CASH" },
          { amount: 5000, method: "CARD" },
        ],
      }),
    });
    expect(response.status).toBe(201);

    const cashEntries = await prisma.cashEntry.findMany({ where: { contractId: invoice.locationId } });
    expect(cashEntries).toHaveLength(2);
    expect(cashEntries.map((entry) => entry.amount).sort((a, b) => a - b)).toEqual([5000, 10000]);
  });
});

describe("Sprint 26D, Finding D1 — corrections de paiement (compensation append-only)", () => {
  async function createPayment(amount: number, method: "CASH" | "CARD" = "CASH") {
    const invoice = await createFreshInvoice(adminA, vehicleAId, clientAId);
    const response = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount, method }),
    });
    const payment = (await response.json()).payment as { id: string; invoiceId: string; amount: number };
    return { invoice, payment };
  }

  async function getOriginalEntry(paymentId: string) {
    return prisma.cashEntry.findFirstOrThrow({ where: { paymentId, parentEntryId: null } });
  }

  it("diminution du montant : compensation négative, écriture d'origine inchangée, solde correct", async () => {
    const { payment } = await createPayment(500);
    const original = await getOriginalEntry(payment.id);

    const patchResponse = await apiFetch(`/api/payments/${payment.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ amount: 300, reason: "Erreur de saisie" }),
    });
    expect(patchResponse.status).toBe(200);

    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentAfter.amount).toBe(300);
    expect(paymentAfter.status).toBe("ACTIVE");

    const originalAfter = await prisma.cashEntry.findUniqueOrThrow({ where: { id: original.id } });
    expect(originalAfter.amount).toBe(500);
    expect(originalAfter.type).toBe("ENTRY");

    const compensations = await prisma.cashEntry.findMany({ where: { parentEntryId: original.id } });
    expect(compensations).toHaveLength(1);
    expect(compensations[0].type).toBe("EXPENSE");
    expect(compensations[0].amount).toBe(200);
    expect(compensations[0].paymentId).toBe(payment.id);
    expect(compensations[0].reason).toBe("Erreur de saisie");
    expect(compensations[0].performedByUserId).toBe(adminA.userId);

    const invoiceAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: payment.invoiceId } });
    expect(invoiceAfter.amountPaid).toBe(300);
  });

  it("augmentation du montant : compensation positive", async () => {
    const { payment } = await createPayment(500);
    const original = await getOriginalEntry(payment.id);

    const patchResponse = await apiFetch(`/api/payments/${payment.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ amount: 700, reason: "Complément réglé au retour" }),
    });
    expect(patchResponse.status).toBe(200);

    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentAfter.amount).toBe(700);

    const compensations = await prisma.cashEntry.findMany({ where: { parentEntryId: original.id } });
    expect(compensations).toHaveLength(1);
    expect(compensations[0].type).toBe("ENTRY");
    expect(compensations[0].amount).toBe(200);

    const invoiceAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: payment.invoiceId } });
    expect(invoiceAfter.amountPaid).toBe(700);
  });

  it("refuse une correction de montant sans motif (400), aucune écriture créée", async () => {
    const { payment } = await createPayment(500);
    const original = await getOriginalEntry(payment.id);

    const patchResponse = await apiFetch(`/api/payments/${payment.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ amount: 300 }),
    });
    expect(patchResponse.status).toBe(400);

    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentAfter.amount).toBe(500);
    const compensations = await prisma.cashEntry.findMany({ where: { parentEntryId: original.id } });
    expect(compensations).toHaveLength(0);
  });

  it("changement de moyen seul : deux compensations liées (sortie ancien moyen, entrée nouveau moyen), montant inchangé", async () => {
    const { payment } = await createPayment(500, "CASH");
    const original = await getOriginalEntry(payment.id);

    const patchResponse = await apiFetch(`/api/payments/${payment.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ method: "CARD", reason: "Le client a finalement réglé par carte" }),
    });
    expect(patchResponse.status).toBe(200);

    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentAfter.amount).toBe(500);
    expect(paymentAfter.method).toBe("CARD");

    const compensations = await prisma.cashEntry.findMany({ where: { parentEntryId: original.id }, orderBy: { createdAt: "asc" } });
    expect(compensations).toHaveLength(2);
    expect(compensations[0].type).toBe("EXPENSE");
    expect(compensations[0].amount).toBe(500);
    expect(compensations[0].paymentMethod).toBe("CASH");
    expect(compensations[1].type).toBe("ENTRY");
    expect(compensations[1].amount).toBe(500);
    expect(compensations[1].paymentMethod).toBe("CARD");
    expect(compensations.every((entry) => entry.paymentId === payment.id)).toBe(true);

    // Solde global inchangé (réallocation pure), mais la ventilation CASH/CARD est corrigée.
    const invoiceAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: payment.invoiceId } });
    expect(invoiceAfter.amountPaid).toBe(500);
  });

  it("changement simultané de montant et de moyen : sortie complète ancien montant/moyen, entrée complète nouveau montant/moyen", async () => {
    const { payment } = await createPayment(500, "CASH");
    const original = await getOriginalEntry(payment.id);

    const patchResponse = await apiFetch(`/api/payments/${payment.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ amount: 700, method: "CARD", reason: "Complément réglé par carte" }),
    });
    expect(patchResponse.status).toBe(200);

    const compensations = await prisma.cashEntry.findMany({ where: { parentEntryId: original.id }, orderBy: { createdAt: "asc" } });
    expect(compensations).toHaveLength(2);
    expect(compensations[0].type).toBe("EXPENSE");
    expect(compensations[0].amount).toBe(500);
    expect(compensations[0].paymentMethod).toBe("CASH");
    expect(compensations[1].type).toBe("ENTRY");
    expect(compensations[1].amount).toBe(700);
    expect(compensations[1].paymentMethod).toBe("CARD");

    const invoiceAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: payment.invoiceId } });
    expect(invoiceAfter.amountPaid).toBe(700);
  });

  it("correction de date seule : aucune CashEntry créée, AuditLog contient ancien/nouveau paidAt et le motif", async () => {
    const { payment } = await createPayment(500);
    const original = await getOriginalEntry(payment.id);
    const newPaidAt = new Date(Date.UTC(2029, 5, 15));

    const patchResponse = await apiFetch(`/api/payments/${payment.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ paidAt: newPaidAt.toISOString(), reason: "Date de règlement corrigée" }),
    });
    expect(patchResponse.status).toBe(200);

    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentAfter.paidAt.toISOString()).toBe(newPaidAt.toISOString());

    // Aucune compensation — rien à corriger financièrement pour une date seule.
    const compensations = await prisma.cashEntry.findMany({ where: { parentEntryId: original.id } });
    expect(compensations).toHaveLength(0);
    // L'écriture d'origine reste sur son createdAt réel (immuable) — jamais réalignée sur le
    // nouveau paidAt (voir le commentaire sur updatePaymentLocked, src/lib/payments.ts).
    const originalAfter = await prisma.cashEntry.findUniqueOrThrow({ where: { id: original.id } });
    expect(originalAfter.createdAt).toEqual(original.createdAt);

    const log = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, resource: "Payment", resourceId: payment.id, action: "payment.updated" },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    const metadata = log?.metadata as Record<string, unknown>;
    expect(metadata.reason).toBe("Date de règlement corrigée");
    expect(metadata.newPaidAt).toBe(newPaidAt.toISOString());
    expect(typeof metadata.previousPaidAt).toBe("string");
  });

  it("un paiement déjà REFUNDED ne peut plus être corrigé (409)", async () => {
    // Contrat validé + paiement + annulation admin (flux de remboursement, describe Sprint 23
    // de locations.test.ts) pour atteindre l'état REFUNDED.
    const locationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId: vehicleAId,
        clientId: clientAId,
        startDate: "2029-09-01",
        endDate: "2029-09-04",
        status: "CONFIRMED",
        payment: { method: "CASH", partial: false },
      }),
    });
    const { location, invoice } = await locationResponse.json();
    const [payment] = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });

    const cancelResponse = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Test REFUNDED — préparation" }),
    });
    expect(cancelResponse.status).toBe(200);

    const refundedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(refundedPayment.status).toBe("REFUNDED");

    const patchResponse = await apiFetch(`/api/payments/${payment.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ amount: 1000, reason: "Tentative après remboursement" }),
    });
    expect(patchResponse.status).toBe(409);

    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(unchanged.amount).toBe(refundedPayment.amount);
  });

  it("un paiement sans CashEntry d'origine (legacy) refuse la correction (409), aucune compensation orpheline", async () => {
    const { payment } = await createPayment(500);
    // Simule un paiement antérieur au Sprint 18 : sa CashEntry n'a jamais existé.
    await prisma.cashEntry.deleteMany({ where: { paymentId: payment.id } });

    const patchResponse = await apiFetch(`/api/payments/${payment.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ amount: 300, reason: "Correction sans historique de caisse" }),
    });
    expect(patchResponse.status).toBe(409);

    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(unchanged.amount).toBe(500);
    const anyEntry = await prisma.cashEntry.findFirst({ where: { paymentId: payment.id } });
    expect(anyEntry).toBeNull();
  });

  it("suppression physique refusée (409) si une CashEntry est liée — Payment et CashEntry inchangés", async () => {
    const { payment } = await createPayment(500);

    const deleteResponse = await apiFetch(`/api/payments/${payment.id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(409);

    const stillThere = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(stillThere).not.toBeNull();
    const entry = await prisma.cashEntry.findFirst({ where: { paymentId: payment.id } });
    expect(entry).not.toBeNull();
  });

  it("suppression physique autorisée si aucune CashEntry n'est liée (legacy) — facture recalculée", async () => {
    const { payment, invoice } = await createPayment(500);
    await prisma.cashEntry.deleteMany({ where: { paymentId: payment.id } });

    const deleteResponse = await apiFetch(`/api/payments/${payment.id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(200);

    const gone = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(gone).toBeNull();
    const invoiceAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(invoiceAfter.amountPaid).toBe(0);
  });

  it("rollback : un échec après la correction du paiement annule Payment, CashEntry, Invoice et CashRegister", async () => {
    const { payment, invoice } = await createPayment(500);
    const registerBefore = await prisma.cashRegister.findUniqueOrThrow({ where: { tenantId: adminA.tenantId } });

    await expect(
      prisma.$transaction(async (tx) => {
        await updatePayment(
          adminA.tenantId,
          payment.id,
          { amount: 300, reason: "Test rollback", performedByUserId: adminA.userId },
          tx
        );
        throw new Error("Échec forcé après la correction du paiement");
      })
    ).rejects.toThrow("Échec forcé");

    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentAfter.amount).toBe(500);

    const compensations = await prisma.cashEntry.findMany({
      where: { paymentId: payment.id, parentEntryId: { not: null } },
    });
    expect(compensations).toHaveLength(0);

    const invoiceAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(invoiceAfter.amountPaid).toBe(500);

    const registerAfter = await prisma.cashRegister.findUniqueOrThrow({ where: { tenantId: adminA.tenantId } });
    expect(registerAfter.currentBalance).toBe(registerBefore.currentBalance);
  });

  it("deux PATCH concurrents sur le même paiement : sérialisés par le verrou Invoice, jamais de double compensation", async () => {
    const { payment, invoice } = await createPayment(1000);
    const original = await getOriginalEntry(payment.id);

    const [r1, r2] = await Promise.all([
      apiFetch(`/api/payments/${payment.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ amount: 600, reason: "Correction concurrente 1" }),
      }),
      apiFetch(`/api/payments/${payment.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ amount: 800, reason: "Correction concurrente 2" }),
      }),
    ]);

    // Les deux montants demandés sont individuellement valides (<= totalAmount de la
    // facture) : le verrou Invoice sérialise les deux transactions, chacune relit l'état à
    // jour avant de calculer sa compensation — les deux peuvent donc réussir.
    expect([r1.status, r2.status].every((s) => s === 200)).toBe(true);

    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect([600, 800]).toContain(paymentAfter.amount);

    // Exactement une compensation par PATCH réussi — jamais plus, jamais une compensation
    // calculée sur un montant déjà périmé par l'autre transaction (voir le commentaire sur
    // updatePaymentLocked, src/lib/payments.ts).
    const compensations = await prisma.cashEntry.findMany({ where: { parentEntryId: original.id } });
    expect(compensations).toHaveLength(2);

    const invoiceAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(invoiceAfter.amountPaid).toBe(paymentAfter.amount);
  });
});
