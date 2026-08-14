import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getCashBalanceByAgency } from "@/lib/cash-register";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Cash Register Test A",
    tenantSlug: `cash-register-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Cash Register Test B",
    tenantSlug: `cash-register-test-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminB.tenantId);
});

afterAll(async () => {
  // Sprint 22 : agences/véhicules/clients/locations/factures/paiements ajoutés par les
  // nouveaux tests de solde par agence — purgés dans l'ordre des clés étrangères, comme le
  // reste du dépôt (jamais un deleteMany global).
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.payment.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashEntry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashRegister.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.expenseCategory.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("Sprint 15 — permissions granulaires (cash_register.create_entry)", () => {
  it("refuse un MEMBER dont le groupe personnalisé n'a pas cash_register.create_entry", async () => {
    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoCashEntry-${runId}`, permissions: ["cash_register.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Member",
      email: `restricted-cash-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const response = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: restrictedMember.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", amount: 1000 }),
    });
    expect(response.status).toBe(403);
  });

  it("autorise un MEMBER dont le groupe personnalisé accorde cash_register.create_entry", async () => {
    const grantedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: `WithCashEntry-${runId}`,
        permissions: ["cash_register.view", "cash_register.create_entry"],
      }),
    });
    const grantedGroupId = (await grantedGroupResponse.json()).group.id;

    const grantedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Granted Member",
      email: `granted-cash-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await apiFetch(`/api/users/${grantedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: grantedGroupId }),
    });

    const response = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: grantedMember.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", amount: 1000 }),
    });
    expect(response.status).toBe(201);
  });

  it("un ADMIN enregistre une entrée de caisse même rattaché à un groupe personnalisé vide (bypass systématique)", async () => {
    const emptyGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `EmptyAdminGroup-${runId}`, permissions: [] }),
    });
    const emptyGroupId = (await emptyGroupResponse.json()).group.id;

    await apiFetch(`/api/users/${adminA.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: emptyGroupId }),
    });

    try {
      const response = await apiFetch("/api/cash-register", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ type: "ENTRY", amount: 1000 }),
      });
      expect(response.status).toBe(201);
    } finally {
      await apiFetch(`/api/users/${adminA.userId}/permissions`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ permissionGroupId: null }),
      });
    }
  });
});

describe("POST /api/cash-register", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/cash-register", {
      method: "POST",
      body: JSON.stringify({ type: "ENTRY", amount: 1000 }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un type invalide", async () => {
    const response = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "BOGUS", amount: 1000 }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse un montant non entier positif", async () => {
    const response = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", amount: -500 }),
    });
    expect(response.status).toBe(400);
  });

  it("crée une entrée et recalcule le solde de la caisse", async () => {
    const response = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        type: "ENTRY",
        category: "VERSEMENT",
        amount: 10_000,
        description: "Versement test",
        clientName: "Client Test",
        paymentMethod: "CASH",
      }),
    });
    expect(response.status).toBe(201);
    const { entry } = await response.json();
    expect(entry.type).toBe("ENTRY");
    expect(entry.amount).toBe(10_000);
    expect(entry.currency).toBe("MAD");

    const summaryResponse = await apiFetch("/api/cash-register", { headers: { Cookie: adminA.sessionCookie } });
    const { summary } = await summaryResponse.json();
    expect(summary.monthEntries).toBeGreaterThanOrEqual(10_000);
    expect(summary.currentBalance).toBe(summary.previousBalance + summary.monthEntries - summary.monthExpenses);
    expect(summary.finalBalance).toBe(summary.currentBalance);
  });

  it("crée une dépense et diminue le solde final", async () => {
    const before = await (
      await apiFetch("/api/cash-register", { headers: { Cookie: adminA.sessionCookie } })
    ).json();

    const response = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "EXPENSE", category: "Carburant", amount: 3_000 }),
    });
    expect(response.status).toBe(201);

    const after = await (
      await apiFetch("/api/cash-register", { headers: { Cookie: adminA.sessionCookie } })
    ).json();
    expect(after.summary.monthExpenses).toBe(before.summary.monthExpenses + 3_000);
    expect(after.summary.currentBalance).toBe(before.summary.currentBalance - 3_000);
  });

  it("isole la caisse par tenant : les écritures d'un tenant ne modifient jamais le solde d'un autre", async () => {
    const responseB = await apiFetch("/api/cash-register", { headers: { Cookie: adminB.sessionCookie } });
    const { summary } = await responseB.json();
    expect(summary.currentBalance).toBe(0);
    expect(summary.monthEntries).toBe(0);
    expect(summary.monthExpenses).toBe(0);
  });
});

describe("PATCH/DELETE /api/cash-register/[id] (Sprint 19 — écritures manuelles uniquement)", () => {
  async function createManualEntry(overrides: Record<string, unknown> = {}) {
    const response = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", category: "VERSEMENT", amount: 5_000, ...overrides }),
    });
    return (await response.json()).entry as { id: string };
  }

  it("modifie une écriture manuelle et recalcule le solde", async () => {
    const entry = await createManualEntry({ amount: 4_000 });

    const before = await (
      await apiFetch("/api/cash-register", { headers: { Cookie: adminA.sessionCookie } })
    ).json();

    const response = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ amount: 9_000, category: "COMMISSION", description: "Corrigé" }),
    });
    expect(response.status).toBe(200);
    const { entry: updated } = await response.json();
    expect(updated.amount).toBe(9_000);
    expect(updated.category).toBe("COMMISSION");
    expect(updated.description).toBe("Corrigé");

    const after = await (
      await apiFetch("/api/cash-register", { headers: { Cookie: adminA.sessionCookie } })
    ).json();
    expect(after.summary.currentBalance).toBe(before.summary.currentBalance + 5_000);
  });

  it("supprime une écriture manuelle et recalcule le solde", async () => {
    const entry = await createManualEntry({ amount: 2_500 });

    const before = await (
      await apiFetch("/api/cash-register", { headers: { Cookie: adminA.sessionCookie } })
    ).json();

    const response = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);

    const after = await (
      await apiFetch("/api/cash-register", { headers: { Cookie: adminA.sessionCookie } })
    ).json();
    expect(after.summary.currentBalance).toBe(before.summary.currentBalance - 2_500);
  });

  it("refuse de modifier/supprimer une écriture liée à un paiement (contractId renseigné)", async () => {
    const entry = await createManualEntry({ contractId: `fake-location-${runId}` });

    const patchResponse = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ amount: 1_000 }),
    });
    expect(patchResponse.status).toBe(409);

    const deleteResponse = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(409);
  });

  it("retourne 404 pour une écriture d'un autre tenant", async () => {
    const entry = await createManualEntry();

    const response = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "PATCH",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({ amount: 1_000 }),
    });
    expect(response.status).toBe(404);
  });

  it("exige cash_register.edit/delete (un groupe personnalisé sans ces clés est refusé)", async () => {
    const entry = await createManualEntry();

    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: `NoCashEditDelete-${runId}`,
        permissions: ["cash_register.view", "cash_register.create_entry"],
      }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Cash Edit Member",
      email: `restricted-cash-edit-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const patchResponse = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "PATCH",
      headers: { Cookie: restrictedMember.sessionCookie },
      body: JSON.stringify({ amount: 1_000 }),
    });
    expect(patchResponse.status).toBe(403);

    const deleteResponse = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "DELETE",
      headers: { Cookie: restrictedMember.sessionCookie },
    });
    expect(deleteResponse.status).toBe(403);
  });
});

