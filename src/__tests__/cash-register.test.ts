import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
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
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashEntry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashRegister.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.expenseCategory.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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
