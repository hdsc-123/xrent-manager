import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createAlert } from "@/lib/alerts";
import { apiFetch, extractSessionCookie } from "./helpers/http";
import { registerTenantAdmin } from "./helpers/fixtures";

/**
 * Scénario de bout en bout couvrant l'intégralité du MVP (Sprint 10) : inscription,
 * résolution de tenant à la connexion (Option B, Sprint 9), CRUD métier complet
 * (véhicules, locations, clients, factures, paiements, maintenances, alertes),
 * édition du profil (Sprint 10), rapports, et vérification finale du journal d'audit
 * exhaustif (Sprint 10). Distinct de src/__tests__/e2e.test.ts (Sprint 9, plus court,
 * sans sélection de tenant ni maintenances/alertes/profil/audit exhaustif).
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const password = "Correct-Horse-Battery-Staple9!";
const sharedEmail = `e2e-full-shared-${runId}@test.local`;
const createdTenantIds: string[] = [];

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invitation.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashEntry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashRegister.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.payment.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.maintenance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("Scénario complet Sprint 10 : inscription → sélection de tenant → CRUD complet → facturation → rapports → audit", () => {
  it("parcourt le cycle de vie complet du MVP sans erreur", async () => {
    // 1. Inscription de deux tenants distincts partageant le même email admin, pour
    // exercer la résolution de tenant à la connexion (Option B, Sprint 9).
    const tenant1 = await registerTenantAdmin({
      tenantName: "E2E Full Tenant 1",
      tenantSlug: `e2e-full-1-${runId}`,
      name: "Admin Tenant 1",
      email: sharedEmail,
      password,
    });
    createdTenantIds.push(tenant1.tenantId);

    const registerTenant2 = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        tenantName: "E2E Full Tenant 2",
        tenantSlug: `e2e-full-2-${runId}`,
        name: "Admin Tenant 2",
        email: sharedEmail,
        password,
      }),
    });
    expect(registerTenant2.status).toBe(201);
    const tenant2 = await registerTenant2.json();
    createdTenantIds.push(tenant2.tenant.id);

    // 2. Connexion sans tenantId : l'email est ambigu (2 tenants), la liste doit être
    // révélée sans créer de session, seulement après vérification du mot de passe.
    const ambiguousLogin = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: sharedEmail, password }),
    });
    expect(ambiguousLogin.status).toBe(200);
    const ambiguousBody = await ambiguousLogin.json();
    expect(ambiguousBody.requiresTenantSelection).toBe(true);
    expect(ambiguousBody.tenants).toHaveLength(2);
    expect(extractSessionCookie(ambiguousLogin)).toBeUndefined();

    // Mauvais mot de passe : ne doit jamais révéler la liste des tenants.
    const wrongPasswordLogin = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: sharedEmail, password: "wrong-password" }),
    });
    expect(wrongPasswordLogin.status).toBe(401);

    // 3. Connexion explicite au tenant 1 (sélection).
    const login1 = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: sharedEmail, password, tenantId: tenant1.tenantId }),
    });
    expect(login1.status).toBe(200);
    const sessionCookie = extractSessionCookie(login1);
    expect(sessionCookie).toBeDefined();
    const admin = { ...tenant1, sessionCookie: sessionCookie! };

    // 4. CRUD complet : agence → véhicule → client → location → transitions de statut.
    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: "Agence E2E Full", slug: `agence-e2e-full-${runId}` }),
    });
    expect(agencyResponse.status).toBe(201);
    const agencyId = (await agencyResponse.json()).agency.id;

    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({
        agencyId,
        name: "Clio E2E Full",
        licensePlate: `EF-${runId}`,
        make: "Renault",
        model: "Clio",
        year: 2024,
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
    expect(vehicleResponse.status).toBe(201);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const clientResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: "Client E2E Full", licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
    });
    expect(clientResponse.status).toBe(201);
    const clientId = (await clientResponse.json()).client.id;

    const locationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ vehicleId, clientId, startDate: "2031-01-01", endDate: "2031-01-04" }),
    });
    expect(locationResponse.status).toBe(201);
    const location = (await locationResponse.json()).location;
    expect(location.totalPrice).toBe(15000);

    const confirmResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(confirmResponse.status).toBe(200);

    // 5. Facturation et paiement.
    // Sprint 13E tâche 3 : POST /api/locations a déjà auto-généré la facture RENTAL de cette
    // location (getOrCreateMainInvoice) — cet appel la récupère donc de façon idempotente (200),
    // il n'en crée plus une seconde (comportement volontairement changé, voir DOMAINRULES.md).
    const invoiceResponse = await apiFetch("/api/invoices", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ locationId: location.id }),
    });
    expect(invoiceResponse.status).toBe(200);
    const invoice = (await invoiceResponse.json()).invoice;

    // Finding F : un paiement direct est refusé sur une facture encore DRAFT — finalise
    // d'abord (DRAFT → SENT, inconditionnel vis-à-vis du solde).
    const finalizeResponse = await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ status: "ISSUED" }),
    });
    expect(finalizeResponse.status).toBe(200);

    const paymentResponse = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: invoice.totalAmount, method: "CASH" }),
    });
    expect(paymentResponse.status).toBe(201);

    const invoiceAfterPayment = await apiFetch(`/api/invoices/${invoice.id}`, {
      headers: { Cookie: admin.sessionCookie },
    });
    expect((await invoiceAfterPayment.json()).invoice.status).toBe("PAID");

    // 6. Maintenance planifiée puis terminée.
    const maintenanceResponse = await apiFetch("/api/maintenances", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ vehicleId, type: "OIL_CHANGE", scheduledDate: "2031-06-01" }),
    });
    expect(maintenanceResponse.status).toBe(201);
    const maintenanceId = (await maintenanceResponse.json()).maintenance.id;

    const completeMaintenanceResponse = await apiFetch(`/api/maintenances/${maintenanceId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    expect(completeMaintenanceResponse.status).toBe(200);

    // 7. Alerte : créée par le système (createAlert direct, comme scheduled-tasks.ts le
    // ferait), puis acquittée et résolue via les routes API.
    const alert = await createAlert({
      tenantId: admin.tenantId,
      type: "OTHER",
      message: "Alerte E2E Full",
    });
    const acknowledgeResponse = await apiFetch(`/api/alerts/${alert.id}/acknowledge`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
    });
    expect(acknowledgeResponse.status).toBe(200);
    const resolveResponse = await apiFetch(`/api/alerts/${alert.id}/resolve`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
    });
    expect(resolveResponse.status).toBe(200);

    // 8. Rapports (ADMIN uniquement).
    const reportFrom = new Date();
    reportFrom.setUTCDate(reportFrom.getUTCDate() - 1);
    const reportTo = new Date();
    reportTo.setUTCDate(reportTo.getUTCDate() + 1);
    const reportResponse = await apiFetch(
      `/api/reports/revenue?from=${reportFrom.toISOString().slice(0, 10)}&to=${reportTo.toISOString().slice(0, 10)}`,
      { headers: { Cookie: admin.sessionCookie } }
    );
    expect(reportResponse.status).toBe(200);
    const report = await reportResponse.json();
    expect(report.totalRevenue).toBeGreaterThanOrEqual(invoice.totalAmount);

    // 9. Édition du profil par l'user lui-même (Sprint 10).
    const profileUpdateResponse = await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: "Admin Tenant 1 (modifié)" }),
    });
    expect(profileUpdateResponse.status).toBe(200);
    expect((await profileUpdateResponse.json()).user.name).toBe("Admin Tenant 1 (modifié)");

    // 10. Vérification finale : le journal d'audit reflète l'ensemble du cycle métier
    // (Sprint 10 — audit exhaustif, pas seulement les actions Sprint 9).
    const auditResponse = await apiFetch("/api/audit", { headers: { Cookie: admin.sessionCookie } });
    expect(auditResponse.status).toBe(200);
    const auditBody = await auditResponse.json();
    const actions = new Set(auditBody.logs.map((log: { action: string }) => log.action));

    for (const expectedAction of [
      "vehicle.created",
      "location.created",
      "location.status_changed",
      "invoice.created",
      "payment.created",
      "maintenance.created",
      "maintenance.status_changed",
      "alert.acknowledged",
      "alert.resolved",
      "user.profile_updated",
    ]) {
      expect(actions.has(expectedAction)).toBe(true);
    }

    // Toutes les entrées d'audit sont bien scopées au tenant connecté.
    expect(auditBody.logs.every((log: { tenantId: string }) => log.tenantId === admin.tenantId)).toBe(true);
  });
});
