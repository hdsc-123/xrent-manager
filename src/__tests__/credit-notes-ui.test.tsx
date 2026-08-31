import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

/**
 * Sous-phase 2c2-D — tests SSR de /dashboard/invoices/[id] pour un avoir (CREDIT_NOTE) et pour
 * sa facture source, même paradigme que damage-invoices-ui.test.tsx/return-damages-ui.test.tsx :
 * un vrai serveur next dev de test rend les pages, on vérifie le HTML produit — pas de jsdom/
 * @testing-library. La logique métier (formules, plafonds, remboursement) est déjà couverte par
 * invoices.test.ts — ce fichier vérifie uniquement ce que le serveur *affiche* et les boutons
 * "Créer un avoir"/"Rembourser" (visibilité ADMIN uniquement, jamais la seule barrière réelle —
 * les routes POST correspondantes restent de toute façon strictement ADMIN côté serveur).
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let agencyAId: string;
let vehicleAId: string;
let clientAId: string;
let dateOffset = 0;

async function createLocation(): Promise<string> {
  dateOffset += 10;
  const base = new Date(Date.UTC(2028, 5, 1));
  const start = new Date(base.getTime() + dateOffset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
  const response = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ vehicleId: vehicleAId, clientId: clientAId, startDate: start.toISOString(), endDate: end.toISOString() }),
  });
  return (await response.json()).location.id as string;
}

/** Crée une facture RENTAL PARTIALLY_PAID (paie 1/3 du total) — source éligible à un avoir. */
async function createPartiallyPaidSource(): Promise<{ id: string; number: string; totalAmount: number }> {
  const locationId = await createLocation();
  const createResponse = await apiFetch("/api/invoices", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ locationId }),
  });
  const invoice = (await createResponse.json()).invoice;
  await apiFetch(`/api/invoices/${invoice.id}`, {
    method: "PATCH",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ status: "ISSUED" }),
  });
  await apiFetch("/api/payments", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ invoiceId: invoice.id, amount: Math.floor(invoice.totalAmount / 3), method: "CASH" }),
  });
  return prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
}

async function createCreditNoteOn(sourceId: string, amount: number, reason: string) {
  const response = await apiFetch(`/api/invoices/${sourceId}/credit-notes`, {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ amount, reason }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).invoice as { id: string; number: string };
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
    tenantName: "Credit Notes UI Test",
    tenantSlug: `credit-notes-ui-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A", slug: `agence-a-${runId}` }),
  });
  agencyAId = (await agencyResponse.json()).agency.id;

  const vehicleResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      agencyId: agencyAId,
      name: "Clio",
      licensePlate: `CNU-${runId}`,
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
    body: JSON.stringify({ name: "Client A", email: `client-a-${runId}@test.local`, licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
  });
  clientAId = (await clientResponse.json()).client.id;
});

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
});

describe("/dashboard/invoices/[id] — facture source avec avoirs (2c2-D)", () => {
  it("ADMIN : affiche la section Avoirs, le lien vers l'avoir et le bouton Créer un avoir", async () => {
    const source = await createPartiallyPaidSource();
    const creditNote = await createCreditNoteOn(source.id, 2000, "Erreur de facturation client");

    const response = await apiFetch(`/dashboard/invoices/${source.id}`, { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Avoirs");
    expect(html).toContain(creditNote.number);
    expect(html).toContain("Erreur de facturation client");
    expect(html).toContain("Créer un avoir");
    expect(html).toContain(`/dashboard/invoices/${creditNote.id}`);
  });

  it("MEMBER sans rôle ADMIN : la section Avoirs reste visible mais jamais le bouton Créer un avoir", async () => {
    const source = await createPartiallyPaidSource();
    await createCreditNoteOn(source.id, 1500, "Avoir visible en lecture seule");

    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Lecture Seule",
      email: `read-only-cn-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyAId } });
    await grantPermissions(member.userId, ["invoices.view"], "ReadOnlyCN");

    const response = await apiFetch(`/dashboard/invoices/${source.id}`, { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Avoirs");
    expect(html).not.toContain("Créer un avoir");
  });

  it("facture sans aucun avoir : affiche le message d'absence, jamais une section vide silencieuse", async () => {
    const source = await createPartiallyPaidSource();
    const response = await apiFetch(`/dashboard/invoices/${source.id}`, { headers: { Cookie: adminA.sessionCookie } });
    const html = await response.text();
    expect(html).toContain("Aucun avoir émis sur cette facture.");
  });
});

