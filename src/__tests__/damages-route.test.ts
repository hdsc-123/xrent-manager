import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

/**
 * Sprint 32 (DOMAINRULES.md section 32) — tests HTTP de POST/GET /api/damages et
 * GET /api/damages/[id]. La logique métier (solde du dégât, double encaissement, statut
 * dérivé) est déjà couverte par src/__tests__/damages.test.ts (appel direct du service) — ce
 * fichier vérifie ce que la route ajoute : authentification, permissions, portée tenant/
 * agence, forme du corps de requête, codes d'erreur sûrs.
 *
 * Sprint 33 (DOMAINRULES.md section 48) : POST /api/damages/[id]/payments retiré (paiement
 * direct de dégât sans facture) — les tests d'encaissement déplacés vers
 * src/__tests__/damage-invoices-route.test.ts (POST /api/damage-invoices/[id]/payments). Ce
 * fichier gagne en revanche les tests PATCH /api/damages/[id] (damages.edit) et la vérification
 * que POST /api/damages facture automatiquement un dégât facturable.
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let agencyA1Id: string;
let vehicleAId: string;
let clientAId: string;
let dateOffset = 0;

async function createLocationA(overrides: Record<string, unknown> = {}): Promise<string> {
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
  return location.id as string;
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

async function createDamageA(locationId: string, billableAmount?: number): Promise<string> {
  const response = await apiFetch("/api/damages", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ locationId, nature: "Rayure test", billableAmount }),
  });
  const { damage } = await response.json();
  return damage.id as string;
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Damages Route Test A",
    tenantSlug: `damages-route-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Damages Route Test B",
    tenantSlug: `damages-route-b-${runId}`,
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

  const vehicleResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      agencyId: agencyA1Id,
      name: "Clio",
      licensePlate: `DMG-RT-${runId}`,
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

describe("POST /api/damages — authentification, permissions, portée", () => {
  it("refuse une requête non authentifiée", async () => {
    const locationId = await createLocationA();
    const response = await apiFetch("/api/damages", {
      method: "POST",
      body: JSON.stringify({ locationId, nature: "Rayure" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER sans damages.create", async () => {
    const locationId = await createLocationA();
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Damage Create",
      email: `no-damage-create-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA1Id } });
    await grantPermissions(member.userId, ["damages.view"], "NoDamageCreate");

    const response = await apiFetch("/api/damages", {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ locationId, nature: "Rayure" }),
    });
    expect(response.status).toBe(403);
  });

  it("refuse la création d'un dégât sur un contrat d'un autre tenant", async () => {
    const locationId = await createLocationA();
    const response = await apiFetch("/api/damages", {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({ locationId, nature: "Rayure" }),
    });
    expect(response.status).toBe(404);
  });

  it("refuse un MEMBER avec damages.create mais non rattaché à l'agence du contrat", async () => {
    const locationId = await createLocationA();
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Out Of Agency Damages",
      email: `out-agency-damages-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await grantPermissions(member.userId, ["damages.view", "damages.create"], "OutOfAgencyDamages");

    const response = await apiFetch("/api/damages", {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ locationId, nature: "Rayure" }),
    });
    expect(response.status).toBe(404);
  });

  it("crée un dégât non facturable, vehicleId dérivé du contrat (jamais accepté du client)", async () => {
    const locationId = await createLocationA();
    const response = await apiFetch("/api/damages", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ locationId, nature: "Rayure portière", vehicleId: "should-be-ignored" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.damage.vehicleId).toBe(vehicleAId);
    expect(body.damage.status).toBe("REPORTED");
    expect(body.damageInvoice).toBeNull();
  });

  it("crée un dégât facturable — génère automatiquement sa DamageInvoice (Sprint 33)", async () => {
    const locationId = await createLocationA();
    const response = await apiFetch("/api/damages", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ locationId, nature: "Rayure portière", billableAmount: 1000 }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.damage.damageInvoiceId).toBe(body.damageInvoice.id);
    expect(body.damageInvoice.status).toBe("SENT");
    expect(body.damageInvoice.totalAmount).toBe(1000);
    expect(body.damageInvoice.number.startsWith("FACT-DEG-")).toBe(true);
  });

  it("refuse un MEMBER avec damages.create mais sans damage_invoices.create pour un dégât facturable", async () => {
    const locationId = await createLocationA();
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Damage Invoice Create",
      email: `no-damage-invoice-create-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA1Id } });
    await grantPermissions(member.userId, ["damages.view", "damages.create"], "NoDamageInvoiceCreate");

    const response = await apiFetch("/api/damages", {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ locationId, nature: "Rayure", billableAmount: 1000 }),
    });
    expect(response.status).toBe(403);

    // Le même MEMBER peut en revanche déclarer un dégât non facturable (aucune facturation
    // impliquée, damages.create suffit).
    const nonBillable = await apiFetch("/api/damages", {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ locationId, nature: "Rayure sans montant" }),
    });
    expect(nonBillable.status).toBe(201);
  });

  it("refuse des données invalides (nature manquante)", async () => {
    const locationId = await createLocationA();
    const response = await apiFetch("/api/damages", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ locationId }),
    });
    expect(response.status).toBe(400);
  });
});

describe("GET /api/damages / GET /api/damages/[id] — portée", () => {
  it("exige vehicleId ou locationId", async () => {
    const response = await apiFetch("/api/damages", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(400);
  });

  it("refuse la consultation d'un dégât d'un autre tenant, sans révéler son existence", async () => {
    const locationId = await createLocationA();
    const damageId = await createDamageA(locationId, 1000);

    const response = await apiFetch(`/api/damages/${damageId}`, { headers: { Cookie: adminB.sessionCookie } });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["error"]);
  });

  it("consulte un dégât existant, scopé par locationId", async () => {
    const locationId = await createLocationA();
    const damageId = await createDamageA(locationId, 1000);

    const response = await apiFetch(`/api/damages?locationId=${locationId}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.damages.some((d: { id: string }) => d.id === damageId)).toBe(true);
  });
});

describe("PATCH /api/damages/[id] — édition (Sprint 33, damages.edit)", () => {
  it("refuse une requête non authentifiée", async () => {
    const locationId = await createLocationA();
    const damageId = await createDamageA(locationId);
    const response = await apiFetch(`/api/damages/${damageId}`, {
      method: "PATCH",
      body: JSON.stringify({ nature: "Nouvelle nature" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER sans damages.edit", async () => {
    const locationId = await createLocationA();
    const damageId = await createDamageA(locationId);
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Damage Edit",
      email: `no-damage-edit-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA1Id } });
    await grantPermissions(member.userId, ["damages.view"], "NoDamageEdit");

    const response = await apiFetch(`/api/damages/${damageId}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ nature: "Nouvelle nature" }),
    });
    expect(response.status).toBe(403);
  });

  it("refuse la modification d'un dégât d'un autre tenant", async () => {
    const locationId = await createLocationA();
    const damageId = await createDamageA(locationId);
    const response = await apiFetch(`/api/damages/${damageId}`, {
      method: "PATCH",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({ nature: "Nouvelle nature" }),
    });
    expect(response.status).toBe(404);
  });

  it("corrige un dégât non facturé", async () => {
    const locationId = await createLocationA();
    const damageId = await createDamageA(locationId);

    const response = await apiFetch(`/api/damages/${damageId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ nature: "Rayure profonde", billableAmount: 1500 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.damage.nature).toBe("Rayure profonde");
    expect(body.damage.billableAmount).toBe(1500);
  });

  it("refuse la correction d'un dégât déjà facturé (409)", async () => {
    const locationId = await createLocationA();
    const damageId = await createDamageA(locationId, 1000);

    const response = await apiFetch(`/api/damages/${damageId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ nature: "Autre nature" }),
    });
    expect(response.status).toBe(409);
  });
});
