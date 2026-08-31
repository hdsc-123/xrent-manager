import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

/**
 * Sprint 33 (DOMAINRULES.md section 48) — tests HTTP de GET /api/damage-invoices,
 * GET /api/damage-invoices/[id], POST /api/damage-invoices/[id]/payments,
 * POST /api/damage-invoices/[id]/cancel et GET /api/damage-invoices/[id]/pdf. La logique
 * métier (solde, idempotence, concurrence, réversibilité) est déjà couverte par
 * src/__tests__/damages.test.ts (appel direct du service) — ce fichier vérifie ce que la
 * route ajoute : authentification, permissions, portée tenant/agence, IDOR, codes d'erreur
 * sûrs, format des réponses HTTP (jamais un accès direct sans /api/damages qui génère la
 * facture — voir createDamageA/createBilledDamageInvoice ci-dessous).
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let agencyA1Id: string;
let agencyA2Id: string;
let vehicleAId: string;
let clientAId: string;
let dateOffset = 0;

async function createLocationA(overrides: Record<string, unknown> = {}): Promise<{ id: string; contractNumber: string }> {
  dateOffset += 10;
  const base = new Date(Date.UTC(2028, 0, 1));
  const start = new Date(base.getTime() + dateOffset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);

  const response = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      vehicleId: vehicleAId,
      clientId: clientAId,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      ...overrides,
    }),
  });
  const { location } = await response.json();
  return { id: location.id as string, contractNumber: location.contractNumber as string };
}

async function grantPermissions(userId: string, permissions: string[], groupName: string): Promise<void> {
  const groupResponse = await apiFetch("/api/permission-groups", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: `${groupName}-${runId}`, permissions }),
  });
  const groupId = (await groupResponse.json()).group.id;
  await apiFetch(`/api/users/${userId}/permissions`, {
    method: "PATCH",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ permissionGroupId: groupId }),
  });
}

/** Déclare un dégât facturable via POST /api/damages (adminA) — génère automatiquement sa
 * DamageInvoice (Sprint 33) — jamais un accès direct à src/lib/damage-invoices.ts, pour tester
 * exactement le même chemin qu'un utilisateur réel. */
async function createBilledDamageInvoice(locationId: string, billableAmount = 1000): Promise<string> {
  const response = await apiFetch("/api/damages", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ locationId, nature: "Rayure test", billableAmount }),
  });
  const body = await response.json();
  return body.damageInvoice.id as string;
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Damage Invoices Route Test A",
    tenantSlug: `damage-invoices-route-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Damage Invoices Route Test B",
    tenantSlug: `damage-invoices-route-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminB.tenantId);

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A1", slug: `agence-a1-${runId}` }),
  });
  agencyA1Id = (await agencyResponse.json()).agency.id;

  const agency2Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A2", slug: `agence-a2-${runId}` }),
  });
  agencyA2Id = (await agency2Response.json()).agency.id;

  const vehicleResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      agencyId: agencyA1Id,
      name: "Clio",
      licensePlate: `DIR-${runId}`,
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
  vehicleAId = (await vehicleResponse.json()).vehicle.id;

  const clientResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      name: "Client A",
      email: `client-a-${runId}@test.local`,
      licenseExpiryDate: "2099-12-31",
      birthDate: "1990-01-01",
    }),
  });
  clientAId = (await clientResponse.json()).client.id;
});

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
});

describe("GET /api/damage-invoices — liste, authentification, permissions, portée agence", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/damage-invoices");
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER sans damage_invoices.view", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No View",
      email: `no-view-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    const response = await apiFetch("/api/damage-invoices", { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(403);
  });

  it("liste les factures du tenant, filtrées par statut", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id, 1500);

    const response = await apiFetch("/api/damage-invoices?status=SENT", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.damageInvoices.some((invoice: { id: string }) => invoice.id === invoiceId)).toBe(true);
  });

  it("un MEMBER ne voit que les factures de ses agences accessibles", async () => {
    const locationA1 = await createLocationA({ agencyId: agencyA1Id });
    const invoiceA1 = await createBilledDamageInvoice(locationA1.id, 1000);

    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Scoped Viewer",
      email: `scoped-viewer-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA2Id } });
    await grantPermissions(member.userId, ["damage_invoices.view"], "ScopedViewer");

    const response = await apiFetch("/api/damage-invoices", { headers: { Cookie: member.sessionCookie } });
    const body = await response.json();
    expect(body.damageInvoices.some((invoice: { id: string }) => invoice.id === invoiceA1)).toBe(false);
  });
});

