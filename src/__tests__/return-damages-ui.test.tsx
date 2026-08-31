import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";
import { createDamage } from "@/lib/damages";
import { createDamageInvoice } from "@/lib/damage-invoices";

/**
 * Sprint 32 (DOMAINRULES.md section 32) — tests de l'écran de retour (SSR), même paradigme que
 * src/__tests__/ui.test.tsx : un vrai serveur next dev de test rend les pages, on vérifie le
 * HTML produit — pas de jsdom/@testing-library (voir le commentaire en tête de ui.test.tsx :
 * décision délibérée de ne pas introduire un second paradigme de test dans ce projet). La
 * logique métier interactive (soumission réussie, erreur serveur, double soumission empêchée
 * côté serveur) est déjà couverte par les tests HTTP de route (location-return-route.test.ts,
 * damages-route.test.ts) qui frappent exactement les mêmes endpoints que ce panneau appelle —
 * ce fichier vérifie ce qu'eux ne peuvent pas : ce que le serveur *affiche*.
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let agencyA1Id: string;
let vehicleAId: string;
let clientAId: string;
let dateOffset = 0;

async function createAndActivateLocation(overrides: Record<string, unknown> = {}) {
  dateOffset += 10;
  const base = new Date(Date.UTC(2028, 0, 1));
  const start = new Date(base.getTime() + dateOffset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);

  const createResponse = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      vehicleId: vehicleAId,
      clientId: clientAId,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      startOdometer: 1000,
      ...overrides,
    }),
  });
  const { location } = await createResponse.json();

  await apiFetch(`/api/locations/${location.id}`, {
    method: "PATCH",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ status: "CONFIRMED" }),
  });
  await apiFetch(`/api/locations/${location.id}`, {
    method: "PATCH",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ status: "ACTIVE" }),
  });

  return location.id as string;
}

async function createPendingLocation(overrides: Record<string, unknown> = {}) {
  dateOffset += 10;
  const base = new Date(Date.UTC(2028, 0, 1));
  const start = new Date(base.getTime() + dateOffset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);

  const createResponse = await apiFetch("/api/locations", {
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
  const { location } = await createResponse.json();
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

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Return Damages UI Test",
    tenantSlug: `return-damages-ui-${runId}`,
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
      licensePlate: `UI-RET-${runId}`,
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
  await deleteTestTenants(createdTenantIds);
});

describe("Écran de retour — affichage du formulaire", () => {
  it("affiche les champs kilométrage/carburant et leurs contraintes natives", async () => {
    const locationId = await createAndActivateLocation();
    const response = await apiFetch(`/dashboard/locations/${locationId}/return`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain("Kilométrage et carburant de retour");
    expect(html).toContain('id="endOdometer"');
    expect(html).toContain('id="endFuelLevel"');
    // Kilométrage strictement supérieur au départ (1000 ici) — contrainte native min, en plus
    // de la revalidation serveur (voir location-return.test.ts).
    expect(html).toMatch(/id="endOdometer"[^>]*min="1001"/);
    expect(html).toMatch(/id="endOdometer"[^>]*required/);
    // Carburant : jauge à 5 valeurs discrètes 0-100 (FuelLevelSelect), jamais un champ libre.
    expect(html).toMatch(/<select[^>]*id="endFuelLevel"[^>]*required/);
    expect(html).toContain('value="0"');
    expect(html).toContain('value="100"');
  });

  it("affiche le récapitulatif non modifiable (contrat, client, solde)", async () => {
    const locationId = await createAndActivateLocation();
    const response = await apiFetch(`/dashboard/locations/${locationId}/return`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const html = await response.text();
    expect(html).toContain("Récapitulatif");
    expect(html).toContain("Client A");
    expect(html).toContain("Reste à payer (solde locatif)");
  });

  it("refuse l'accès sans authentification / sans permission / hors tenant", async () => {
    const locationId = await createAndActivateLocation();

    const unauth = await apiFetch(`/dashboard/locations/${locationId}/return`, { redirect: "manual" });
    expect(unauth.status).toBe(307); // redirection vers /login, comportement standard /dashboard

    const noPermMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Perm UI",
      email: `no-perm-ui-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: noPermMember.userId, agencyId: agencyA1Id } });
    await grantPermissions(noPermMember.userId, ["locations.view"], "NoCompleteUI");
    const forbidden = await apiFetch(`/dashboard/locations/${locationId}/return`, {
      headers: { Cookie: noPermMember.sessionCookie },
    });
    // Correctif sprint soft 404 (2026-08-24) : /dashboard/locations/[id]/return est désormais
    // couverte par le garde de route centralisé (src/lib/route-guards.ts, exécuté depuis
    // src/proxy.ts avant toute frontière Suspense) — vrai statut HTTP 404, plus un "soft 404"
    // (200 + noindex). Voir SECURITY.md section 35 et DOMAINRULES.md section 64.
    expect(forbidden.status).toBe(404);
    const forbiddenHtml = await forbidden.text();
    expect(forbiddenHtml).toContain('name="robots" content="noindex"');
    expect(forbiddenHtml).not.toContain('id="endOdometer"');
  });

  it("affiche un message clair (pas le formulaire) pour un contrat déjà clôturé", async () => {
    const locationId = await createAndActivateLocation();
    await apiFetch(`/api/locations/${locationId}/return`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 1200, endFuelLevel: 70 }),
    });

    const response = await apiFetch(`/dashboard/locations/${locationId}/return`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Ce contrat est déjà clôturé.");
    expect(html).not.toContain('id="endOdometer"');
  });
});

describe("Écran de retour — date/heure personnalisée selon permission", () => {
  it("sans locations.return_time.edit : champ non modifiable affiché", async () => {
    const locationId = await createAndActivateLocation();
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Return Time UI",
      email: `no-return-time-ui-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA1Id } });
    await grantPermissions(member.userId, ["locations.view", "locations.complete"], "NoReturnTimeUI");

    const response = await apiFetch(`/dashboard/locations/${locationId}/return`, {
      headers: { Cookie: member.sessionCookie },
    });
    const html = await response.text();
    expect(html).toContain('id="actualReturnAtReadonly"');
    // `disabled=""` = véritable attribut HTML (React) — distinct de la classe utilitaire
    // Tailwind `disabled:opacity-*` (préfixe de variante, jamais un attribut réel) que shadcn/ui
    // applique à tout <Input>, y compris non désactivé.
    expect(html).toMatch(/id="actualReturnAtReadonly"[^>]*disabled=""/);
    expect(html).toContain("non modifiable");
    expect(html).not.toContain('id="actualReturnAt"');
  });

  it("avec locations.return_time.edit : champ modifiable affiché", async () => {
    const locationId = await createAndActivateLocation();
    // adminA (ADMIN) court-circuite can() systématiquement.
    const response = await apiFetch(`/dashboard/locations/${locationId}/return`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const html = await response.text();
    expect(html).toMatch(/id="actualReturnAt"(?!Readonly)/);
    expect(html).not.toMatch(/id="actualReturnAt"[^>]*disabled=""/);
    expect(html).toContain("modifiable (permission accordée)");
  });
});

describe("Écran de retour — dégâts existants et statuts", () => {
  it("affiche plusieurs dégâts avec leurs statuts REPORTED, PARTIALLY_PAID et PAID", async () => {
    const locationId = await createAndActivateLocation();

    const reported = await createDamage({
      tenantId: adminA.tenantId,
      vehicleId: vehicleAId,
      locationId,
      createdByUserId: adminA.userId,
      nature: "Rayure portière",
      billableAmount: 1000,
      currency: "MAD",
    });
    const partial = await createDamage({
      tenantId: adminA.tenantId,
      vehicleId: vehicleAId,
      locationId,
      createdByUserId: adminA.userId,
      nature: "Pare-choc fissuré",
      billableAmount: 2000,
      currency: "MAD",
    });
    const paid = await createDamage({
      tenantId: adminA.tenantId,
      vehicleId: vehicleAId,
      locationId,
      createdByUserId: adminA.userId,
      nature: "Vitre fêlée",
      billableAmount: 500,
      currency: "MAD",
    });
    // Statuts forcés directement pour un test de pur affichage — le calcul réel du statut
    // (dérivé des paiements) est déjà couvert par damages.test.ts.
    await prisma.damage.update({ where: { id: partial.id }, data: { status: "PARTIALLY_PAID" } });
    await prisma.damage.update({ where: { id: paid.id }, data: { status: "PAID" } });

    const response = await apiFetch(`/dashboard/locations/${locationId}/return`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const html = await response.text();

    expect(html).toContain("Dégâts déjà déclarés sur ce contrat");
    expect(html).toContain(reported.nature);
    expect(html).toContain(partial.nature);
    expect(html).toContain(paid.nature);
    expect(html).toContain("Signalé");
    expect(html).toContain("Partiellement payé");
    expect(html).toContain("Payé");
  });

  it("affiche un lien vers la facture de dégâts pour un dégât facturé, jamais pour un dégât non facturé (Sprint 33)", async () => {
    const locationId = await createAndActivateLocation();
    const notYetInvoiced = await createDamage({
      tenantId: adminA.tenantId,
      vehicleId: vehicleAId,
      locationId,
      createdByUserId: adminA.userId,
      nature: "Aile enfoncée",
      billableAmount: 3000,
      currency: "MAD",
    });
    const toInvoice = await createDamage({
      tenantId: adminA.tenantId,
      vehicleId: vehicleAId,
      locationId,
      createdByUserId: adminA.userId,
      nature: "Jante voilée",
      billableAmount: 800,
      currency: "MAD",
    });
    const { invoice } = await createDamageInvoice({
      tenantId: adminA.tenantId,
      locationId,
      damageIds: [toInvoice.id],
    });

    const response = await apiFetch(`/dashboard/locations/${locationId}/return`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const html = await response.text();

    // React SSR insère des commentaires de délimitation d'hydratation entre le texte statique et
    // une expression JSX interpolée ({invoice.number}) — vérifiées séparément plutôt qu'en une
    // seule sous-chaîne concaténée, qui ne correspondrait jamais au HTML brut.
    expect(html).toContain("Voir la facture de dégâts");
    expect(html).toContain(invoice.number);
    expect(html).toContain("Pas encore facturé.");
    void notYetInvoiced;
  });

  it("sépare clairement le solde locatif du montant facturable d'un dégât", async () => {
    const locationId = await createAndActivateLocation({ startOdometer: 1000 });

    const damage = await createDamage({
      tenantId: adminA.tenantId,
      vehicleId: vehicleAId,
      locationId,
      createdByUserId: adminA.userId,
      nature: "Toit enfoncé",
      billableAmount: 2500,
      currency: "MAD",
    });

    const response = await apiFetch(`/dashboard/locations/${locationId}/return`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const html = await response.text();

    expect(html).toContain("Reste à payer (solde locatif)");
    expect(html).toContain("Montant facturable du dégât");
    void damage;
  });
});

describe("Écran de retour — adaptation responsive de base", () => {
  it("utilise des classes responsive (mobile empilé, desktop en grille)", async () => {
    const locationId = await createAndActivateLocation();
    const response = await apiFetch(`/dashboard/locations/${locationId}/return`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const html = await response.text();
    expect(html).toMatch(/grid-cols-1[^"]*sm:grid-cols-2/);
    expect(html).toMatch(/w-full sm:w-auto/);
  });
});

describe("Écran de retour — déclaration de dégât hors flux de retour", () => {
  it("affiche le formulaire de déclaration pour un contrat non actif", async () => {
    const locationId = await createPendingLocation();
    const response = await apiFetch(`/dashboard/locations/${locationId}/return`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const html = await response.text();
    expect(html).toContain("Déclarer un nouveau dégât");
    expect(html).toContain('id="standalone-damage-nature"');
  });
});
