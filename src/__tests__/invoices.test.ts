import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let memberA: AuthenticatedTestUser;
let locationAId: string; // totalPrice = 15000 (3 jours x 5000)
let locationBId: string;

async function createInvoice(admin: AuthenticatedTestUser, overrides: Record<string, unknown> = {}) {
  return apiFetch("/api/invoices", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ locationId: locationAId, ...overrides }),
  });
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
  const agencyAId = (await agencyAResponse.json()).agency.id;

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
    }),
  });
  const vehicleBId = (await vehicleBResponse.json()).vehicle.id;

  const clientAResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Client A", email: `client-a-${runId}@test.local` }),
  });
  const clientAId = (await clientAResponse.json()).client.id;

  const clientBResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Client B", email: `client-b-${runId}@test.local` }),
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

  it("autorise la transition DRAFT → SENT", async () => {
    const createResponse = await createInvoice(adminA);
    const invoiceId = (await createResponse.json()).invoice.id;

    const response = await apiFetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "SENT" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invoice.status).toBe("SENT");
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
    const invoiceId = (await createResponse.json()).invoice.id;

    await apiFetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "SENT" }),
    });

    const response = await apiFetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ taxRate: 1000 }),
    });
    expect(response.status).toBe(409);
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

  it("refuse la suppression d'une facture SENT", async () => {
    const createResponse = await createInvoice(adminA);
    const invoiceId = (await createResponse.json()).invoice.id;

    await apiFetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "SENT" }),
    });

    const response = await apiFetch(`/api/invoices/${invoiceId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(409);
  });
});