describe("Sprint 19 — séparation espèces/carte des entrées (DOMAINRULES.md section 37)", () => {
  it("monthCash/monthCard reflètent les entrées par mode de règlement, séparément de monthEntries", async () => {
    const before = await (
      await apiFetch("/api/cash-register", { headers: { Cookie: adminA.sessionCookie } })
    ).json();

    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", amount: 4_000, paymentMethod: "CASH" }),
    });
    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", amount: 6_000, paymentMethod: "CARD" }),
    });
    // Sans paymentMethod : compté dans monthEntries mais ni cash ni card.
    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", amount: 1_000 }),
    });

    const after = await (
      await apiFetch("/api/cash-register", { headers: { Cookie: adminA.sessionCookie } })
    ).json();

    expect(after.summary.monthCash).toBe(before.summary.monthCash + 4_000);
    expect(after.summary.monthCard).toBe(before.summary.monthCard + 6_000);
    expect(after.summary.monthEntries).toBe(before.summary.monthEntries + 4_000 + 6_000 + 1_000);
  });
});

describe("GET /api/cash-register/entries et /expenses", () => {
  it("ne retourne que le type demandé et scope par tenant", async () => {
    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", category: "COMMISSION", amount: 1_500 }),
    });
    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "EXPENSE", category: "Entretien", amount: 800 }),
    });

    const entriesResponse = await apiFetch("/api/cash-register/entries", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const { entries } = await entriesResponse.json();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry: { type: string }) => entry.type === "ENTRY")).toBe(true);

    const expensesResponse = await apiFetch("/api/cash-register/expenses", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const { entries: expenses } = await expensesResponse.json();
    expect(expenses.length).toBeGreaterThan(0);
    expect(expenses.every((entry: { type: string }) => entry.type === "EXPENSE")).toBe(true);

    const entriesResponseB = await apiFetch("/api/cash-register/entries", {
      headers: { Cookie: adminB.sessionCookie },
    });
    const { entries: entriesB } = await entriesResponseB.json();
    expect(entriesB).toEqual([]);
  });
});

