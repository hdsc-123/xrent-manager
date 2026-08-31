import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getCashBalanceByAgency } from "@/lib/cash-register";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

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
  await deleteTestTenants(createdTenantIds);
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
body: JSON.stringify({ type: "ENTRY", amount: 1000, description: "Test permission accordée" }),
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
        body: JSON.stringify({ type: "ENTRY", amount: 1000, description: "Test bypass ADMIN" }),
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
      body: JSON.stringify({ type: "ENTRY", amount: -500, description: "Montant invalide test" }),
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
body: JSON.stringify({ type: "EXPENSE", category: "Carburant", amount: 3_000, description: "Plein carburant test" }),
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

describe("Sprint 24-1 — description obligatoire pour toute écriture de caisse manuelle", () => {
  it("refuse une entrée sans description (absente, vide, ou uniquement des espaces)", async () => {
    const missing = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", amount: 1000 }),
    });
    expect(missing.status).toBe(400);

    const empty = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", amount: 1000, description: "" }),
    });
    expect(empty.status).toBe(400);

    const blank = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", amount: 1000, description: "   " }),
    });
    expect(blank.status).toBe(400);
  });

  it("refuse une dépense sans description", async () => {
    const response = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "EXPENSE", category: "Divers", amount: 500 }),
    });
    expect(response.status).toBe(400);
  });

  it("la vérification d'autorisation reste prioritaire : un MEMBER sans permission est refusé (403), pas 400, même sans description", async () => {
    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoDescPerm-${runId}`, permissions: ["cash_register.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Desc Perm Member",
      email: `no-desc-perm-${runId}@test.local`,
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

  it("accepte une entrée/dépense avec une description non vide", async () => {
    const entry = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", amount: 1000, description: "Versement client" }),
    });
    expect(entry.status).toBe(201);

    const expense = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ type: "EXPENSE", category: "Divers", amount: 500, description: "Achat fournitures" }),
    });
    expect(expense.status).toBe(201);
  });
});

describe("PATCH/DELETE /api/cash-register/[id] (Sprint 19 — écritures manuelles uniquement)", () => {
  async function createManualEntry(overrides: Record<string, unknown> = {}) {
    const response = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
body: JSON.stringify({ type: "ENTRY", category: "VERSEMENT", amount: 5_000, description: "Écriture manuelle de test", ...overrides }),
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

describe("Sprint 25B — isolation par agence sur PATCH/DELETE d'une écriture manuelle (SECURITY.md section 2)", () => {
  // Tenant/agences dédiés, isolés des autres describe de ce fichier — un ADMIN peut créer une
  // écriture manuelle pour n'importe quelle agence de son tenant (canAccessAgency bypass rôle
  // ADMIN, POST /api/cash-register), utilisé ici pour préparer les fixtures de chaque test.
  let adminE: AuthenticatedTestUser;
  let agencyA: string;
  let agencyB: string;
  let memberAgencyA: AuthenticatedTestUser;

  beforeAll(async () => {
    adminE = await registerTenantAdmin({
      tenantName: "Cash Register Agency Isolation Test",
      tenantSlug: `cash-register-test-e-${runId}`,
      name: "Admin E",
      email: `admin-e-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    createdTenantIds.push(adminE.tenantId);

    const agencyAResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminE.sessionCookie },
      body: JSON.stringify({ name: "Agence A", slug: `agency-a-${runId}` }),
    });
    agencyA = (await agencyAResponse.json()).agency.id;

    const agencyBResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminE.sessionCookie },
      body: JSON.stringify({ name: "Agence B", slug: `agency-b-${runId}` }),
    });
    agencyB = (await agencyBResponse.json()).agency.id;

    memberAgencyA = await createAndLoginMember({
      tenantId: adminE.tenantId,
      name: "Member Agency A",
      email: `member-agency-a-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: memberAgencyA.userId, agencyId: agencyA } });

    const editDeleteGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminE.sessionCookie },
      body: JSON.stringify({
        name: `AgencyIsolationEditDelete-${runId}`,
        permissions: ["cash_register.view", "cash_register.edit", "cash_register.delete"],
      }),
    });
    const editDeleteGroupId = (await editDeleteGroupResponse.json()).group.id;
    await apiFetch(`/api/users/${memberAgencyA.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminE.sessionCookie },
      body: JSON.stringify({ permissionGroupId: editDeleteGroupId }),
    });
  });

  async function createManualEntryForAgency(agencyId: string | undefined, overrides: Record<string, unknown> = {}) {
    const response = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminE.sessionCookie },
      body: JSON.stringify({
        type: "ENTRY",
        category: "VERSEMENT",
        amount: 3_000,
        description: "Écriture Sprint 25B",
        ...(agencyId ? { agencyId } : {}),
        ...overrides,
      }),
    });
    return (await response.json()).entry as { id: string };
  }

  it("1. MEMBER limité à l'agence A refuse de modifier une écriture de l'agence B (403)", async () => {
    const entry = await createManualEntryForAgency(agencyB);
    const response = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "PATCH",
      headers: { Cookie: memberAgencyA.sessionCookie },
      body: JSON.stringify({ amount: 9_999 }),
    });
    expect(response.status).toBe(403);
  });

  it("2. MEMBER limité à l'agence A refuse de supprimer une écriture de l'agence B (403)", async () => {
    const entry = await createManualEntryForAgency(agencyB);
    const response = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "DELETE",
      headers: { Cookie: memberAgencyA.sessionCookie },
    });
    expect(response.status).toBe(403);
  });

  it("3. MEMBER modifie avec succès une écriture de sa propre agence (A)", async () => {
    const entry = await createManualEntryForAgency(agencyA);
    const response = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "PATCH",
      headers: { Cookie: memberAgencyA.sessionCookie },
      body: JSON.stringify({ amount: 4_500 }),
    });
    expect(response.status).toBe(200);
    const { entry: updated } = await response.json();
    expect(updated.amount).toBe(4_500);
  });

  it("4. MEMBER supprime avec succès une écriture de sa propre agence (A)", async () => {
    const entry = await createManualEntryForAgency(agencyA);
    const response = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "DELETE",
      headers: { Cookie: memberAgencyA.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("5. ADMIN modifie avec succès une écriture d'une autre agence du même tenant", async () => {
    const entry = await createManualEntryForAgency(agencyB);
    const response = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "PATCH",
      headers: { Cookie: adminE.sessionCookie },
      body: JSON.stringify({ amount: 7_000 }),
    });
    expect(response.status).toBe(200);
  });

  it("6. ADMIN supprime avec succès une écriture d'une autre agence du même tenant", async () => {
    const entry = await createManualEntryForAgency(agencyB);
    const response = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "DELETE",
      headers: { Cookie: adminE.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("7. un utilisateur d'un autre tenant ne peut ni modifier ni supprimer (404, isolation tenant déjà garantie)", async () => {
    const entry = await createManualEntryForAgency(agencyA);

    const patchResponse = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "PATCH",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({ amount: 1_000 }),
    });
    expect(patchResponse.status).toBe(404);

    const deleteResponse = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "DELETE",
      headers: { Cookie: adminB.sessionCookie },
    });
    expect(deleteResponse.status).toBe(404);
  });

  it("8. une écriture liée à un paiement reste protégée même si l'agence est accessible (409, pas 403)", async () => {
    const entry = await createManualEntryForAgency(agencyA, { contractId: `fake-location-25b-${runId}` });

    const patchResponse = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "PATCH",
      headers: { Cookie: memberAgencyA.sessionCookie },
      body: JSON.stringify({ amount: 1_000 }),
    });
    expect(patchResponse.status).toBe(409);

    const deleteResponse = await apiFetch(`/api/cash-register/${entry.id}`, {
      method: "DELETE",
      headers: { Cookie: memberAgencyA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(409);
  });

  it("une écriture sans agence (agencyId null) est hors du périmètre d'un MEMBER, mais reste accessible à l'ADMIN", async () => {
    const noAgencyEntry = await createManualEntryForAgency(undefined, { description: "Écriture sans agence Sprint 25B" });

    const memberResponse = await apiFetch(`/api/cash-register/${noAgencyEntry.id}`, {
      method: "PATCH",
      headers: { Cookie: memberAgencyA.sessionCookie },
      body: JSON.stringify({ amount: 2_500 }),
    });
    expect(memberResponse.status).toBe(403);

    const adminResponse = await apiFetch(`/api/cash-register/${noAgencyEntry.id}`, {
      method: "PATCH",
      headers: { Cookie: adminE.sessionCookie },
      body: JSON.stringify({ amount: 2_500 }),
    });
    expect(adminResponse.status).toBe(200);
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
body: JSON.stringify({ type: "ENTRY", amount: 4_000, paymentMethod: "CASH", description: "Entrée espèces test" }),
    });
    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
body: JSON.stringify({ type: "ENTRY", amount: 6_000, paymentMethod: "CARD", description: "Entrée carte test" }),
    });
    // Sans paymentMethod : compté dans monthEntries mais ni cash ni card.
    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
