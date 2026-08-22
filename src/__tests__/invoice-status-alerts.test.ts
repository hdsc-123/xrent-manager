import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, type AuthenticatedTestUser } from "./helpers/fixtures";

/**
 * Finding F (Sprint 27) : checkOverdueInvoices/checkContractsAtRisk/checkPaymentsDue
 * (src/lib/scheduled-tasks.ts) filtrent déjà sur `status IN (SENT, PARTIALLY_PAID)` — aucune
 * modification de code n'était nécessaire pour ces trois vérifications, mais elles n'avaient
 * jamais pu se déclencher en pratique pour une facture jamais payée tant que SENT était
 * structurellement inatteignable (voir HANDOFF.md, Finding F). Ce fichier couvre ce qui n'avait
 * jamais été testé : une facture SENT sans aucun paiement déclenche bien chacune des trois
 * alertes.
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let admin: AuthenticatedTestUser;
let agencyId: string;
let clientId: string;

async function createVehicle() {
  const response = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      agencyId,
      name: "Clio",
      licensePlate: `ISA-${Math.floor(Math.random() * 1_000_000)}-ISA`,
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
  return (await response.json()).vehicle as { id: string };
}

/** Crée une location ACTIVE (dates entièrement passées) + facture finalisée (SENT, sans
 * paiement) — transitions autorisées quel que soit le statut réel des dates (même principe que
 * vehicle-mobility-alerts.test.ts). */
async function createActiveLocationWithSentInvoice(overrides: { dueDate?: string } = {}) {
  const vehicle = await createVehicle();
  const locationResponse = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      vehicleId: vehicle.id,
      clientId,
      startDate: "2020-01-10",
      endDate: "2020-01-13",
    }),
  });
  const locationId = (await locationResponse.json()).location.id;

  await apiFetch(`/api/locations/${locationId}`, {
    method: "PATCH",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ status: "CONFIRMED" }),
  });
  await apiFetch(`/api/locations/${locationId}`, {
    method: "PATCH",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ status: "ACTIVE" }),
  });

  const invoiceResponse = await apiFetch("/api/invoices", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ locationId }),
  });
  const invoiceId = (await invoiceResponse.json()).invoice.id;

  // Finding F : DRAFT → SENT est désormais inconditionnel vis-à-vis du solde — une facture
  // jamais payée peut donc être finalisée (verrouillée, en attente de règlement).
  const finalizeResponse = await apiFetch(`/api/invoices/${invoiceId}`, {
    method: "PATCH",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ status: "ISSUED", ...overrides }),
  });
  const invoice = (await finalizeResponse.json()).invoice;
  expect(invoice.status).toBe("ISSUED");
  expect(invoice.amountPaid).toBe(0);

  return { locationId, invoiceId, vehicleId: vehicle.id };
}

