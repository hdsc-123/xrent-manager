import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createAlert } from "@/lib/alerts";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const password = "Correct-Horse-Battery-Staple9!";
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Audit Test A",
    tenantSlug: `audit-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Audit Test B",
    tenantSlug: `audit-test-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(adminB.tenantId);
});

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
  await prisma.$disconnect();
});

describe("Journal d'audit (Sprint 9)", () => {
  it("enregistre une entrée lors d'un changement de rôle", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Audited Member",
      email: `audited-role-${runId}@test.local`,
      password,
    });

    await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ role: "ADMIN" }),
    });

    const logs = await prisma.auditLog.findMany({
      where: { tenantId: adminA.tenantId, resource: "User", resourceId: member.userId },
    });
    expect(logs.some((log) => log.action === "user.role_changed")).toBe(true);
  });

  it("enregistre une entrée lors de la création d'une invitation", async () => {
    const response = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email: `audit-invite-${runId}@test.local` }),
    });
    const invitationId = (await response.json()).invitation.id;

    const logs = await prisma.auditLog.findMany({
      where: { tenantId: adminA.tenantId, resource: "Invitation", resourceId: invitationId },
    });
    expect(logs.some((log) => log.action === "invitation.created")).toBe(true);
  });

  it("GET /api/audit refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/audit");
    expect(response.status).toBe(401);
  });

  it("GET /api/audit refuse un MEMBER", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Audit Reader",
      email: `audit-reader-${runId}@test.local`,
      password,
    });
    const response = await apiFetch("/api/audit", { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(403);
  });

  it("GET /api/audit ne retourne que les logs du tenant connecté (isolation)", async () => {
    await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({ email: `audit-b-${runId}@test.local` }),
    });

    const response = await apiFetch("/api/audit", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.logs.every((log: { tenantId: string }) => log.tenantId === adminA.tenantId)).toBe(true);
  });

  // Phase 2.1 (2026-08-31, finalisation des permissions d'audit) : audit.view est décorative par
  // décision explicite (DOMAINRULES.md section 22) — GET /api/audit ne consulte jamais can(),
  // uniquement role === "ADMIN". Un MEMBER qui se voit accorder cette clé via un groupe
  // personnalisé doit donc rester bloqué, exactement comme un MEMBER sans cette clé.
  it("GET /api/audit refuse un MEMBER même avec audit.view accordé via un groupe personnalisé (permission décorative, DOMAINRULES.md section 22)", async () => {
    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `AuditViewers-${runId}`, permissions: ["audit.view"] }),
    });
    const groupId = (await groupResponse.json()).group.id;

    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Would-be Auditor Reader",
      email: `would-be-auditor-reader-${runId}@test.local`,
      password,
    });
    await apiFetch(`/api/users/${member.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: groupId }),
    });

    const response = await apiFetch("/api/audit", { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(403);
  });

  // Phase 2.1 : le Super Admin plateforme (SUPER_ADMIN_EMAILS, src/lib/super-admin.ts) est un
  // mécanisme distinct et non interchangeable avec l'ADMIN d'un tenant (CLAUDE.md règle 13) —
  // isSuperAdminEmail() n'est référencée nulle part dans le module audit (vérifié par lecture de
  // src/app/api/audit/**). Ce test le confirme empiriquement : un compte flaggé Super Admin
  // plateforme ne voit que l'audit de SON PROPRE tenant, jamais celui d'un autre tenant.
  it("GET /api/audit — un Super Admin plateforme ne voit jamais l'audit d'un autre tenant que le sien (aucun droit automatique, CLAUDE.md règle 13)", async () => {
    const superAdmin = await registerTenantAdmin({
      tenantName: "Audit Super Admin Home",
      tenantSlug: `audit-super-admin-home-${runId}`,
      name: "Super Admin",
      email: `audit-super-admin-${runId}@superadmin.test.local`,
      password,
    });
    createdTenantIds.push(superAdmin.tenantId);

    await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: superAdmin.sessionCookie },
      body: JSON.stringify({ email: `audit-super-admin-invite-${runId}@test.local` }),
    });

    const response = await apiFetch("/api/audit", { headers: { Cookie: superAdmin.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.logs.length).toBeGreaterThan(0);
    expect(body.logs.every((log: { tenantId: string }) => log.tenantId === superAdmin.tenantId)).toBe(true);
    expect(body.logs.some((log: { tenantId: string }) => log.tenantId === adminB.tenantId)).toBe(false);
  });
});

describe("Journal d'audit exhaustif sur le CRUD métier (Sprint 10)", () => {
  async function findLog(resource: string, resourceId: string) {
    return prisma.auditLog.findMany({
      where: { tenantId: adminA.tenantId, resource, resourceId },
      orderBy: { createdAt: "desc" },
    });
  }

  it("trace la création/modification/suppression d'un véhicule", async () => {
    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence Audit", slug: `agence-audit-${runId}` }),
    });
    const agencyId = (await agencyResponse.json()).agency.id;

    const createResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId,
        name: "Clio Audit",
        licensePlate: `AU-${Math.floor(Math.random() * 1_000_000)}-AU`,
        make: "Renault",
        model: "Clio",
        year: 2022,
        category: "Citadine",
        pricePerDay: 4500,
        chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
        color: "Blanc",
        doors: 5,
        seats: 5,
        horsepower: 6,
        powerKW: 75,
        engineSize: 1.5,
      }),
    });
    const vehicleId = (await createResponse.json()).vehicle.id;
    expect((await findLog("Vehicle", vehicleId)).some((log) => log.action === "vehicle.created")).toBe(true);

    await apiFetch(`/api/vehicles/${vehicleId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ pricePerDay: 5000 }),
    });
    expect((await findLog("Vehicle", vehicleId)).some((log) => log.action === "vehicle.updated")).toBe(true);

    await apiFetch(`/api/vehicles/${vehicleId}`, { method: "DELETE", headers: { Cookie: adminA.sessionCookie } });
    expect((await findLog("Vehicle", vehicleId)).some((log) => log.action === "vehicle.deleted")).toBe(true);
  });

  it("trace la création/modification/suppression d'un client", async () => {
    const createResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Client Audit" }),
    });
    const clientId = (await createResponse.json()).client.id;
    expect((await findLog("Client", clientId)).some((log) => log.action === "client.created")).toBe(true);

    await apiFetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ phone: "0600000000" }),
    });
    expect((await findLog("Client", clientId)).some((log) => log.action === "client.updated")).toBe(true);

    await apiFetch(`/api/clients/${clientId}`, { method: "DELETE", headers: { Cookie: adminA.sessionCookie } });
    expect((await findLog("Client", clientId)).some((log) => log.action === "client.deleted")).toBe(true);
  });

  it("trace le cycle complet location → facture → paiement → maintenance → alerte", async () => {
    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence Audit Cycle", slug: `agence-audit-cycle-${runId}` }),
    });
    const agencyId = (await agencyResponse.json()).agency.id;

    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId,
        name: "Clio Cycle",
        licensePlate: `CY-${Math.floor(Math.random() * 1_000_000)}-CY`,
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
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const clientResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Client Cycle", licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
    });
    const clientId = (await clientResponse.json()).client.id;

    const locationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        clientId,
        startDate: "2029-01-10",
        endDate: "2029-01-13",
      }),
    });
    const locationId = (await locationResponse.json()).location.id;
    expect((await findLog("Location", locationId)).some((log) => log.action === "location.created")).toBe(true);

    await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(
      (await findLog("Location", locationId)).some((log) => log.action === "location.status_changed")
    ).toBe(true);

    const invoiceResponse = await apiFetch("/api/invoices", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ locationId }),
    });
    const invoiceId = (await invoiceResponse.json()).invoice.id;
    expect((await findLog("Invoice", invoiceId)).some((log) => log.action === "invoice.created")).toBe(true);

    // Finding F : un paiement direct (POST /api/payments) est refusé sur une facture encore
    // DRAFT (InvoiceNotFinalizedError, src/lib/payments.ts) — finalise d'abord, et vérifie que
    // cette finalisation manuelle reste bien journalisée (invoice.status_changed, inchangé).
    const finalizeResponse = await apiFetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ISSUED" }),
    });
    expect(finalizeResponse.status).toBe(200);
    expect(
      (await findLog("Invoice", invoiceId)).some((log) => log.action === "invoice.status_changed")
    ).toBe(true);

    const paymentResponse = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId, amount: 5000, method: "CASH" }),
    });
    const paymentId = (await paymentResponse.json()).payment.id;
    expect((await findLog("Payment", paymentId)).some((log) => log.action === "payment.created")).toBe(true);

    await apiFetch(`/api/payments/${paymentId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reference: "REF-AUDIT" }),
    });
    expect((await findLog("Payment", paymentId)).some((log) => log.action === "payment.updated")).toBe(true);

    // Sprint 26D (Finding D1) : ce paiement est déjà reflété en caisse (CashEntry créée par
    // recordPaymentCashEntry) — sa suppression physique est désormais refusée (409, voir
    // PaymentHasCashEntryError, src/lib/payments.ts) ; aucune écriture d'audit
    // "payment.deleted" n'est donc produite pour ce cas, la route retournant avant même
    // d'appeler logAction. La couverture d'audit de payment.deleted (cas résiduel — un
    // paiement jamais reflété en caisse) reste testée dans payments.test.ts.
    const deleteResponse = await apiFetch(`/api/payments/${paymentId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(409);
    expect((await findLog("Payment", paymentId)).some((log) => log.action === "payment.deleted")).toBe(false);

    const maintenanceResponse = await apiFetch("/api/maintenances", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId, type: "OIL_CHANGE", scheduledDate: "2030-06-01" }),
    });
    const maintenanceId = (await maintenanceResponse.json()).maintenance.id;
    expect(
      (await findLog("Maintenance", maintenanceId)).some((log) => log.action === "maintenance.created")
    ).toBe(true);

    await apiFetch(`/api/maintenances/${maintenanceId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    expect(
      (await findLog("Maintenance", maintenanceId)).some((log) => log.action === "maintenance.status_changed")
    ).toBe(true);

    await apiFetch(`/api/maintenances/${maintenanceId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    // COMPLETED n'est pas supprimable (historique conservé) : aucune entrée deleted attendue ici.

    const alert = await createAlert({
      tenantId: adminA.tenantId,
      type: "OTHER",
      message: "Alerte de test audit",
    });

    await apiFetch(`/api/alerts/${alert.id}/acknowledge`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect((await findLog("Alert", alert.id)).some((log) => log.action === "alert.acknowledged")).toBe(true);

    await apiFetch(`/api/alerts/${alert.id}/resolve`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect((await findLog("Alert", alert.id)).some((log) => log.action === "alert.resolved")).toBe(true);
  });

  it("Finding F — un paiement direct refusé sur une facture DRAFT ne journalise rien (ni payment.created, ni invoice.status_changed)", async () => {
    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence Audit Finding F", slug: `agence-audit-f-${runId}` }),
    });
    const agencyId = (await agencyResponse.json()).agency.id;

    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId,
        name: "Clio Finding F",
        licensePlate: `FF-${Math.floor(Math.random() * 1_000_000)}-FF`,
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
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const clientResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Client Finding F", licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
    });
    const clientId = (await clientResponse.json()).client.id;

    const locationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId, clientId, startDate: "2029-02-10", endDate: "2029-02-13" }),
    });
    const locationId = (await locationResponse.json()).location.id;

    const invoiceResponse = await apiFetch("/api/invoices", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ locationId }),
    });
    const invoiceId = (await invoiceResponse.json()).invoice.id;

    const before = new Date();
    const paymentResponse = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId, amount: 5000, method: "CASH" }),
    });
    expect(paymentResponse.status).toBe(409);

    expect(
      (await findLog("Invoice", invoiceId)).some(
        (log) => log.action === "invoice.status_changed" && log.createdAt >= before
      )
    ).toBe(false);
    const paymentLogsSince = await prisma.auditLog.findMany({
      where: { tenantId: adminA.tenantId, resource: "Payment", action: "payment.created", createdAt: { gte: before } },
    });
    expect(paymentLogsSince).toEqual([]);
  });
});

