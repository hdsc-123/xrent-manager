import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

/**
 * Sprint 33 (DOMAINRULES.md section 48) — tests SSR de /dashboard/damage-invoices (liste) et
 * /dashboard/damage-invoices/[id] (détail), même paradigme que return-damages-ui.test.tsx : un
 * vrai serveur next dev de test rend les pages, on vérifie le HTML produit — pas de jsdom/
 * @testing-library. La logique métier (solde, encaissement, annulation) est déjà couverte par
 * damage-invoices-route.test.ts — ce fichier vérifie uniquement ce que le serveur *affiche*.
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let agencyA1Id: string;
let vehicleAId: string;
let clientAId: string;
let dateOffset = 0;

async function createBilledDamageInvoice(billableAmount = 1000): Promise<{ invoiceId: string; number: string }> {
  dateOffset += 10;
  const base = new Date(Date.UTC(2028, 0, 1));
  const start = new Date(base.getTime() + dateOffset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);

  const locationResponse = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      vehicleId: vehicleAId,
      clientId: clientAId,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    }),
  });
  const { location } = await locationResponse.json();

  const damageResponse = await apiFetch("/api/damages", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ locationId: location.id, nature: "Rayure test UI", billableAmount }),
  });
  const body = await damageResponse.json();
  return { invoiceId: body.damageInvoice.id as string, number: body.damageInvoice.number as string };
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

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Damage Invoices UI Test",
    tenantSlug: `damage-invoices-ui-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A1", slug: `agence-a1-${runId}` }),
  });
  agencyA1Id = (await agencyResponse.json()).agency.id;

  const vehicleResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      agencyId: agencyA1Id,
      name: "Clio",
      licensePlate: `DIU-${runId}`,
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
  await prisma.payment.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.damageInvoiceLine.deleteMany({ where: { damageInvoice: { tenantId: { in: createdTenantIds } } } });
  await prisma.damage.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.damageInvoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { user: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashEntry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashRegister.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.groupPermission.deleteMany({ where: { group: { tenantId: { in: createdTenantIds } } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
});

describe("/dashboard/damage-invoices — liste", () => {
  it("refuse l'accès sans authentification", async () => {
    const response = await apiFetch("/dashboard/damage-invoices", { redirect: "manual" });
    expect(response.status).toBe(307);
  });

  it("affiche un message pour un MEMBER sans damage_invoices.view", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No View UI",
      email: `no-view-ui-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    const response = await apiFetch("/dashboard/damage-invoices", { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("permission de consulter les factures de dégâts");
  });

  it("liste les factures de dégâts avec leur numéro et statut", async () => {
    const { number } = await createBilledDamageInvoice(1200);
    const response = await apiFetch("/dashboard/damage-invoices", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(number);
    expect(html).toContain("Factures de dégâts");
  });
});

describe("/dashboard/damage-invoices/[id] — détail", () => {
  it("affiche le numéro, les lignes, le solde et le bouton PDF pour un ADMIN", async () => {
    const { invoiceId, number } = await createBilledDamageInvoice(2000);
    const response = await apiFetch(`/dashboard/damage-invoices/${invoiceId}`, { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(number);
    expect(html).toContain("Rayure test UI");
    expect(html).toContain("Solde dû");
    expect(html).toContain(`/api/damage-invoices/${invoiceId}/pdf`);
    expect(html).toContain("Encaisser un paiement");
    expect(html).toContain("Annuler la facture");
  });

  it("masque les actions à un MEMBER sans les permissions dédiées", async () => {
    const { invoiceId } = await createBilledDamageInvoice(2000);
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Read Only",
      email: `read-only-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA1Id } });
    await grantPermissions(member.userId, ["damage_invoices.view"], "ReadOnly");

    const response = await apiFetch(`/dashboard/damage-invoices/${invoiceId}`, { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("Encaisser un paiement");
    expect(html).not.toContain("Annuler la facture");
    expect(html).not.toContain(`/api/damage-invoices/${invoiceId}/pdf`);
  });

  it("renvoie une page « introuvable » pour une facture d'un autre tenant", async () => {
    const { invoiceId } = await createBilledDamageInvoice(1000);
    const adminB = await registerTenantAdmin({
      tenantName: "Damage Invoices UI Test B",
      tenantSlug: `damage-invoices-ui-b-${runId}`,
      name: "Admin B",
      email: `admin-b-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    createdTenantIds.push(adminB.tenantId);

    const response = await apiFetch(`/dashboard/damage-invoices/${invoiceId}`, { headers: { Cookie: adminB.sessionCookie } });
    // Correctif sprint soft 404 (2026-08-24) : /dashboard/damage-invoices/[id] est désormais
    // couverte par le garde de route centralisé (src/lib/route-guards.ts, exécuté depuis
    // src/proxy.ts avant toute frontière Suspense) — vrai statut HTTP 404, plus un "soft 404"
    // (200 + noindex). Voir SECURITY.md section 35 et DOMAINRULES.md section 64.
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('name="robots" content="noindex"');
  });
});