describe("GET /api/damage-invoices/[id] — détail, IDOR, portée agence", () => {
  it("refuse la consultation d'une facture d'un autre tenant, sans révéler son existence", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id);

    const response = await apiFetch(`/api/damage-invoices/${invoiceId}`, { headers: { Cookie: adminB.sessionCookie } });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["error"]);
  });

  it("refuse un MEMBER non rattaché à l'agence de la facture", async () => {
    const location = await createLocationA({ agencyId: agencyA1Id });
    const invoiceId = await createBilledDamageInvoice(location.id);

    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Out Of Agency",
      email: `out-of-agency-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA2Id } });
    await grantPermissions(member.userId, ["damage_invoices.view"], "OutOfAgency");

    const response = await apiFetch(`/api/damage-invoices/${invoiceId}`, { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(404);
  });

  it("consulte une facture existante avec ses lignes et paiements", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id, 2000);

    const response = await apiFetch(`/api/damage-invoices/${invoiceId}`, { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.damageInvoice.id).toBe(invoiceId);
    expect(body.damageInvoice.lines).toHaveLength(1);
    expect(body.damageInvoice.number.startsWith("FACT-DEG-")).toBe(true);
    expect(body.damageInvoice.number).toContain(`/${location.contractNumber}`);
  });
});

describe("POST /api/damage-invoices/[id]/payments — encaissement", () => {
  it("refuse un MEMBER sans damage_invoices.payment.create", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id, 2000);
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Pay",
      email: `no-pay-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA1Id } });
    await grantPermissions(member.userId, ["damage_invoices.view"], "NoPay");

    const response = await apiFetch(`/api/damage-invoices/${invoiceId}/payments`, {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ method: "CASH", amount: 500 }),
    });
    expect(response.status).toBe(403);
  });

  it("refuse le paiement d'une facture d'un autre tenant", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id, 2000);
    const response = await apiFetch(`/api/damage-invoices/${invoiceId}/payments`, {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({ method: "CASH", amount: 500 }),
    });
    expect(response.status).toBe(404);
  });

  it("encaisse un paiement valide (espèces)", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id, 2000);

    const response = await apiFetch(`/api/damage-invoices/${invoiceId}/payments`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ method: "CASH", amount: 2000 }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0].damageInvoiceId).toBe(invoiceId);
    expect(body.payments[0].invoiceId).toBeNull();

    const invoice = await prisma.damageInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe("PAID");
  });

  it("encaisse un paiement mixte (carte + espèces)", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id, 3000);

    const response = await apiFetch(`/api/damage-invoices/${invoiceId}/payments`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        lines: [
          { method: "CASH", amount: 1000 },
          { method: "CARD", amount: 2000 },
        ],
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.payments).toHaveLength(2);
  });

  it("refuse un dépassement du solde, sans révéler de détail interne", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id, 500);

    const response = await apiFetch(`/api/damage-invoices/${invoiceId}/payments`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ method: "CASH", amount: 5000 }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).not.toMatch(/prisma|stack|at \w+\.|node_modules/i);

    const payments = await prisma.payment.findMany({ where: { damageInvoiceId: invoiceId } });
    expect(payments).toHaveLength(0);
  });

  it("double paiement concurrent sur la même facture : un seul succès (201), l'autre échoue (409)", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id, 1000);

    const [first, second] = await Promise.all([
      apiFetch(`/api/damage-invoices/${invoiceId}/payments`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ method: "CASH", amount: 800 }),
      }),
      apiFetch(`/api/damage-invoices/${invoiceId}/payments`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ method: "CARD", amount: 800 }),
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const payments = await prisma.payment.findMany({ where: { damageInvoiceId: invoiceId } });
    const total = payments.reduce((sum, p) => sum + p.amount, 0);
    expect(total).toBe(800);
  });
});

describe("POST /api/damage-invoices/[id]/cancel — annulation", () => {
  it("refuse un MEMBER sans damage_invoices.cancel", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id, 1000);
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Cancel",
      email: `no-cancel-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA1Id } });
    await grantPermissions(member.userId, ["damage_invoices.view"], "NoCancel");

    const response = await apiFetch(`/api/damage-invoices/${invoiceId}/cancel`, {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ reason: "Test" }),
    });
    expect(response.status).toBe(403);
  });

  it("exige un motif", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id, 1000);
    const response = await apiFetch(`/api/damage-invoices/${invoiceId}/cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "" }),
    });
    expect(response.status).toBe(400);
  });

  it("annule une facture payée — paiement remboursé, compensation de caisse créée", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id, 1000);
    await apiFetch(`/api/damage-invoices/${invoiceId}/payments`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ method: "CASH", amount: 1000 }),
    });

    const response = await apiFetch(`/api/damage-invoices/${invoiceId}/cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur de facturation" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.damageInvoice.status).toBe("CANCELLED");

    const payment = await prisma.payment.findFirstOrThrow({ where: { damageInvoiceId: invoiceId } });
    expect(payment.status).toBe("REFUNDED");
  });

  it("refuse une seconde annulation (409)", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id, 1000);
    await apiFetch(`/api/damage-invoices/${invoiceId}/cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Erreur" }),
    });
    const response = await apiFetch(`/api/damage-invoices/${invoiceId}/cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Nouvelle tentative" }),
    });
    expect(response.status).toBe(409);
  });
});

describe("GET /api/damage-invoices/[id]/pdf — PDF privé", () => {
  it("refuse une requête non authentifiée", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id);
    const response = await apiFetch(`/api/damage-invoices/${invoiceId}/pdf`);
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER sans damage_invoices.export", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id);
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Export",
      email: `no-export-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA1Id } });
    await grantPermissions(member.userId, ["damage_invoices.view"], "NoExport");

    const response = await apiFetch(`/api/damage-invoices/${invoiceId}/pdf`, { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(403);
  });

  it("refuse le téléchargement du PDF d'une facture d'un autre tenant", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id);
    const response = await apiFetch(`/api/damage-invoices/${invoiceId}/pdf`, { headers: { Cookie: adminB.sessionCookie } });
    expect(response.status).toBe(404);
  });

  it("génère un PDF privé pour une facture accessible", async () => {
    const location = await createLocationA();
    const invoiceId = await createBilledDamageInvoice(location.id, 1500);

    const response = await apiFetch(`/api/damage-invoices/${invoiceId}/pdf`, { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });
});