beforeAll(async () => {
  admin = await registerTenantAdmin({
    tenantName: "Invoice Status Alerts Test",
    tenantSlug: `invoice-status-alerts-test-${runId}`,
    name: "Admin",
    email: `admin-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(admin.tenantId);

  // Sprint 13E tâche 2 (revue INC-3) : réclame préventivement le throttle horaire de
  // `maybeRunScheduledAlertChecks` pour ce tenant — le CRON global
  // (`runScheduledAlertChecksForAllTenants`, scheduled-alerts-cron.test.ts) l'ignorera donc
  // silencieusement pendant toute la durée de ce fichier, éliminant complètement (pas seulement
  // en probabilité) le risque qu'il crée en avance, pour le compte d'un autre process, une alerte
  // que les tests ci-dessous s'attendent à voir créée par leur propre appel explicite à
  // `POST /api/tasks/check-alerts` (endpoint distinct, non throttlé).
  await prisma.tenant.update({ where: { id: admin.tenantId }, data: { lastAlertCheckAt: new Date() } });

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: "Agence Alertes Facture", slug: `isa-agence-${runId}` }),
  });
  agencyId = (await agencyResponse.json()).agency.id;

  const clientResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      name: "Client Alertes Facture",
      email: `client-isa-${runId}@test.local`,
      licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01",
    }),
  });
  clientId = (await clientResponse.json()).client.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashEntry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.payment.deleteMany({ where: { invoice: { tenantId: { in: createdTenantIds } } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("POST /api/tasks/check-alerts — Finding F, facture SENT sans paiement", () => {
  it("INVOICE_OVERDUE se déclenche pour une facture SENT (jamais payée) à échéance dépassée", async () => {
    const { invoiceId } = await createActiveLocationWithSentInvoice({ dueDate: "2020-02-01" });

    // Sprint 13E tâche 2 (revue INC-3) : le CRON global (`runScheduledAlertChecksForAllTenants`,
    // scheduled-alerts-cron.test.ts) scanne tous les tenants de la base de test, y compris
    // celui-ci — sous la suite complète, il peut créer cette même alerte (dédoublonnage correct,
    // comportement production voulu) entre la création de la facture ci-dessus et l'appel
    // explicite ci-dessous, ce qui ferait légitimement remonter `created.overdueInvoices` à 0
    // pour CET appel précis (l'alerte existe déjà, créée par ailleurs) — sans rapport avec le
    // comportement réellement testé ici (que CET appel la déclenche). On garantit donc la
    // précondition explicitement plutôt que de supposer qu'aucun autre processus global n'a pu
    // intervenir entre-temps — n'affaiblit aucune assertion.
    await prisma.alert.deleteMany({ where: { tenantId: admin.tenantId, entityType: "Invoice", entityId: invoiceId } });

    const response = await apiFetch("/api/tasks/check-alerts", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.created.overdueInvoices).toBeGreaterThanOrEqual(1);

    const alertsResponse = await apiFetch("/api/alerts?type=INVOICE_OVERDUE", {
      headers: { Cookie: admin.sessionCookie },
    });
    const alerts = (await alertsResponse.json()).alerts;
    const alert = alerts.find((a: { entityId: string }) => a.entityId === invoiceId);
    expect(alert).toBeDefined();
    expect(alert.status).toBe("PENDING");
  });

  it("CONTRACT_AT_RISK se déclenche pour un contrat ACTIVE dont le retour est dépassé, facture SENT sans paiement", async () => {
    const { locationId } = await createActiveLocationWithSentInvoice();

    // Sprint 13E tâche 2 (revue INC-3) : même précaution que le test précédent — garantit que
    // cet appel est bien celui qui déclenche l'alerte, indépendamment d'un CRON global
    // concurrent (voir commentaire détaillé au test précédent).
    await prisma.alert.deleteMany({ where: { tenantId: admin.tenantId, entityType: "LocationAtRisk", entityId: locationId } });

    const response = await apiFetch("/api/tasks/check-alerts", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.created.contractsAtRisk).toBeGreaterThanOrEqual(1);

    const alertsResponse = await apiFetch("/api/alerts?type=CONTRACT_AT_RISK", {
      headers: { Cookie: admin.sessionCookie },
    });
    const alerts = (await alertsResponse.json()).alerts;
    const alert = alerts.find((a: { entityId: string }) => a.entityId === locationId);
    expect(alert).toBeDefined();
    expect(alert.priority).toBe("URGENT");
  });

  it("PAYMENT_DUE se déclenche pour un contrat COMPLETED, facture SENT sans paiement", async () => {
    const { locationId, invoiceId } = await createActiveLocationWithSentInvoice();

    await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });

    // Sprint 13E tâche 2 (revue INC-3) : même précaution que les deux tests précédents.
    await prisma.alert.deleteMany({ where: { tenantId: admin.tenantId, entityType: "InvoicePaymentDue", entityId: invoiceId } });

    const response = await apiFetch("/api/tasks/check-alerts", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.created.paymentsDue).toBeGreaterThanOrEqual(1);

    const alertsResponse = await apiFetch("/api/alerts?type=PAYMENT_DUE", {
      headers: { Cookie: admin.sessionCookie },
    });
    const alerts = (await alertsResponse.json()).alerts;
    const alert = alerts.find((a: { entityId: string }) => a.entityId === invoiceId);
    expect(alert).toBeDefined();
    expect(alert.status).toBe("PENDING");
  });
});
