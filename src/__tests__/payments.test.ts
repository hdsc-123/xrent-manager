import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;

// Chaque appel réserve une fenêtre de dates distincte (offset croissant de 10 jours)
// pour ne jamais entrer en conflit avec les locations déjà créées sur le même véhicule.
let freshInvoiceDateOffset = 0;

/** Crée une nouvelle location + facture DRAFT (totalAmount = 15000) pour adminA, prête à recevoir des paiements. */
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
  return invoice as { id: string; totalAmount: number };
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
    password: "correct-horse-battery-staple",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Payments Test B",
    tenantSlug: `payments-test-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password: "correct-horse-battery-staple",
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
    }),
  });
  const vehicleBId = (await vehicleBResponse.json()).vehicle.id;

  const clientAResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Client A", email: `client-a-${runId}@test.local` }),
  });
  clientAId = (await clientAResponse.json()).client.id;

  const clientBResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Client B", email: `client-b-${runId}@test.local` }),
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
  await prisma.payment.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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
      body: JSON.stringify({ amount: invoice.totalAmount }),
    });
    expect(patchResponse.status).toBe(200);

    const updated = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    const updatedBody = await updated.json();
    expect(updatedBody.invoice.status).toBe("PAID");
  });

  it("recalcule amountPaid/status de la facture après suppression d'un paiement (jamais un retour à DRAFT)", async () => {
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
    expect(deleteResponse.status).toBe(200);

    const updated = await apiFetch(`/api/invoices/${invoice.id}`, { headers: { Cookie: adminA.sessionCookie } });
    const updatedBody = await updated.json();
    expect(updatedBody.invoice.amountPaid).toBe(0);
    // Une fois payée, une facture ne revient jamais à DRAFT (ce qui rouvrirait l'édition
    // de taxRate/discountAmount) même si son dernier paiement est supprimé — voir
    // recomputeInvoiceStatus dans src/lib/payments.ts.
    expect(updatedBody.invoice.status).toBe("SENT");
  });
});