describe("/dashboard/invoices/[id] — page d'un avoir (2c2-D)", () => {
  it("ADMIN : affiche le motif, la facture source, le statut « Non remboursé » et le bouton Rembourser", async () => {
    const source = await createPartiallyPaidSource();
    const creditNote = await createCreditNoteOn(source.id, 2000, "Motif affiché sur la page de l'avoir");

    const response = await apiFetch(`/dashboard/invoices/${creditNote.id}`, { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Motif affiché sur la page de l'avoir");
    expect(html).toContain(source.number);
    expect(html).toContain("Non remboursé");
    expect(html).toContain("Rembourser");
    // Le bloc "Paiements" (table des règlements de CETTE facture) n'est jamais rendu pour un
    // avoir — "Paiements" seul n'est pas un test fiable ici (le lien de navigation de la barre
    // latérale porte le même libellé sur toutes les pages) ; on vérifie l'absence du contenu
    // réellement propre à ce bloc.
    expect(html).not.toContain("Aucun paiement enregistré.");
  });

  it("jamais de bouton Rembourser pour un MEMBER, même avec un montant remboursable", async () => {
    const source = await createPartiallyPaidSource();
    const creditNote = await createCreditNoteOn(source.id, 2000, "Avoir MEMBER sans bouton");

    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Membre Sans Remboursement",
      email: `no-refund-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyAId } });
    await grantPermissions(member.userId, ["invoices.view"], "NoRefundGroup");

    const response = await apiFetch(`/dashboard/invoices/${creditNote.id}`, { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("Rembourser");
  });

  it("après remboursement intégral : le statut passe à « Remboursé intégralement » et le bouton Rembourser disparaît", async () => {
    const source = await createPartiallyPaidSource();
    const creditNote = await createCreditNoteOn(source.id, 2000, "Avoir remboursé intégralement pour test UI");
    const refundResponse = await apiFetch(`/api/invoices/${creditNote.id}/refund`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ amount: 2000, reason: "Remboursement intégral pour test UI" }),
    });
    expect(refundResponse.status).toBe(201);

    const response = await apiFetch(`/dashboard/invoices/${creditNote.id}`, { headers: { Cookie: adminA.sessionCookie } });
    const html = await response.text();
    expect(html).toContain("Remboursé intégralement");
    expect(html).not.toContain(">Rembourser<");
  });

  it("renvoie une page « introuvable » pour l'avoir d'un autre tenant", async () => {
    const source = await createPartiallyPaidSource();
    const creditNote = await createCreditNoteOn(source.id, 1000, "Avoir isolation tenant");

    const adminB = await registerTenantAdmin({
      tenantName: "Credit Notes UI Test B",
      tenantSlug: `credit-notes-ui-b-${runId}`,
      name: "Admin B",
      email: `admin-b-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    createdTenantIds.push(adminB.tenantId);

    const response = await apiFetch(`/dashboard/invoices/${creditNote.id}`, { headers: { Cookie: adminB.sessionCookie } });
    // Correctif sprint soft 404 (2026-08-24) : /dashboard/invoices/[id] (y compris un avoir,
    // même route) est désormais couverte par le garde de route centralisé
    // (src/lib/route-guards.ts, exécuté depuis src/proxy.ts avant toute frontière Suspense) —
    // vrai statut HTTP 404, plus un "soft 404" (200 + noindex). Voir SECURITY.md section 35 et
    // DOMAINRULES.md section 64.
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('name="robots" content="noindex"');
  });
});
