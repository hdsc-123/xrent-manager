import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, type AuthenticatedTestUser } from "./helpers/fixtures";
import { processLocationPayment } from "@/lib/location-payment";

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
      chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
    }),
  });
  vehicleId = (await vehicleResponse.json()).vehicle.id;

  const clientResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: "Client Test", email: `client-${runId}@test.local`, licenseExpiryDate: "2099-12-31" }),
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

  it("Sprint 14B — paiement mixte dépassant le total : aucune écriture partielle, message clair", async () => {
    // totalPrice = 15 000 ; la somme des deux lignes (10 000 + 10 000 = 20 000) dépasse le
    // total. Avant le correctif Sprint 14B, la première ligne (10 000, CASH) était tout de
    // même écrite avant que la seconde échoue avec un message technique (entier brut de
    // centimes) — désormais, le total est validé avant toute écriture : rien n'est créé.
    const response = await createLocationWithPayment({
      mixed: true,
      method1: "CASH",
      amount1: 10_000,
      method2: "CARD",
      amount2: 10_000,
    });
    expect(response.status).toBe(201);
    const body = await response.json();

    expect(body.payments).toEqual([]);
    expect(body.paymentError).toBeTruthy();
    // Le message est exprimé dans la devise (MAD), jamais un entier brut de centimes.
    expect(body.paymentError).toContain("MAD");
    expect(body.paymentError).not.toMatch(/\(\d+\)/);
    expect(body.invoice.status).toBe("DRAFT");
    expect(body.invoice.amountPaid).toBe(0);

    const payments = await prisma.payment.findMany({ where: { invoiceId: body.invoice.id } });
    expect(payments).toEqual([]);
    const cashEntries = await prisma.cashEntry.findMany({ where: { contractId: body.location.id } });
    expect(cashEntries).toEqual([]);
  });

  it("Finding F — le paiement intégré finalise automatiquement la facture (DRAFT → SENT) avant de payer, journalisé", async () => {
    const response = await createLocationWithPayment({ method: "CASH", partial: true, amount: 5_000 });
    expect(response.status).toBe(201);
    const body = await response.json();
    // La facture n'est jamais restée DRAFT : un Payment n'existe que sur une facture déjà
    // finalisée (InvoiceNotFinalizedError sinon, src/lib/payments.ts) — PARTIALLY_PAID ici
    // prouve que la finalisation automatique (DRAFT → SENT) a bien eu lieu avant le paiement.
    expect(body.invoice.status).toBe("PARTIALLY_PAID");

    const auditLogs = await prisma.auditLog.findMany({
      where: { resourceId: body.invoice.id, resource: "Invoice", action: "invoice.status_changed" },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].metadata).toMatchObject({ from: "DRAFT", to: "SENT", auto: true });

    const paymentAuditLogs = await prisma.auditLog.findMany({
      where: { resource: "Payment", resourceId: body.payments[0].id, action: "payment.created" },
    });
    expect(paymentAuditLogs).toHaveLength(1);
  });

  it("Finding F — paiement mixte : rollback complet (finalisation, 1ère ligne, CashEntry) si la 2e ligne échoue", async () => {
    // Situation de course non reproductible de façon fiable via deux requêtes HTTP concurrentes
    // dans un test d'intégration (tout se joue dans un seul appel POST /api/locations) : simulée
    // ici en appelant processLocationPayment directement avec un `totalAmount` gonflé dans
    // l'objet `invoice` passé en entrée (comme si le solde avait été mal évalué en amont). La
    // pré-validation du total des lignes (processLocationPayment) se base sur cet objet fourni et
    // laisse donc passer un total réel trop élevé ; `finalizeAndPay`, lui, ne fait ensuite
    // confiance qu'à l'état réel en base à chaque étape (updateInvoice/createPayment relisent
    // tout depuis `tx`) — la 1ère ligne (dans le vrai solde) réussit et écrit un Payment + une
    // CashEntry *dans la transaction*, la 2e ligne (qui dépasse le vrai solde restant) échoue :
    // toute la transaction doit alors être rollback, 1ère ligne comprise.
    const created = await createLocationWithPayment({ deferred: true });
    const createdBody = await created.json();
    const realInvoice = createdBody.invoice; // DRAFT, amountPaid = 0, totalAmount réel = 15000
    expect(realInvoice.totalAmount).toBe(15_000);
    const staleInvoice = { ...realInvoice, totalAmount: 25_000 };
    const before = new Date();

    const result = await processLocationPayment({
      tenantId: admin.tenantId,
      userId: admin.userId,
      invoice: staleInvoice,
      payment: { mixed: true, method1: "CASH", amount1: 10_000, method2: "CARD", amount2: 10_000 },
    });

    expect(result.paymentError).toBeTruthy();
    expect(result.payments).toEqual([]);

    const dbInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: realInvoice.id } });
    // La finalisation (DRAFT → SENT) et la 1ère ligne (10 000, CASH — valide isolément contre
    // le vrai solde de 15000) ont bien été rollback avec le reste de la transaction : la facture
    // n'est jamais restée SENT/PARTIALLY_PAID orpheline avec un paiement partiel.
    expect(dbInvoice.status).toBe("DRAFT");
    expect(dbInvoice.amountPaid).toBe(0);

    const payments = await prisma.payment.findMany({ where: { invoiceId: realInvoice.id } });
    expect(payments).toEqual([]);

    const cashEntries = await prisma.cashEntry.findMany({ where: { contractId: realInvoice.locationId } });
    expect(cashEntries).toEqual([]);

    // Aucun AuditLog de succès ne doit exister pour une transaction rollback — la journalisation
    // (invoice.status_changed / payment.created) n'intervient qu'après le succès complet de la
    // transaction (voir src/lib/location-payment.ts).
    const invoiceAuditLogs = await prisma.auditLog.findMany({
      where: { resourceId: realInvoice.id, resource: "Invoice", action: "invoice.status_changed" },
    });
    expect(invoiceAuditLogs).toEqual([]);
    // Aucun payment.created (même pour la 1ère ligne, rollback avec le reste) depuis le début
    // de cette tentative — vérifié sans filtrer sur metadata (JSON), en bornant sur createdAt.
    const paymentAuditLogs = await prisma.auditLog.findMany({
      where: { tenantId: admin.tenantId, resource: "Payment", action: "payment.created", createdAt: { gte: before } },
    });
    expect(paymentAuditLogs).toEqual([]);
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
