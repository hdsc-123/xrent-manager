import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let admin: AuthenticatedTestUser;
let vehicleId: string; // pricePerDay = 5000 (50,00 MAD)
let clientId: string;

// Chaque location réserve une fenêtre de 3 jours distincte (offset croissant), pour ne
// jamais entrer en conflit de disponibilité sur le même véhicule — totalPrice = 15000
// (5000 x 3 jours) à chaque fois.
let dateOffset = 0;

async function createLocationWithPayment(payment: Record<string, unknown>) {
  dateOffset += 10;
  const base = new Date(Date.UTC(2031, 0, 1));
  const start = new Date(base.getTime() + dateOffset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);

  const response = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      clientId,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      payment,
    }),
  });
  return response;
}

beforeAll(async () => {
  admin = await registerTenantAdmin({
    tenantName: "Location Payment Test",
    tenantSlug: `location-payment-test-${runId}`,
    name: "Admin",
    email: `admin-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(admin.tenantId);

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: "Agence Test", slug: `agence-test-${runId}` }),
  });
  const agencyId = (await agencyResponse.json()).agency.id;

  const vehicleResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      agencyId,
      name: "Clio",
      licensePlate: `LOCPAY-${runId}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay: 5000,
    }),
  });
  vehicleId = (await vehicleResponse.json()).vehicle.id;

  const clientResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: "Client Test", email: `client-${runId}@test.local` }),
  });
  clientId = (await clientResponse.json()).client.id;
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

describe("POST /api/locations — paiement intégré", () => {
  it("paiement au retour : aucune Payment créée, la facture reste DRAFT", async () => {
    const response = await createLocationWithPayment({ deferred: true });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.payments).toEqual([]);
    expect(body.invoice.status).toBe("DRAFT");

    const cashEntries = await prisma.cashEntry.findMany({ where: { contractId: body.location.id } });
    expect(cashEntries).toEqual([]);
  });

  it("paiement complet (mode simple) : facture PAYÉE et une entrée de caisse créée", async () => {
    const response = await createLocationWithPayment({ method: "CASH", partial: false });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.paymentError).toBeNull();
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0].amount).toBe(15_000);
    expect(body.invoice.status).toBe("PAID");

    const cashEntries = await prisma.cashEntry.findMany({ where: { contractId: body.location.id } });
    expect(cashEntries).toHaveLength(1);
    expect(cashEntries[0].amount).toBe(15_000);
    expect(cashEntries[0].type).toBe("ENTRY");
    expect(cashEntries[0].paymentMethod).toBe("CASH");
    expect(cashEntries[0].clientName).toBe("Client Test");
  });

  it("paiement partiel : facture PARTIELLE et l'entrée de caisse reflète le montant payé", async () => {
    const response = await createLocationWithPayment({ method: "BANK_TRANSFER", partial: true, amount: 5_000 });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0].amount).toBe(5_000);
    expect(body.invoice.status).toBe("PARTIALLY_PAID");

    const cashEntries = await prisma.cashEntry.findMany({ where: { contractId: body.location.id } });
    expect(cashEntries).toHaveLength(1);
    expect(cashEntries[0].amount).toBe(5_000);
  });

  it("paiement mixte : deux Payment et deux entrées de caisse", async () => {
    const response = await createLocationWithPayment({
      mixed: true,
      method1: "CASH",
      amount1: 10_000,
      method2: "CARD",
      amount2: 5_000,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.payments).toHaveLength(2);
    expect(body.invoice.status).toBe("PAID");

    const cashEntries = await prisma.cashEntry.findMany({ where: { contractId: body.location.id } });
    expect(cashEntries).toHaveLength(2);
    expect(cashEntries.map((entry) => entry.amount).sort((a, b) => a - b)).toEqual([5_000, 10_000]);
  });

  it("le solde de caisse reflète les paiements encaissés à la création des locations", async () => {
    const before = await (
      await apiFetch("/api/cash-register", { headers: { Cookie: admin.sessionCookie } })
    ).json();

    await createLocationWithPayment({ method: "CASH", partial: false });

    const after = await (
      await apiFetch("/api/cash-register", { headers: { Cookie: admin.sessionCookie } })
    ).json();
    expect(after.summary.currentBalance).toBe(before.summary.currentBalance + 15_000);
  });
});