describe("GET/POST /api/cash-register/categories", () => {
  it("crée une catégorie de dépense et la liste", async () => {
    const createResponse = await apiFetch("/api/cash-register/categories", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Salaires-${runId}`, color: "#2563eb" }),
    });
    expect(createResponse.status).toBe(201);

    const listResponse = await apiFetch("/api/cash-register/categories", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const { categories } = await listResponse.json();
    expect(categories.some((category: { name: string }) => category.name === `Salaires-${runId}`)).toBe(true);
  });

  it("refuse un nom de catégorie déjà utilisé pour ce tenant", async () => {
    const name = `Doublon-${runId}`;
    const first = await apiFetch("/api/cash-register/categories", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name }),
    });
    expect(first.status).toBe(201);

    const second = await apiFetch("/api/cash-register/categories", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name }),
    });
    expect(second.status).toBe(409);
  });
});

describe("Sprint 22 — solde par agence (DOMAINRULES.md section 23, révisée)", () => {
  it("intègre le solde de départ de l'agence au calcul réel du solde (startingBalance + entrées - dépenses)", async () => {
    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Agence Solde ${runId}`, slug: `solde-agence-${runId}` }),
    });
    const agencyId = (await agencyResponse.json()).agency.id;

    // Solde de départ (Sprint 19, jusqu'ici purement informatif) — désormais intégré.
    await apiFetch(`/api/agencies/${agencyId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ cashStartingBalance: 100_000 }),
    });

    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", category: "VERSEMENT", amount: 50_000, agencyId }),
    });
    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "EXPENSE", category: "Fournitures", amount: 20_000, agencyId }),
    });

    const balances = await getCashBalanceByAgency(adminA.tenantId, null);
    const agencyBalance = balances.find((b) => b.agencyId === agencyId);
    expect(agencyBalance).toBeDefined();
    expect(agencyBalance!.startingBalance).toBe(100_000);
    expect(agencyBalance!.entries).toBe(50_000);
    expect(agencyBalance!.expenses).toBe(20_000);
    expect(agencyBalance!.balance).toBe(130_000); // 100 000 + 50 000 - 20 000
  });

  it("restreint le calcul aux agences accessibles fournies (scope MEMBER)", async () => {
    const agency1Response = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Agence Scope 1 ${runId}`, slug: `scope-agence-1-${runId}` }),
    });
    const agency1Id = (await agency1Response.json()).agency.id;

    const agency2Response = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Agence Scope 2 ${runId}`, slug: `scope-agence-2-${runId}` }),
    });
    const agency2Id = (await agency2Response.json()).agency.id;

    const balances = await getCashBalanceByAgency(adminA.tenantId, [agency1Id]);
    expect(balances.map((b) => b.agencyId)).toContain(agency1Id);
    expect(balances.map((b) => b.agencyId)).not.toContain(agency2Id);
  });

  it("un paiement de contrat alimente automatiquement le solde de l'agence du véhicule loué", async () => {
    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Agence Paiement ${runId}`, slug: `paiement-agence-${runId}` }),
    });
    const agencyId = (await agencyResponse.json()).agency.id;

    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId,
        name: "Clio",
        licensePlate: `CR-${Math.floor(Math.random() * 1_000_000)}-CR`,
        make: "Renault",
        model: "Clio",
        year: 2022,
        category: "Citadine",
        pricePerDay: 5000,
      }),
    });
    const vehicle = (await vehicleResponse.json()).vehicle;

    const clientResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Client Solde Agence", email: `client-solde-${runId}@test.local` }),
    });
    const client = (await clientResponse.json()).client;

    const locationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId: vehicle.id,
        clientId: client.id,
        startDate: "2031-01-01",
        endDate: "2031-01-03",
      }),
    });
    const location = (await locationResponse.json()).location;

    const invoiceResponse = await apiFetch("/api/invoices", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ locationId: location.id }),
    });
    const invoice = (await invoiceResponse.json()).invoice;

    await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: 10_000, method: "CASH" }),
    });

    const balances = await getCashBalanceByAgency(adminA.tenantId, null);
    const agencyBalance = balances.find((b) => b.agencyId === agencyId);
    expect(agencyBalance).toBeDefined();
    expect(agencyBalance!.entries).toBeGreaterThanOrEqual(10_000);
  });
});