describe("Journal d'audit — Sprint 15 (agences, tenant, invitation → user)", () => {
  async function findLog(resource: string, resourceId: string) {
    return prisma.auditLog.findMany({
      where: { tenantId: adminA.tenantId, resource, resourceId },
      orderBy: { createdAt: "desc" },
    });
  }

  it("trace la création d'une agence (agency.created)", async () => {
    const response = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence Audit S15", slug: `agence-audit-s15-${runId}` }),
    });
    expect(response.status).toBe(201);
    const agency = (await response.json()).agency;

    const log = (await findLog("Agency", agency.id)).find((entry) => entry.action === "agency.created");
    expect(log).toBeDefined();
    expect(log?.resource).toBe("Agency");
    expect(log?.tenantId).toBe(adminA.tenantId);
    expect(log?.userId).toBe(adminA.userId);
  });

  it("trace la modification d'une agence, avec previousNumbering uniquement quand la numérotation change", async () => {
    const createResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence Audit Numbering", slug: `agence-audit-numbering-${runId}` }),
    });
    const agency = (await createResponse.json()).agency;

    // Modification sans toucher à la numérotation : pas de previousNumbering dans les metadata.
    await apiFetch(`/api/agencies/${agency.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence Audit Numbering (renommée)" }),
    });
    const simpleLog = (await findLog("Agency", agency.id)).find((entry) => entry.action === "agency.updated");
    expect(simpleLog).toBeDefined();
    const simpleMetadata = simpleLog?.metadata as {
      changes?: Record<string, unknown>;
      previousNumbering?: unknown;
    } | null;
    expect(simpleMetadata?.changes).toEqual({ name: "Agence Audit Numbering (renommée)" });
    expect(simpleMetadata?.previousNumbering).toBeUndefined();

    // Modification de la numérotation : previousNumbering doit refléter les valeurs précédentes
    // (défauts d'une agence fraîchement créée : préfixe vide, dernier numéro à 0).
    await apiFetch(`/api/agencies/${agency.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ contractNumberPrefix: "AUD", lastContractNumber: 7 }),
    });
    const numberingLogs = (await findLog("Agency", agency.id)).filter((entry) => entry.action === "agency.updated");
    const numberingLog = numberingLogs[0]; // le plus récent (orderBy createdAt desc)
    const numberingMetadata = numberingLog?.metadata as {
      changes?: Record<string, unknown>;
      previousNumbering?: { contractNumberPrefix: string; lastContractNumber: number };
    } | null;
    expect(numberingMetadata?.previousNumbering).toEqual({ contractNumberPrefix: "", lastContractNumber: 0 });
  });

  it("trace la suppression d'une agence (agency.deleted)", async () => {
    const createResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence Audit Delete", slug: `agence-audit-delete-${runId}` }),
    });
    const agency = (await createResponse.json()).agency;

    const deleteResponse = await apiFetch(`/api/agencies/${agency.id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(200);

    const logs = await findLog("Agency", agency.id);
    expect(logs.some((entry) => entry.action === "agency.deleted")).toBe(true);
  });

  it("trace la modification du tenant (tenant.updated), auparavant non journalisée", async () => {
    const response = await apiFetch(`/api/tenants/${adminA.tenantId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Audit Test A (renommé Sprint 15)" }),
    });
    expect(response.status).toBe(200);

    const logs = await prisma.auditLog.findMany({
      where: { tenantId: adminA.tenantId, resource: "Tenant", resourceId: adminA.tenantId },
    });
    const log = logs.find((entry) => entry.action === "tenant.updated");
    expect(log).toBeDefined();
    expect(log?.userId).toBe(adminA.userId);
    const metadata = log?.metadata as { changes?: Record<string, unknown> } | null;
    expect(metadata?.changes).toEqual({ name: "Audit Test A (renommé Sprint 15)" });
  });

  it("trace à la fois invitation.accepted et user.created pour une seule acceptation d'invitation", async () => {
    const email = `audit-accept-s15-${runId}@test.local`;
    const createResponse = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email, role: "MEMBER" }),
    });
    const invitationId = (await createResponse.json()).invitation.id;

    const acceptResponse = await apiFetch(`/api/invitations/${invitationId}/accept`, {
      method: "POST",
      body: JSON.stringify({ name: "Audit Accept S15", password }),
    });
    expect(acceptResponse.status).toBe(200);
    const userId = (await acceptResponse.json()).user.id;

    const invitationLogs = await findLog("Invitation", invitationId);
    expect(invitationLogs.some((entry) => entry.action === "invitation.accepted")).toBe(true);

    const userLogs = await findLog("User", userId);
    const userCreatedLog = userLogs.find((entry) => entry.action === "user.created");
    expect(userCreatedLog).toBeDefined();
    expect(userCreatedLog?.userId).toBe(userId);
    const metadata = userCreatedLog?.metadata as { email?: string; role?: string } | null;
    expect(metadata?.email).toBe(email);
    expect(metadata?.role).toBe("MEMBER");
  });

  it("la page /dashboard/audit rend correctement les nouvelles actions", async () => {
    const response = await apiFetch("/dashboard/audit", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Agence créée");
    expect(html).toContain("Agence modifiée");
    expect(html).toContain("Agence supprimée");
    expect(html).toContain("Tenant modifié");
    expect(html).toContain("Utilisateur créé");
  });
});