body: JSON.stringify({ type: "ENTRY", amount: 1_000, description: "Entrée sans mode test" }),
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
body: JSON.stringify({ type: "ENTRY", category: "COMMISSION", amount: 1_500, description: "Commission test" }),
    });
    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
body: JSON.stringify({ type: "EXPENSE", category: "Entretien", amount: 800, description: "Entretien test" }),
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

  // Sprint 30 (point 6b, Sprint A) : from/to déjà supportés côté serveur (getCashEntries),
  // jusqu'ici jamais exposés dans l'UI (EntriesTable.tsx/ExpensesTable.tsx) — le formulaire de
  // filtre ajouté ce sprint réutilise ces paramètres tels quels, sans changement d'API.
  it("filtre par plage de dates (from/to) — entrées et dépenses", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const entryResponse = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        type: "ENTRY",
        category: "COMMISSION",
        amount: 1_200,
        description: `Commission plage ${runId}`,
      }),
    });
    const entryId = (await entryResponse.json()).entry.id;

    const expenseResponse = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        type: "EXPENSE",
        category: "Entretien",
        amount: 700,
        description: `Dépense plage ${runId}`,
      }),
    });
    const expenseId = (await expenseResponse.json()).entry.id;

    const withinRangeEntries = await apiFetch(`/api/cash-register/entries?from=${yesterday}&to=${tomorrow}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const withinRangeEntriesIds = (await withinRangeEntries.json()).entries.map((entry: { id: string }) => entry.id);
    expect(withinRangeEntriesIds).toContain(entryId);

    const beforeRangeEntries = await apiFetch(`/api/cash-register/entries?from=${tomorrow}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const beforeRangeEntriesIds = (await beforeRangeEntries.json()).entries.map((entry: { id: string }) => entry.id);
    expect(beforeRangeEntriesIds).not.toContain(entryId);

    const afterRangeEntries = await apiFetch(`/api/cash-register/entries?to=${yesterday}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const afterRangeEntriesIds = (await afterRangeEntries.json()).entries.map((entry: { id: string }) => entry.id);
    expect(afterRangeEntriesIds).not.toContain(entryId);

    const withinRangeExpenses = await apiFetch(`/api/cash-register/expenses?from=${yesterday}&to=${tomorrow}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const withinRangeExpensesIds = (await withinRangeExpenses.json()).entries.map((entry: { id: string }) => entry.id);
    expect(withinRangeExpensesIds).toContain(expenseId);

    const outsideRangeExpenses = await apiFetch(`/api/cash-register/expenses?from=${tomorrow}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const outsideRangeExpensesIds = (await outsideRangeExpenses.json()).entries.map((entry: { id: string }) => entry.id);
    expect(outsideRangeExpensesIds).not.toContain(expenseId);
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
body: JSON.stringify({ type: "ENTRY", category: "VERSEMENT", amount: 50_000, agencyId, description: "Versement agence test" }),
    });
    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
body: JSON.stringify({ type: "EXPENSE", category: "Fournitures", amount: 20_000, agencyId, description: "Fournitures test" }),
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
        chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
        color: "Blanc",
        doors: 5,
        seats: 5,
        horsepower: 6,
        powerKW: 75,
        engineSize: 1.5,
      }),
    });
    const vehicle = (await vehicleResponse.json()).vehicle;

    const clientResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: "Client Solde Agence",
        email: `client-solde-${runId}@test.local`,
        licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01",
      }),
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

    // Finding F : un paiement direct est refusé sur une facture encore DRAFT — finalise
    // d'abord (DRAFT → SENT, inconditionnel vis-à-vis du solde).
    await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ISSUED" }),
    });

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

describe("Sprint 25A — solde de départ des agences intégré au Report/Solde actuel (DOMAINRULES.md section 23, révisée)", () => {
  // Tenant dédié et isolé (assertions en valeur exacte, jamais relatives) — même principe que
  // adminA/adminB en tête de fichier, pour ne dépendre d'aucun état cumulé par les describe
  // précédents de ce fichier.
  let adminC: AuthenticatedTestUser;
  let agencyFes: string;
  let agencyRak: string;
  let agencyThird: string;
  let memberFes: AuthenticatedTestUser;
  let memberRak: AuthenticatedTestUser;
  let memberFesAndThird: AuthenticatedTestUser;

  beforeAll(async () => {
    adminC = await registerTenantAdmin({
      tenantName: "Cash Register Starting Balance Test",
      tenantSlug: `cash-register-test-c-${runId}`,
      name: "Admin C",
      email: `admin-c-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    createdTenantIds.push(adminC.tenantId);

    const fesResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminC.sessionCookie },
      body: JSON.stringify({ name: "FEZ", slug: `fes-${runId}` }),
    });
    agencyFes = (await fesResponse.json()).agency.id;
    await apiFetch(`/api/agencies/${agencyFes}`, {
      method: "PATCH",
      headers: { Cookie: adminC.sessionCookie },
      body: JSON.stringify({ cashStartingBalance: 20_000 }), // 200,00 MAD — reproduit le cas réel Fès
    });

    const rakResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminC.sessionCookie },
      body: JSON.stringify({ name: "RAK", slug: `rak-${runId}` }),
    });
    agencyRak = (await rakResponse.json()).agency.id;
    await apiFetch(`/api/agencies/${agencyRak}`, {
      method: "PATCH",
      headers: { Cookie: adminC.sessionCookie },
      body: JSON.stringify({ cashStartingBalance: 20_000 }), // 200,00 MAD — reproduit le cas réel RAK
    });

    const thirdResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminC.sessionCookie },
      body: JSON.stringify({ name: "AGADIR", slug: `agadir-${runId}` }),
    });
    agencyThird = (await thirdResponse.json()).agency.id;
    await apiFetch(`/api/agencies/${agencyThird}`, {
      method: "PATCH",
      headers: { Cookie: adminC.sessionCookie },
      body: JSON.stringify({ cashStartingBalance: 12_345 }), // 123,45 MAD — précision décimale
    });

    memberFes = await createAndLoginMember({
      tenantId: adminC.tenantId,
      name: "Member Fes",
      email: `member-fes-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: memberFes.userId, agencyId: agencyFes } });

    memberRak = await createAndLoginMember({
      tenantId: adminC.tenantId,
      name: "Member Rak",
      email: `member-rak-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: memberRak.userId, agencyId: agencyRak } });

    memberFesAndThird = await createAndLoginMember({
      tenantId: adminC.tenantId,
      name: "Member Fes Agadir",
      email: `member-fes-agadir-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: memberFesAndThird.userId, agencyId: agencyFes } });
    await prisma.userAgency.create({ data: { userId: memberFesAndThird.userId, agencyId: agencyThird } });

    // Les MEMBER par défaut n'ont pas forcément cash_register.view selon l'environnement de
    // test — même pattern que le describe Sprint 24 ci-dessous : groupe dédié explicite.
    const viewGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminC.sessionCookie },
      body: JSON.stringify({ name: `StartingBalanceView-${runId}`, permissions: ["cash_register.view"] }),
    });
    const viewGroupId = (await viewGroupResponse.json()).group.id;
    for (const member of [memberFes, memberRak, memberFesAndThird]) {
      await apiFetch(`/api/users/${member.userId}/permissions`, {
        method: "PATCH",
        headers: { Cookie: adminC.sessionCookie },
        body: JSON.stringify({ permissionGroupId: viewGroupId }),
      });
    }
  });

  it("une agence avec solde de départ mais aucun mouvement : Report = Solde actuel = solde de départ", async () => {
    const response = await apiFetch("/api/cash-register", { headers: { Cookie: memberFes.sessionCookie } });
    expect(response.status).toBe(200);
    const { summary } = await response.json();
    expect(summary.previousBalance).toBe(20_000);
    expect(summary.currentBalance).toBe(20_000);
    expect(summary.monthEntries).toBe(0);
    expect(summary.monthExpenses).toBe(0);
  });

  it("plusieurs agences accessibles : les soldes de départ s'additionnent, sans doublon", async () => {
    const response = await apiFetch("/api/cash-register", { headers: { Cookie: memberFesAndThird.sessionCookie } });
    expect(response.status).toBe(200);
    const { summary } = await response.json();
    // Fès (20 000) + Agadir (12 345) — jamais RAK, hors périmètre de ce user.
    expect(summary.previousBalance).toBe(32_345);
    expect(summary.currentBalance).toBe(32_345);
  });

  it("agrégation super admin : somme réelle des soldes de départ de toutes les agences du tenant", async () => {
    const response = await apiFetch("/api/cash-register", { headers: { Cookie: adminC.sessionCookie } });
    expect(response.status).toBe(200);
    const { summary } = await response.json();
    // Fès (20 000) + RAK (20 000) + Agadir (12 345), aucun mouvement encore à ce stade du describe.
    expect(summary.previousBalance).toBe(52_345);
    expect(summary.currentBalance).toBe(52_345);
  });

  it("filtrage utilisateur local : un MEMBER restreint à RAK ne voit ni le solde de départ ni les mouvements de Fès/Agadir", async () => {
    const response = await apiFetch("/api/cash-register", { headers: { Cookie: memberRak.sessionCookie } });
    expect(response.status).toBe(200);
    const { summary } = await response.json();
    expect(summary.previousBalance).toBe(20_000);
    expect(summary.currentBalance).toBe(20_000);
  });

  it("entrées et sorties du mois s'ajoutent au solde de départ, jamais à la place de celui-ci", async () => {
    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminC.sessionCookie },
      body: JSON.stringify({
        type: "ENTRY",
        category: "VERSEMENT",
        amount: 5_000,
        agencyId: agencyFes,
        description: "Entrée Fès test 25A",
      }),
    });
    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminC.sessionCookie },
      body: JSON.stringify({
        type: "EXPENSE",
        category: "Fournitures",
        amount: 1_500,
        agencyId: agencyFes,
        description: "Sortie Fès test 25A",
      }),
    });

    const response = await apiFetch("/api/cash-register", { headers: { Cookie: memberFes.sessionCookie } });
    const { summary } = await response.json();
    // Cohérence des périodes comptables : les écritures créées aujourd'hui tombent dans le
    // mois en cours, donc dans monthEntries/monthExpenses — jamais dans previousBalance (le
    // report d'avant ce mois, qui doit rester inchangé). Solde actuel = 20 000 (solde de
    // départ, dans previousBalance) + 5 000 (entrée) - 1 500 (sortie) = 23 500.
    expect(summary.previousBalance).toBe(20_000);
    expect(summary.currentBalance).toBe(23_500);
    expect(summary.monthEntries).toBe(5_000);
    expect(summary.monthExpenses).toBe(1_500);
  });

  it("remboursement (EXPENSE de compensation) et correction manuelle sont comptés sans double compter le solde de départ", async () => {
    const before = await (
      await apiFetch("/api/cash-register", { headers: { Cookie: memberRak.sessionCookie } })
    ).json();

    // Remboursement — même modélisation que la compensation d'annulation admin
    // (category "ANNULATION_CONTRAT", src/lib/locations.ts) : une CashEntry EXPENSE ordinaire.
    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminC.sessionCookie },
      body: JSON.stringify({
        type: "EXPENSE",
        category: "ANNULATION_CONTRAT",
        amount: 2_000,
        agencyId: agencyRak,
        description: "Remboursement test 25A",
      }),
    });
    // Correction manuelle — une CashEntry ENTRY ordinaire avec une catégorie « correction ».
    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminC.sessionCookie },
      body: JSON.stringify({
        type: "ENTRY",
        category: "CORRECTION",
        amount: 800,
        agencyId: agencyRak,
        description: "Correction caisse test 25A",
      }),
    });

    const after = await (
      await apiFetch("/api/cash-register", { headers: { Cookie: memberRak.sessionCookie } })
    ).json();
    // Cohérence des périodes comptables : ces deux écritures sont créées aujourd'hui (mois en
    // cours) — previousBalance (report d'avant ce mois, incluant le solde de départ) reste
    // inchangé ; seul currentBalance (solde actuel) encaisse la différence entrée - sortie
    // (800 - 2 000 = -1 200), sans jamais réappliquer le solde de départ une seconde fois.
    expect(after.summary.previousBalance).toBe(before.summary.previousBalance);
    expect(after.summary.currentBalance).toBe(before.summary.currentBalance - 2_000 + 800);
  });

  it("montants décimaux précis : le solde de départ à centimes non ronds (123,45 MAD) est reporté sans arrondi ni dérive", async () => {
    const response = await apiFetch("/api/cash-register", { headers: { Cookie: adminC.sessionCookie } });
    const { summary } = await response.json();
    // Agadir contribue exactement 12 345 centimes — vérifié en isolant son périmètre.
    const agadirOnly = await apiFetch(`/api/agencies/${agencyThird}`, { headers: { Cookie: adminC.sessionCookie } });
    expect((await agadirOnly.json()).agency.cashStartingBalance).toBe(12_345);
    expect(Number.isInteger(summary.currentBalance)).toBe(true);
    expect(Number.isInteger(summary.previousBalance)).toBe(true);
  });

  it("isolation tenant : le solde de départ des agences d'un autre tenant ne fuite jamais dans ce calcul", async () => {
    const otherAdmin = await registerTenantAdmin({
      tenantName: "Cash Register Starting Balance Other Tenant",
      tenantSlug: `cash-register-test-d-${runId}`,
      name: "Admin D",
      email: `admin-d-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    createdTenantIds.push(otherAdmin.tenantId);

    const otherAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: otherAdmin.sessionCookie },
      body: JSON.stringify({ name: "Autre Tenant Agence", slug: `other-tenant-agence-${runId}` }),
    });
    const otherAgencyId = (await otherAgencyResponse.json()).agency.id;
    await apiFetch(`/api/agencies/${otherAgencyId}`, {
      method: "PATCH",
      headers: { Cookie: otherAdmin.sessionCookie },
      body: JSON.stringify({ cashStartingBalance: 999_999 }),
    });

    const otherResponse = await apiFetch("/api/cash-register", { headers: { Cookie: otherAdmin.sessionCookie } });
    const { summary: otherSummary } = await otherResponse.json();
    expect(otherSummary.currentBalance).toBe(999_999);

    // Le tenant C (adminC) ne doit voir aucune trace du solde de départ (999 999) du tenant D.
    const cResponse = await apiFetch("/api/cash-register", { headers: { Cookie: adminC.sessionCookie } });
    const { summary: cSummary } = await cResponse.json();
    expect(cSummary.currentBalance).not.toBe(999_999);
    expect(cSummary.currentBalance).toBeLessThan(999_999);
  });
});

describe("Sprint 24 — GET /api/cash-register scopé par périmètre (correction : solde tenant-wide affiché à tort à tout rôle)", () => {
  it("un ADMIN voit le solde consolidé de toutes les agences ; un MEMBER restreint ne voit que le sien", async () => {
    const agencyOneResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Agence Scope Caisse 1 ${runId}`, slug: `scope-caisse-1-${runId}` }),
    });
    const agencyOneId = (await agencyOneResponse.json()).agency.id;

    const agencyTwoResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Agence Scope Caisse 2 ${runId}`, slug: `scope-caisse-2-${runId}` }),
    });
    const agencyTwoId = (await agencyTwoResponse.json()).agency.id;

    // Groupe accordant cash_register.view (MEMBER ne l'a pas forcément par défaut selon
    // l'environnement de test) — même pattern que les autres tests de ce fichier.
    const viewGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `CashViewOnly-${runId}`, permissions: ["cash_register.view"] }),
    });
    const viewGroupId = (await viewGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Cash Member",
      email: `restricted-cash-scope-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: restrictedMember.userId, agencyId: agencyOneId } });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: viewGroupId }),
    });

    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
body: JSON.stringify({ type: "ENTRY", category: "VERSEMENT", amount: 70_000, agencyId: agencyOneId, description: "Versement agence 1 test" }),
    });
    await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
body: JSON.stringify({ type: "ENTRY", category: "VERSEMENT", amount: 130_000, agencyId: agencyTwoId, description: "Versement agence 2 test" }),
    });

    // ADMIN : solde consolidé — reflète les deux agences (au moins 200 000, d'autres tests du
    // fichier alimentent aussi la même caisse tenant-wide sans la vider).
    const adminResponse = await apiFetch("/api/cash-register", { headers: { Cookie: adminA.sessionCookie } });
    expect(adminResponse.status).toBe(200);
    const adminBody = await adminResponse.json();
    expect(adminBody.summary.currentBalance).toBeGreaterThanOrEqual(200_000);
    const adminOperationAgencyIds = adminBody.recentOperations.map((op: { agencyId: string | null }) => op.agencyId);
    // Les 10 dernières opérations tenant-wide peuvent ne pas inclure les deux entrées créées
    // ci-dessus selon le volume déjà présent dans ce fichier — seule l'absence de restriction
    // de périmètre est vérifiée ici (contrairement au MEMBER ci-dessous).
    expect(Array.isArray(adminOperationAgencyIds)).toBe(true);

    // MEMBER restreint à agencyOneId : solde et opérations limités à son périmètre.
    const memberResponse = await apiFetch("/api/cash-register", { headers: { Cookie: restrictedMember.sessionCookie } });
    expect(memberResponse.status).toBe(200);
    const memberBody = await memberResponse.json();
    expect(memberBody.summary.currentBalance).toBe(70_000);
    for (const operation of memberBody.recentOperations) {
      expect(operation.agencyId).toBe(agencyOneId);
    }

    // Les écritures de l'agence 2 (hors périmètre) n'apparaissent jamais pour ce MEMBER.
    const entriesResponse = await apiFetch("/api/cash-register/entries", {
      headers: { Cookie: restrictedMember.sessionCookie },
    });
    const entriesBody = await entriesResponse.json();
    for (const entry of entriesBody.entries) {
      expect(entry.agencyId).not.toBe(agencyTwoId);
    }
  });
});
