import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Papa from "papaparse";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";
// Import depuis @/lib/export-constants (et non @/lib/exports) : ce dernier importe @/lib/authz,
// donc @/lib/auth (next-auth), qui échoue à se résoudre hors du serveur Next.js réel — même
// contrainte que le reste de la suite (routes appelées en HTTP réel, jamais leurs modules
// serveur importés directement dans un fichier de test).
import { VEHICLE_COLUMNS, CLIENT_COLUMNS, LOCATION_COLUMNS, INVOICE_COLUMNS, MAX_EXPORT_ROWS } from "@/lib/export-constants";
// @/lib/csv n'importe que papaparse (aucune dépendance next-auth) — sûr à importer directement
// dans un test, contrairement à @/lib/exports/@/lib/authz ci-dessus.
import { formatAmountForCsv, formatPercentFromBasisPoints } from "@/lib/csv";

/**
 * Sprint 13E tâche 3 — export CSV multi-entités (src/lib/exports.ts,
 * src/app/api/exports/[entity]/route.ts). Ce fichier ne couvre pour l'instant que la section
 * "vehicles" (première tranche livrée, voir DOMAINRULES.md) : authentification, permission
 * (vehicles.view), portée tenant/agence, filtres réels de la route (agencyId/status/category/
 * search), format CSV (colonnes déterministes, échappement, injection de formule, BOM, valeurs
 * nulles, accents, montants exacts, dates ISO), plafond MAX_EXPORT_ROWS, et audit de l'export
 * (uniquement en cas de succès, sans contenu de fichier). Les autres sections seront ajoutées
 * au fur et à mesure de leur implémentation.
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let agencyA1Id: string;
let agencyA2Id: string;
let agencyBId: string;
let memberA1: AuthenticatedTestUser; // lié uniquement à agencyA1, permissions MEMBER par défaut (inclut vehicles.view)
let memberNoPermission: AuthenticatedTestUser; // groupe personnalisé sans vehicles.view
let memberMinimal: AuthenticatedTestUser; // groupe personnalisé (maintenances.view uniquement) — sans clients/locations/invoices.view

let vehicleA1StandardId: string;
let vehicleA1NullFieldsId: string;
let vehicleA1FormulaId: string;
let vehicleA1SpecialCharsId: string;
let vehicleA2Id: string;
let vehicleBId: string;

let clientA1Id: string;
let clientA1NullId: string;
let clientA1FormulaId: string;
let clientA1SpecialCharsId: string;
let clientBId: string;

let locationA1Id: string;
let locationA2Id: string;
let locationBId: string;

let invoiceA1Id: string;
let invoiceA2Id: string;
let invoiceBId: string;

async function createVehicle(
  actor: AuthenticatedTestUser,
  agencyId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const suffix = `${runId}-${Math.floor(Math.random() * 1_000_000)}`;
  const response = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: actor.sessionCookie },
    body: JSON.stringify({
      agencyId,
      name: "Clio Test",
      licensePlate: `CSV-${suffix}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay: 5000,
      chassisNumber: `VF1CSV${suffix}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
      ...overrides,
    }),
  });
  if (response.status !== 201) {
    throw new Error(`Échec de création du véhicule de test (${response.status}) : ${await response.text()}`);
  }
  const { vehicle } = await response.json();
  return vehicle.id as string;
}

async function createClient(
  actor: AuthenticatedTestUser,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const suffix = `${runId}-${Math.floor(Math.random() * 1_000_000)}`;
  const response = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: actor.sessionCookie },
    body: JSON.stringify({
      name: "Client Test",
      email: `client-${suffix}@test.local`,
      ...overrides,
    }),
  });
  if (response.status !== 201) {
    throw new Error(`Échec de création du client de test (${response.status}) : ${await response.text()}`);
  }
  const { client } = await response.json();
  return client.id as string;
}

let dateOffset = 0;

async function createLocation(
  actor: AuthenticatedTestUser,
  vehicleId: string,
  clientId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  dateOffset += 10;
  const base = new Date(Date.UTC(2028, 0, 1));
  const start = new Date(base.getTime() + dateOffset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
  const response = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: actor.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      clientId,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      ...overrides,
    }),
  });
  if (response.status !== 201) {
    throw new Error(`Échec de création de la location de test (${response.status}) : ${await response.text()}`);
  }
  const { location } = await response.json();
  return location.id as string;
}

/**
 * Appelle POST /api/invoices manuellement — utilisée uniquement par le test dédié documentant
 * le comportement actuel (voir describe "Comportement actuel — facture automatique..."), jamais
 * dans les fixtures partagées. Depuis Sprint 13E tâche 3 (getOrCreateMainInvoice), un appel sur
 * une location dont la facture RENTAL auto-générée par POST /api/locations (Sprint 12B) existe
 * déjà est idempotent : il renvoie **200** et l'ID de cette même facture existante, jamais une
 * seconde ligne — accepte donc 200 ou 201 selon que la facture existait déjà ou non.
 */
async function createInvoice(
  actor: AuthenticatedTestUser,
  locationId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const response = await apiFetch("/api/invoices", {
    method: "POST",
    headers: { Cookie: actor.sessionCookie },
    body: JSON.stringify({ locationId, ...overrides }),
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`Échec de création de la facture de test (${response.status}) : ${await response.text()}`);
  }
  const { invoice } = await response.json();
  return invoice.id as string;
}

/**
 * Récupère l'unique facture DRAFT générée automatiquement par POST /api/locations pour cette
 * location (Sprint 12B) — c'est la facture réellement utilisée par les fixtures partagées de ce
 * fichier, jamais une facture créée manuellement en plus (voir le commentaire sur createInvoice
 * ci-dessus). Échoue bruyamment si ce n'est pas exactement 1 facture, pour ne jamais faire
 * silencieusement porter un test sur la mauvaise ligne.
 */
async function getAutoGeneratedInvoiceId(actor: AuthenticatedTestUser, locationId: string): Promise<string> {
  const response = await apiFetch(`/api/invoices?locationId=${locationId}`, {
    headers: { Cookie: actor.sessionCookie },
  });
  const { invoices } = await response.json();
  if (invoices.length !== 1) {
    throw new Error(
      `Facture auto-générée introuvable ou dupliquée pour locationId=${locationId} (${invoices.length} trouvée(s)).`
    );
  }
  return invoices[0].id as string;
}

/** PATCH taxRate/discountAmount d'une facture DRAFT (seul statut où ces champs restent
 * modifiables, DOMAINRULES.md section 17) — utilisé pour donner à la facture auto-générée un
 * taux de TVA non nul dans les fixtures, sans créer de seconde facture. */
async function patchInvoice(
  actor: AuthenticatedTestUser,
  invoiceId: string,
  body: Record<string, unknown>
): Promise<void> {
  const response = await apiFetch(`/api/invoices/${invoiceId}`, {
    method: "PATCH",
    headers: { Cookie: actor.sessionCookie },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    throw new Error(`Échec du PATCH de facture de test (${response.status}) : ${await response.text()}`);
  }
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

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  // Le fichier commence par le BOM UTF-8 (U+FEFF) — vérifié séparément par un test dédié ;
  // Papa.parse le tolère nativement (comportement standard, ignoré comme un caractère de forme).
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  return { headers: parsed.meta.fields ?? [], rows: parsed.data };
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "CSV Export Test A",
    tenantSlug: `csv-export-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "CSV Export Test B",
    tenantSlug: `csv-export-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminB.tenantId);

  const agencyA1Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A1", slug: `agence-a1-${runId}` }),
  });
  agencyA1Id = (await agencyA1Response.json()).agency.id;

  const agencyA2Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A2", slug: `agence-a2-${runId}` }),
  });
  agencyA2Id = (await agencyA2Response.json()).agency.id;

  memberA1 = await createAndLoginMember({
    tenantId: adminA.tenantId,
    name: "Member A1",
    email: `member-a1-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  await prisma.userAgency.create({ data: { userId: memberA1.userId, agencyId: agencyA1Id } });

  memberNoPermission = await createAndLoginMember({
    tenantId: adminA.tenantId,
    name: "Member No Permission",
    email: `member-no-perm-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  await prisma.userAgency.create({ data: { userId: memberNoPermission.userId, agencyId: agencyA1Id } });
  await grantPermissions(memberNoPermission.userId, ["clients.view"], "NoVehiclesView");

  memberMinimal = await createAndLoginMember({
    tenantId: adminA.tenantId,
    name: "Member Minimal",
    email: `member-minimal-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  await prisma.userAgency.create({ data: { userId: memberMinimal.userId, agencyId: agencyA1Id } });
  await grantPermissions(memberMinimal.userId, ["maintenances.view"], "Minimal");

  vehicleA1StandardId = await createVehicle(adminA, agencyA1Id, {
    name: "Clio Standard",
    status: "AVAILABLE",
    category: "Citadine",
    pricePerDay: 123456, // 1234.56 — vérifie l'arithmétique entière exacte de formatAmountForCsv
    currentOdometer: 15000,
    currentFuelLevel: 80,
    insuranceExpiryDate: "2030-06-15T00:00:00.000Z",
  });

  vehicleA1NullFieldsId = await createVehicle(adminA, agencyA1Id, {
    name: "Clio Sans Options",
    status: "MAINTENANCE",
    category: "Citadine",
    pricePerDay: undefined,
  });

  // Injection de formule CSV : un nom commençant par "=" doit ressortir préfixé d'une
  // apostrophe (sanitizeCsvCell, src/lib/csv.ts) une fois passé par la route réelle — pas
  // seulement testé unitairement (déjà couvert par csv-export-sanitization.test.ts).
  vehicleA1FormulaId = await createVehicle(adminA, agencyA1Id, {
    name: "=SUM(A1:A9)",
    status: "AVAILABLE",
    category: "Berline",
  });

  // Accents, guillemet, virgule et retour à la ligne dans un même champ texte libre — vérifie
  // l'échappement CSV réel (papaparse) et la préservation UTF-8 de bout en bout via la route.
  vehicleA1SpecialCharsId = await createVehicle(adminA, agencyA1Id, {
    name: 'Peugeot Étoilé, "Édition Spéciale"\nLigne 2',
    status: "AVAILABLE",
    category: "Berline",
  });

  vehicleA2Id = await createVehicle(adminA, agencyA2Id, {
    name: "SUV Agence 2",
    status: "RENTED",
    category: "SUV",
  });

  const agencyBResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Agence B", slug: `agence-b-${runId}` }),
  });
  agencyBId = (await agencyBResponse.json()).agency.id;

  vehicleBId = await createVehicle(adminB, agencyBId, { name: "Véhicule Tenant B" });

  clientA1Id = await createClient(adminA, {
    name: "Karim Étoilé",
    firstName: "Karim",
    lastName: "Étoilé",
    phone: "0600000001",
    address: "12 Rue Test",
    city: "Rabat",
    country: "Maroc",
    idType: "CIN",
    idNumber: `CIN${runId}`,
    licenseNumber: `PERMIS${runId}`,
    licenseIssueDate: "2015-01-01T00:00:00.000Z",
    licenseExpiryDate: "2099-12-31T00:00:00.000Z",
    birthDate: "1990-01-01T00:00:00.000Z",
  });

  // Client minimal (seuls name/email fournis) — vérifie que tous les autres champs sortent en
  // chaîne vide, jamais "null"/"undefined".
  clientA1NullId = await createClient(adminA, { name: "Client Minimal" });

  // Injection de formule CSV sur un champ Client (même vérification que sur Vehicle, mais pour
  // une entité dont le nom n'est jamais joint via une relation — valeur directe).
  clientA1FormulaId = await createClient(adminA, { name: "=SUM(A1:A9)" });

  // Accents, guillemet, virgule, retour à la ligne.
  clientA1SpecialCharsId = await createClient(adminA, {
    name: 'Fatima Ét, "Spéciale"\nLigne 2',
  });

  // birthDate/licenseExpiryDate requis pour désigner ce client comme conducteur d'un contrat
  // (assertClientMeetsMinimumAge/assertDriverLicenseCoversReturn, src/lib/locations.ts) — ce
  // client est utilisé plus bas dans locationBId.
  clientBId = await createClient(adminB, {
    name: "Client Tenant B",
    birthDate: "1990-01-01T00:00:00.000Z",
    licenseExpiryDate: "2099-12-31T00:00:00.000Z",
  });

  // Location/facture standard (agence A1) — deposit non nul pour vérifier l'arithmétique exacte
  // des montants sur une valeur distincte de pricePerDay/totalPrice. La facture utilisée est
  // celle générée automatiquement par POST /api/locations (Sprint 12B, src/app/api/locations/
  // route.ts) — jamais une facture créée manuellement en plus (voir le commentaire sur
  // createInvoice ci-dessus : POST /api/invoices reste appelable sur une location déjà pourvue
  // d'une facture, ce n'est pas un bug, mais ce n'est pas non plus le scénario que ces fixtures
  // veulent exercer). taxRate (points de base — 2000 = 20,00 %, TAX_RATE_BASIS dans
  // src/lib/invoices.ts) appliqué après coup par PATCH, seul moment où ce champ reste
  // modifiable (facture encore DRAFT).
  locationA1Id = await createLocation(adminA, vehicleA1StandardId, clientA1Id, { deposit: 50000 });
  invoiceA1Id = await getAutoGeneratedInvoiceId(adminA, locationA1Id);
  await patchInvoice(adminA, invoiceA1Id, { taxRate: 2000 });

  // Location/facture sur l'agence A2 (vehicleA2Id) — utilisée pour les tests de portée agence.
  locationA2Id = await createLocation(adminA, vehicleA2Id, clientA1Id);
  invoiceA2Id = await getAutoGeneratedInvoiceId(adminA, locationA2Id);

  // Tenant B — isolation.
  locationBId = await createLocation(adminB, vehicleBId, clientBId);
  invoiceBId = await getAutoGeneratedInvoiceId(adminB, locationBId);
});

afterAll(async () => {
  // Ordre imposé par les clés étrangères : Payment/Invoice avant Location, Location avant
  // Vehicle/Client, comme dans les autres fichiers de test (ex. damages-route.test.ts).
  await prisma.payment.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { user: { tenantId: { in: createdTenantIds } } } });
  await prisma.groupPermission.deleteMany({ where: { group: { tenantId: { in: createdTenantIds } } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  // Le CRON planifié (src/lib/scheduled-tasks.ts) balaie tous les tenants de la base de test à
  // chaque requête, y compris les nôtres — sous la suite complète (beaucoup plus de requêtes
  // qu'en exécution isolée de ce fichier), il peut créer une Alert pour un de nos véhicules/
  // locations avant que ce afterAll ne s'exécute. Nettoyage nécessaire avant de supprimer le
  // tenant, même interférence déjà documentée ailleurs dans la suite (ex. damages-route.test.ts).
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
});

describe("GET /api/exports/vehicles — authentification, permission, entité inconnue", () => {
  it("refuse une requête non authentifiée (401)", async () => {
    const response = await apiFetch("/api/exports/vehicles");
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER sans vehicles.view (403)", async () => {
    const response = await apiFetch("/api/exports/vehicles", {
      headers: { Cookie: memberNoPermission.sessionCookie },
    });
    expect(response.status).toBe(403);
  });

  it("refuse une section d'export inconnue (404)", async () => {
    const response = await apiFetch("/api/exports/section-inexistante", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /api/exports/vehicles — isolation tenant/agence", () => {
  it("un ADMIN ne voit jamais les véhicules d'un autre tenant", async () => {
    const vehicleB = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleBId } });

    const response = await apiFetch("/api/exports/vehicles", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const { rows } = parseCsv(await response.text());
    const plates = rows.map((row) => row.immatriculation);
    expect(plates).not.toContain(vehicleB.licensePlate);

    // Toutes les lignes appartiennent bien au tenant A (contrôle croisé Prisma, pas seulement
    // l'absence du véhicule B) — et réciproquement, l'export de B ne contient aucun véhicule A.
    const tenantAPlates = await prisma.vehicle.findMany({
      where: { tenantId: adminA.tenantId },
      select: { licensePlate: true },
    });
    expect(new Set(plates)).toEqual(new Set(tenantAPlates.map((v) => v.licensePlate)));

    const responseB = await apiFetch("/api/exports/vehicles", { headers: { Cookie: adminB.sessionCookie } });
    const { rows: rowsB } = parseCsv(await responseB.text());
    expect(rowsB.map((row) => row.immatriculation)).toEqual([vehicleB.licensePlate]);
  });

  it("un MEMBER lié uniquement à l'agence A1 ne voit pas les véhicules de l'agence A2 (export non filtré)", async () => {
    const response = await apiFetch("/api/exports/vehicles", { headers: { Cookie: memberA1.sessionCookie } });
    expect(response.status).toBe(200);
    const { rows } = parseCsv(await response.text());
    const agencies = new Set(rows.map((row) => row.agence));
    expect(agencies.has("Agence A1")).toBe(true);
    expect(agencies.has("Agence A2")).toBe(false);
  });

  it("refuse un agencyId explicite non accessible au MEMBER (403)", async () => {
    const response = await apiFetch(`/api/exports/vehicles?agencyId=${agencyA2Id}`, {
      headers: { Cookie: memberA1.sessionCookie },
    });
    expect(response.status).toBe(403);
  });

  it("un ADMIN peut exporter explicitement une seule agence via agencyId", async () => {
    const response = await apiFetch(`/api/exports/vehicles?agencyId=${agencyA2Id}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const { rows } = parseCsv(await response.text());
    expect(rows.every((row) => row.agence === "Agence A2")).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("GET /api/exports/vehicles — filtres réels de la route", () => {
  it("refuse un status invalide (400)", async () => {
    const response = await apiFetch("/api/exports/vehicles?status=NOT_A_STATUS", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(400);
  });

  it("applique le filtre status seul", async () => {
    const vehicleA2 = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleA2Id } });
    const response = await apiFetch("/api/exports/vehicles?status=RENTED", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const { rows } = parseCsv(await response.text());
    expect(rows.every((row) => row.statut === "RENTED")).toBe(true);
    expect(rows.some((row) => row.immatriculation === vehicleA2.licensePlate)).toBe(true);
  });

  it("combine agencyId + status + category", async () => {
    const response = await apiFetch(
      `/api/exports/vehicles?agencyId=${agencyA1Id}&status=AVAILABLE&category=Berline`,
      { headers: { Cookie: adminA.sessionCookie } }
    );
    const { rows } = parseCsv(await response.text());
    expect(rows.every((row) => row.agence === "Agence A1" && row.statut === "AVAILABLE" && row.categorie === "Berline")).toBe(
      true
    );
    // Doit inclure les véhicules formule/caractères spéciaux (agenceA1, AVAILABLE, Berline) et
    // exclure le véhicule MAINTENANCE (statut différent) et le véhicule SUV (catégorie différente).
    expect(rows.length).toBe(2);
  });

  it("applique le filtre search (nom/plaque/marque/modèle, insensible à la casse)", async () => {
    const response = await apiFetch("/api/exports/vehicles?search=renault", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const { rows } = parseCsv(await response.text());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.marque === "Renault")).toBe(true);
  });
});

describe("GET /api/exports/vehicles — format CSV", () => {
  it("préfixe le fichier avec le BOM UTF-8", async () => {
    // Response.text() décode en UTF-8 et absorbe silencieusement un BOM initial (comportement
    // standard de TextDecoder, WHATWG) — il faut inspecter les octets bruts pour vérifier sa
    // présence réelle dans le fichier (ce qui compte pour Excel, qui lit les octets, pas le
    // texte déjà décodé).
    const response = await apiFetch("/api/exports/vehicles", { headers: { Cookie: adminA.sessionCookie } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("expose l'en-tête Content-Disposition/Content-Type attendu", async () => {
    const response = await apiFetch("/api/exports/vehicles", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toMatch(/vehicules-\d{4}-\d{2}-\d{2}\.csv/);
  });

  it("colonnes dans un ordre fixe et déterministe", async () => {
    const response = await apiFetch("/api/exports/vehicles", { headers: { Cookie: adminA.sessionCookie } });
    const { headers } = parseCsv(await response.text());
    expect(headers).toEqual([...VEHICLE_COLUMNS]);
  });

  it("ordre des lignes déterministe (plus récent d'abord, comme la liste existante)", async () => {
    const response = await apiFetch("/api/exports/vehicles", { headers: { Cookie: adminA.sessionCookie } });
    const { rows } = parseCsv(await response.text());
    const standardPlate = (await prisma.vehicle.findUnique({ where: { id: vehicleA1StandardId } }))!.licensePlate;
    const a2Plate = (await prisma.vehicle.findUnique({ where: { id: vehicleA2Id } }))!.licensePlate;
    const indexStandard = rows.findIndex((row) => row.immatriculation === standardPlate);
    const indexA2 = rows.findIndex((row) => row.immatriculation === a2Plate);
    // vehicleA2 a été créé après vehicleA1Standard — doit apparaître avant lui (desc createdAt).
    expect(indexA2).toBeLessThan(indexStandard);
  });

  it("neutralise l'injection de formule CSV sur un champ texte libre (=...)", async () => {
    const plate = (await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleA1FormulaId } })).licensePlate;
    const response = await apiFetch("/api/exports/vehicles", { headers: { Cookie: adminA.sessionCookie } });
    const { rows } = parseCsv(await response.text());
    const row = rows.find((r) => r.immatriculation === plate);
    expect(row?.nom).toBe("'=SUM(A1:A9)");
  });

  it("échappe correctement guillemets/virgules/retours à la ligne et préserve les accents", async () => {
    const response = await apiFetch("/api/exports/vehicles", { headers: { Cookie: adminA.sessionCookie } });
    const { rows } = parseCsv(await response.text());
    const plate = (await prisma.vehicle.findUnique({ where: { id: vehicleA1SpecialCharsId } }))!.licensePlate;
    const row = rows.find((r) => r.immatriculation === plate);
    expect(row?.nom).toBe('Peugeot Étoilé, "Édition Spéciale"\nLigne 2');
  });

  it("représente les valeurs nulles de façon cohérente (chaîne vide, jamais 'null')", async () => {
    const response = await apiFetch("/api/exports/vehicles", { headers: { Cookie: adminA.sessionCookie } });
    const { rows } = parseCsv(await response.text());
    const plate = (await prisma.vehicle.findUnique({ where: { id: vehicleA1NullFieldsId } }))!.licensePlate;
    const row = rows.find((r) => r.immatriculation === plate);
    expect(row?.prixParJour).toBe("");
    expect(row?.assuranceExpiration).toBe("");
    expect(row?.kilometrageActuel).toBe("");
  });

  it("formate les dates en ISO 8601 stable", async () => {
    const response = await apiFetch("/api/exports/vehicles", { headers: { Cookie: adminA.sessionCookie } });
    const { rows } = parseCsv(await response.text());
    const plate = (await prisma.vehicle.findUnique({ where: { id: vehicleA1StandardId } }))!.licensePlate;
    const row = rows.find((r) => r.immatriculation === plate);
    expect(row?.assuranceExpiration).toBe("2030-06-15T00:00:00.000Z");
    expect(() => new Date(row!.creeLe).toISOString()).not.toThrow();
    expect(new Date(row!.creeLe).toISOString()).toBe(row!.creeLe);
  });

  it("exporte un montant exact, sans dérive flottante (123456 centimes -> \"1234.56\")", async () => {
    const response = await apiFetch("/api/exports/vehicles", { headers: { Cookie: adminA.sessionCookie } });
    const { rows } = parseCsv(await response.text());
    const plate = (await prisma.vehicle.findUnique({ where: { id: vehicleA1StandardId } }))!.licensePlate;
    const row = rows.find((r) => r.immatriculation === plate);
    expect(row?.prixParJour).toBe("1234.56");
    expect(row?.devise).toBe("MAD");
  });
});

describe("GET /api/exports/vehicles — audit de l'export", () => {
  it("journalise l'export réussi sans le contenu du fichier", async () => {
    const before = await prisma.auditLog.count({
      where: { tenantId: adminA.tenantId, action: "export.csv", resource: "Vehicle" },
    });
    const response = await apiFetch("/api/exports/vehicles?status=AVAILABLE", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const after = await prisma.auditLog.count({
      where: { tenantId: adminA.tenantId, action: "export.csv", resource: "Vehicle" },
    });
    expect(after).toBe(before + 1);

    const entry = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, action: "export.csv", resource: "Vehicle" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry?.userId).toBe(adminA.userId);
    const metadata = entry?.metadata as { entity: string; filters: Record<string, string>; rowCount: number };
    expect(metadata.entity).toBe("vehicles");
    expect(metadata.filters).toEqual({ status: "AVAILABLE" });
    expect(typeof metadata.rowCount).toBe("number");
    expect(JSON.stringify(entry?.metadata)).not.toContain("nom");
    expect(JSON.stringify(entry?.metadata)).not.toContain("Clio");
  });

  it("ne journalise rien sur un refus de permission", async () => {
    const before = await prisma.auditLog.count({
      where: { tenantId: adminA.tenantId, action: "export.csv", resource: "Vehicle" },
    });
    await apiFetch("/api/exports/vehicles", { headers: { Cookie: memberNoPermission.sessionCookie } });
    const after = await prisma.auditLog.count({
      where: { tenantId: adminA.tenantId, action: "export.csv", resource: "Vehicle" },
    });
    expect(after).toBe(before);
  });
});

describe("GET /api/exports/vehicles — plafond MAX_EXPORT_ROWS", () => {
  const overCapTenantIds: string[] = [];

  afterAll(async () => {
    await prisma.vehicle.deleteMany({ where: { tenantId: { in: overCapTenantIds } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: overCapTenantIds } } });
    await prisma.alert.deleteMany({ where: { tenantId: { in: overCapTenantIds } } });
    await prisma.agency.deleteMany({ where: { tenantId: { in: overCapTenantIds } } });
    await prisma.groupPermission.deleteMany({ where: { group: { tenantId: { in: overCapTenantIds } } } });
    await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: overCapTenantIds } } });
    await prisma.user.deleteMany({ where: { tenantId: { in: overCapTenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: overCapTenantIds } } });
  });

  it(`refuse explicitement (400) au-delà de ${MAX_EXPORT_ROWS} lignes, sans troncature silencieuse`, async () => {
    const adminC = await registerTenantAdmin({
      tenantName: "CSV Export Test C (volume)",
      tenantSlug: `csv-export-c-${runId}`,
      name: "Admin C",
      email: `admin-c-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    overCapTenantIds.push(adminC.tenantId);

    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminC.sessionCookie },
      body: JSON.stringify({ name: "Agence C", slug: `agence-c-${runId}` }),
    });
    const agencyCId = (await agencyResponse.json()).agency.id;

    const rowsToInsert = MAX_EXPORT_ROWS + 1;
    const data = Array.from({ length: rowsToInsert }, (_, index) => ({
      tenantId: adminC.tenantId,
      agencyId: agencyCId,
      name: "Volume Test",
      licensePlate: `VOL-${runId}-${index}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      chassisNumber: `VOLCH${runId}${index}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
    }));
    await prisma.vehicle.createMany({ data });

    const response = await apiFetch("/api/exports/vehicles", { headers: { Cookie: adminC.sessionCookie } });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain(String(MAX_EXPORT_ROWS));

    // Aucune ligne n'a été retournée (400, pas un CSV tronqué) et l'export refusé n'est pas audité.
    const auditCount = await prisma.auditLog.count({
      where: { tenantId: adminC.tenantId, action: "export.csv", resource: "Vehicle" },
    });
    expect(auditCount).toBe(0);
  }, 60_000);
});

describe("GET /api/exports/clients — tenant-only (Client n'a pas de colonne agence)", () => {
  it("refuse un MEMBER sans clients.view (403)", async () => {
    const response = await apiFetch("/api/exports/clients", { headers: { Cookie: memberMinimal.sessionCookie } });
    expect(response.status).toBe(403);
  });

  it("un agencyId fourni n'a strictement aucun effet (aucune colonne agence sur Client)", async () => {
    const unfiltered = await apiFetch("/api/exports/clients", { headers: { Cookie: adminA.sessionCookie } });
    const withAgency = await apiFetch(`/api/exports/clients?agencyId=${agencyA1Id}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(withAgency.status).toBe(200);
    const { rows: rowsUnfiltered } = parseCsv(await unfiltered.text());
    const { rows: rowsWithAgency } = parseCsv(await withAgency.text());
    expect(rowsWithAgency.length).toBe(rowsUnfiltered.length);
  });

  it("un MEMBER lié uniquement à l'agence A1 voit quand même tous les clients du tenant", async () => {
    const asMember = await apiFetch("/api/exports/clients", { headers: { Cookie: memberA1.sessionCookie } });
    const asAdmin = await apiFetch("/api/exports/clients", { headers: { Cookie: adminA.sessionCookie } });
    const { rows: memberRows } = parseCsv(await asMember.text());
    const { rows: adminRows } = parseCsv(await asAdmin.text());
    expect(memberRows.length).toBe(adminRows.length);
  });

  it("isolation tenant : adminB ne voit jamais les clients du tenant A", async () => {
    const response = await apiFetch("/api/exports/clients", { headers: { Cookie: adminB.sessionCookie } });
    const { rows } = parseCsv(await response.text());
    expect(rows.length).toBe(1);
    expect(rows[0].nom).toBe("Client Tenant B");
  });

  it("applique le filtre search (nom/email, insensible à la casse)", async () => {
    const response = await apiFetch("/api/exports/clients?search=étoilé", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const { rows } = parseCsv(await response.text());
    expect(rows.length).toBe(1);
    expect(rows[0].nom).toBe("Karim Étoilé");
  });

  it("colonnes dans un ordre fixe et déterministe", async () => {
    const response = await apiFetch("/api/exports/clients", { headers: { Cookie: adminA.sessionCookie } });
    const { headers } = parseCsv(await response.text());
    expect(headers).toEqual([...CLIENT_COLUMNS]);
  });

  it("valeurs nulles cohérentes (client minimal)", async () => {
    const stored = await prisma.client.findUniqueOrThrow({ where: { id: clientA1NullId } });
    const response = await apiFetch("/api/exports/clients", { headers: { Cookie: adminA.sessionCookie } });
    const { rows } = parseCsv(await response.text());
    const row = rows.find((r) => r.nom === stored.name);
    expect(row?.telephone).toBe("");
    expect(row?.numeroPiece).toBe("");
    expect(row?.permisExpiration).toBe("");
    expect(row?.dateNaissance).toBe("");
  });

  it("neutralise l'injection de formule CSV", async () => {
    const stored = await prisma.client.findUniqueOrThrow({ where: { id: clientA1FormulaId } });
    expect(stored.name).toBe("=SUM(A1:A9)");
    const response = await apiFetch("/api/exports/clients", { headers: { Cookie: adminA.sessionCookie } });
    const { rows } = parseCsv(await response.text());
    const row = rows.find((r) => r.nom === "'=SUM(A1:A9)");
    expect(row).toBeDefined();
  });

  it("échappe guillemets/virgules/retours à la ligne et préserve les accents", async () => {
    const stored = await prisma.client.findUniqueOrThrow({ where: { id: clientA1SpecialCharsId } });
    const response = await apiFetch("/api/exports/clients", { headers: { Cookie: adminA.sessionCookie } });
    const { rows } = parseCsv(await response.text());
    const row = rows.find((r) => r.nom === stored.name);
    expect(row).toBeDefined();
  });

  it("dates ISO 8601 et identifiant de pièce corrects", async () => {
    const response = await apiFetch("/api/exports/clients?search=Karim", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const { rows } = parseCsv(await response.text());
    const row = rows[0];
    expect(row.dateNaissance).toBe("1990-01-01T00:00:00.000Z");
    expect(row.permisExpiration).toBe("2099-12-31T00:00:00.000Z");
    expect(row.typePiece).toBe("CIN");
    expect(row.numeroPiece).toBe(`CIN${runId}`);
  });

  it("journalise l'export réussi (entity/filters/rowCount, jamais le contenu)", async () => {
    const before = await prisma.auditLog.count({
      where: { tenantId: adminA.tenantId, action: "export.csv", resource: "Client" },
    });
    const response = await apiFetch("/api/exports/clients?search=Karim", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const after = await prisma.auditLog.count({
      where: { tenantId: adminA.tenantId, action: "export.csv", resource: "Client" },
    });
    expect(after).toBe(before + 1);

    const entry = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, action: "export.csv", resource: "Client" },
      orderBy: { createdAt: "desc" },
    });
    const metadata = entry?.metadata as { entity: string; filters: Record<string, string>; rowCount: number };
    expect(metadata.entity).toBe("clients");
    expect(metadata.filters).toEqual({ search: "Karim" });
    expect(metadata.rowCount).toBe(1);
    expect(JSON.stringify(entry?.metadata)).not.toContain("Étoilé");
  });
});

describe("GET /api/exports/locations — portée agence (agencyId direct, fidèle à GET /api/locations)", () => {
  it("refuse un MEMBER sans locations.view (403)", async () => {
    const response = await apiFetch("/api/exports/locations", { headers: { Cookie: memberMinimal.sessionCookie } });
    expect(response.status).toBe(403);
  });

  it("refuse un status invalide (400)", async () => {
    const response = await apiFetch("/api/exports/locations?status=NOT_A_STATUS", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(400);
  });

  it("refuse une date de début postérieure à la date de fin (400)", async () => {
    const response = await apiFetch("/api/exports/locations?from=2030-01-10&to=2030-01-01", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(400);
  });

  it("refuse une date invalide (400)", async () => {
    const response = await apiFetch("/api/exports/locations?from=not-a-date", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(400);
  });

  it("un MEMBER lié uniquement à l'agence A1 ne voit pas les locations de l'agence A2", async () => {
    const response = await apiFetch("/api/exports/locations", { headers: { Cookie: memberA1.sessionCookie } });
    expect(response.status).toBe(200);
    const { rows } = parseCsv(await response.text());
    expect(rows.every((row) => row.agence === "Agence A1")).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("refuse un agencyId explicite non accessible au MEMBER (403)", async () => {
    const response = await apiFetch(`/api/exports/locations?agencyId=${agencyA2Id}`, {
      headers: { Cookie: memberA1.sessionCookie },
    });
    expect(response.status).toBe(403);
  });

  it("un ADMIN peut exporter explicitement l'agence A2 uniquement", async () => {
    const response = await apiFetch(`/api/exports/locations?agencyId=${agencyA2Id}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const { rows } = parseCsv(await response.text());
    expect(rows.length).toBe(1);
    expect(rows[0].agence).toBe("Agence A2");
  });

  it("isolation tenant : adminB ne voit jamais les locations du tenant A", async () => {
    const response = await apiFetch("/api/exports/locations", { headers: { Cookie: adminB.sessionCookie } });
    const { rows } = parseCsv(await response.text());
    expect(rows.length).toBe(1);
    expect(rows[0].client).toBe("Client Tenant B");
  });

  it("filtre par vehicleId/clientId/status combinés", async () => {
    const response = await apiFetch(
      `/api/exports/locations?vehicleId=${vehicleA1StandardId}&clientId=${clientA1Id}&status=PENDING`,
      { headers: { Cookie: adminA.sessionCookie } }
    );
    const { rows } = parseCsv(await response.text());
    expect(rows.length).toBe(1);
    expect(rows[0].vehicule).toBe("Clio Standard");
  });

  it("colonnes dans un ordre fixe et déterministe", async () => {
    const response = await apiFetch("/api/exports/locations", { headers: { Cookie: adminA.sessionCookie } });
    const { headers } = parseCsv(await response.text());
    expect(headers).toEqual([...LOCATION_COLUMNS]);
  });

  it("agenceRetour vide (dropoffAgencyId null) et montants exacts (dont deposit)", async () => {
    const stored = await prisma.location.findUniqueOrThrow({ where: { id: locationA1Id } });
    const response = await apiFetch(
      `/api/exports/locations?vehicleId=${vehicleA1StandardId}&clientId=${clientA1Id}`,
      { headers: { Cookie: adminA.sessionCookie } }
    );
    const { rows } = parseCsv(await response.text());
    const row = rows[0];
    expect(row.agenceRetour).toBe("");
    expect(row.prixParJour).toBe(formatAmountForCsv(stored.pricePerDay));
    expect(row.prixTotal).toBe(formatAmountForCsv(stored.totalPrice));
    expect(row.caution).toBe(formatAmountForCsv(stored.deposit!));
    expect(stored.deposit).toBe(50000);
    expect(row.devise).toBe(stored.currency);
  });

  it("journalise l'export réussi", async () => {
    const before = await prisma.auditLog.count({
      where: { tenantId: adminA.tenantId, action: "export.csv", resource: "Location" },
    });
    const response = await apiFetch(`/api/exports/locations?status=PENDING`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const after = await prisma.auditLog.count({
      where: { tenantId: adminA.tenantId, action: "export.csv", resource: "Location" },
    });
    expect(after).toBe(before + 1);
    const entry = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, action: "export.csv", resource: "Location" },
      orderBy: { createdAt: "desc" },
    });
    const metadata = entry?.metadata as { entity: string; filters: Record<string, string>; rowCount: number };
    expect(metadata.entity).toBe("locations");
    expect(metadata.filters).toEqual({ status: "PENDING" });
    expect(typeof metadata.rowCount).toBe("number");
  });
});

describe("GET /api/exports/invoices — portée agence (agencyId direct), aucune donnée bancaire", () => {
  it("refuse un MEMBER sans invoices.view (403)", async () => {
    const response = await apiFetch("/api/exports/invoices", { headers: { Cookie: memberMinimal.sessionCookie } });
    expect(response.status).toBe(403);
  });

  it("refuse un status invalide (400)", async () => {
    const response = await apiFetch("/api/exports/invoices?status=NOT_A_STATUS", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(400);
  });

  it("refuse une date de début postérieure à la date de fin (400)", async () => {
    const response = await apiFetch("/api/exports/invoices?from=2030-01-10&to=2030-01-01", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(400);
  });

  it("ignore un excludeReplaced fourni en query (jamais exposé par la route réelle)", async () => {
    const withParam = await apiFetch("/api/exports/invoices?excludeReplaced=true", {
      headers: { Cookie: adminA.sessionCookie },
    });
    const without = await apiFetch("/api/exports/invoices", { headers: { Cookie: adminA.sessionCookie } });
    const { rows: rowsWith } = parseCsv(await withParam.text());
    const { rows: rowsWithout } = parseCsv(await without.text());
    expect(rowsWith.length).toBe(rowsWithout.length);
  });

  it("un MEMBER lié uniquement à l'agence A1 ne voit pas les factures de l'agence A2", async () => {
    const invoiceA2 = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceA2Id } });
    const response = await apiFetch("/api/exports/invoices", { headers: { Cookie: memberA1.sessionCookie } });
    const { rows } = parseCsv(await response.text());
    expect(rows.every((row) => row.agence === "Agence A1")).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.numero === invoiceA2.number)).toBe(false);
  });

  it("refuse un agencyId explicite non accessible au MEMBER (403)", async () => {
    const response = await apiFetch(`/api/exports/invoices?agencyId=${agencyA2Id}`, {
      headers: { Cookie: memberA1.sessionCookie },
    });
    expect(response.status).toBe(403);
  });

  it("isolation tenant : adminB ne voit jamais les factures du tenant A", async () => {
    const invoiceB = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceBId } });
    const response = await apiFetch("/api/exports/invoices", { headers: { Cookie: adminB.sessionCookie } });
    const { rows } = parseCsv(await response.text());
    expect(rows.length).toBe(1);
    expect(rows[0].numero).toBe(invoiceB.number);
  });

  it("colonnes dans un ordre fixe et déterministe, sans aucune colonne bancaire", async () => {
    const response = await apiFetch("/api/exports/invoices", { headers: { Cookie: adminA.sessionCookie } });
    const { headers } = parseCsv(await response.text());
    expect(headers).toEqual([...INVOICE_COLUMNS]);
    const forbidden = ["carte", "card", "cvv", "cvc", "token", "iban", "secret"];
    for (const header of headers) {
      expect(forbidden.some((word) => header.toLowerCase().includes(word))).toBe(false);
    }
  });

  it("montants exacts (sous-total/TVA/remise/total) et taux de TVA converti en pourcentage lisible (points de base -> %, pas la valeur brute)", async () => {
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceA1Id } });
    const response = await apiFetch(`/api/exports/invoices?locationId=${locationA1Id}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const { rows } = parseCsv(await response.text());
    const row = rows[0];
    expect(row.sousTotal).toBe(formatAmountForCsv(stored.subtotal));
    expect(row.montantTotal).toBe(formatAmountForCsv(stored.totalAmount));
    expect(row.montantTVA).toBe(formatAmountForCsv(stored.taxAmount));
    // taxRate est stocké en points de base (2000 = 20,00 %) — la colonne doit exporter "20",
    // jamais "2000" (bug corrigé, voir formatPercentFromBasisPoints, src/lib/csv.ts).
    expect(stored.taxRate).toBe(2000);
    expect(row.tauxTVAPourcent).toBe("20");
    expect(row.devise).toBe(stored.currency);
  });

  it("taux de TVA : conversion exacte points de base -> pourcentage (2000->20, 750->7.5, 0->0)", async () => {
    expect(formatPercentFromBasisPoints(2000)).toBe("20");
    expect(formatPercentFromBasisPoints(750)).toBe("7.5");
    expect(formatPercentFromBasisPoints(0)).toBe("0");
    expect(formatPercentFromBasisPoints(null)).toBe("");
    expect(formatPercentFromBasisPoints(undefined)).toBe("");
    expect(formatPercentFromBasisPoints(Number.NaN)).toBe("");
  });

  it("journalise l'export réussi", async () => {
    const before = await prisma.auditLog.count({
      where: { tenantId: adminA.tenantId, action: "export.csv", resource: "Invoice" },
    });
    const response = await apiFetch(`/api/exports/invoices?agencyId=${agencyA1Id}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const after = await prisma.auditLog.count({
      where: { tenantId: adminA.tenantId, action: "export.csv", resource: "Invoice" },
    });
    expect(after).toBe(before + 1);
    const entry = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, action: "export.csv", resource: "Invoice" },
      orderBy: { createdAt: "desc" },
    });
    const metadata = entry?.metadata as { entity: string; filters: Record<string, string>; rowCount: number };
    expect(metadata.entity).toBe("invoices");
    expect(metadata.filters).toEqual({ agencyId: agencyA1Id });
    expect(typeof metadata.rowCount).toBe("number");
  });

  describe("Sprint 13E tâche 3, sous-phase 2c2-B — CREDIT_NOTE identifiable dans l'export", () => {
    async function createIssuedInvoiceWithCreditNote(amount: number, reason: string) {
      const locationId = await createLocation(adminA, vehicleA1StandardId, clientA1Id);
      const invoiceId = await getAutoGeneratedInvoiceId(adminA, locationId);
      const finalizeResponse = await apiFetch(`/api/invoices/${invoiceId}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ status: "ISSUED" }),
      });
      expect(finalizeResponse.status).toBe(200);
      const sourceInvoice = (await finalizeResponse.json()).invoice as {
        id: string;
        number: string;
        totalAmount: number;
      };

      const creditNoteResponse = await apiFetch(`/api/invoices/${sourceInvoice.id}/credit-notes`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ amount, reason }),
      });
      expect(creditNoteResponse.status).toBe(201);
      const creditNote = (await creditNoteResponse.json()).invoice as { id: string; number: string };
      return { sourceInvoice, creditNote };
    }

    it("export par défaut : l'avoir est présent et identifiable (type/factureOrigine/motif), jamais mélangé sans indication", async () => {
      const { sourceInvoice, creditNote } = await createIssuedInvoiceWithCreditNote(1000, "Avoir export test");
      const response = await apiFetch("/api/exports/invoices", { headers: { Cookie: adminA.sessionCookie } });
      const { rows } = parseCsv(await response.text());

      const row = rows.find((r) => r.numero === creditNote.number);
      expect(row).toBeDefined();
      expect(row!.type).toBe("CREDIT_NOTE");
      expect(row!.statut).toBe("CREDIT_NOTE");
      expect(row!.factureOrigine).toBe(sourceInvoice.number);
      expect(row!.motif).toBe("Avoir export test");

      const sourceRow = rows.find((r) => r.numero === sourceInvoice.number);
      expect(sourceRow!.type).toBe("RENTAL");
      expect(sourceRow!.factureOrigine).toBe("");
    });

    it("filtre status=CREDIT_NOTE : n'isole que les avoirs", async () => {
      const { creditNote } = await createIssuedInvoiceWithCreditNote(500, "Avoir filtre test");
      const response = await apiFetch("/api/exports/invoices?status=CREDIT_NOTE", {
        headers: { Cookie: adminA.sessionCookie },
      });
      expect(response.status).toBe(200);
      const { rows } = parseCsv(await response.text());
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.statut === "CREDIT_NOTE" && r.type === "CREDIT_NOTE")).toBe(true);
      expect(rows.some((r) => r.numero === creditNote.number)).toBe(true);
    });

    it("factureOrigine référence le numéro exact de la facture source, jamais un id technique brut", async () => {
      const { sourceInvoice, creditNote } = await createIssuedInvoiceWithCreditNote(750, "Avoir référence test");
      const response = await apiFetch("/api/exports/invoices?status=CREDIT_NOTE", {
        headers: { Cookie: adminA.sessionCookie },
      });
      const { rows } = parseCsv(await response.text());
      const row = rows.find((r) => r.numero === creditNote.number);
      expect(row!.factureOrigine).toBe(sourceInvoice.number);
      expect(row!.factureOrigine).toMatch(/^INV-\d{4}-\d{5}$/);
    });

    it("absence de doublon : l'avoir n'apparaît qu'une seule fois dans l'export par défaut", async () => {
      const { creditNote } = await createIssuedInvoiceWithCreditNote(600, "Avoir doublon test");
      const response = await apiFetch("/api/exports/invoices", { headers: { Cookie: adminA.sessionCookie } });
      const { rows } = parseCsv(await response.text());
      expect(rows.filter((r) => r.numero === creditNote.number)).toHaveLength(1);
    });

    it("aucun secret ni donnée sensible dans les nouvelles colonnes (type/factureOrigine/motif)", async () => {
      await createIssuedInvoiceWithCreditNote(400, "Avoir sécurité test");
      const response = await apiFetch("/api/exports/invoices", { headers: { Cookie: adminA.sessionCookie } });
      const { headers } = parseCsv(await response.text());
      const forbidden = ["carte", "card", "cvv", "cvc", "token", "iban", "secret", "password", "hash"];
      for (const header of ["type", "factureOrigine", "motif"]) {
        expect(headers).toContain(header);
        expect(forbidden.some((word) => header.toLowerCase().includes(word))).toBe(false);
      }
    });
  });
});

/**
 * Comportement de POST /api/locations et POST /api/invoices, documenté explicitement suite à
 * une investigation d'incident (Sprint 13E tâche 3) : un rapport initial avait décrit une
 * "duplication de facture" comme un défaut serveur. L'investigation (instrumentation temporaire
 * de la route et du service, retirée après coup) a confirmé qu'il n'existe aucune double
 * exécution — la route/le service ne sont invoqués qu'une seule fois par appel HTTP. Le
 * résultat observé à l'époque (deux factures pour une location) venait du fait que rien
 * n'empêchait alors un second appel manuel à POST /api/invoices de créer une seconde facture —
 * question métier laissée ouverte depuis le Sprint 18 (DOMAINRULES.md section 17).
 *
 * **Résolu par Sprint 13E tâche 3** : le propriétaire du projet a tranché — une Location a au
 * plus une facture RENTAL active (getOrCreateMainInvoice, src/lib/invoices.ts, double protection
 * verrou applicatif + index unique partiel Postgres). POST /api/locations continue de générer
 * automatiquement une facture DRAFT (Sprint 12B) ; un appel manuel supplémentaire à
 * POST /api/invoices sur la même location est désormais idempotent (200, même facture retournée,
 * jamais de doublon) plutôt qu'accepté sans contrôle. Ce test fige ce nouveau comportement
 * résolu pour détecter toute régression future.
 */
describe("Facture automatique à la création d'une location, puis facture principale idempotente (DOMAINRULES.md section 17, résolu Sprint 13E tâche 3)", () => {
  const tenantIds: string[] = [];
  let admin: AuthenticatedTestUser;
  let agencyId: string;
  let vehicleId: string;
  let clientId: string;

  beforeAll(async () => {
    const suffix = `${runId}-doc`;
    admin = await registerTenantAdmin({
      tenantName: "CSV Export Test Doc Invoice",
      tenantSlug: `csv-export-doc-${suffix}`,
      name: "Admin Doc",
      email: `admin-doc-${suffix}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    tenantIds.push(admin.tenantId);

    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: "Agence Doc", slug: `agence-doc-${suffix}` }),
    });
    agencyId = (await agencyResponse.json()).agency.id;

    vehicleId = await createVehicle(admin, agencyId, { name: "Véhicule Doc" });
    clientId = await createClient(admin, {
      name: "Client Doc",
      birthDate: "1990-01-01T00:00:00.000Z",
      licenseExpiryDate: "2099-12-31T00:00:00.000Z",
    });
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.invoice.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.location.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.vehicle.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.client.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.agency.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.groupPermission.deleteMany({ where: { group: { tenantId: { in: tenantIds } } } });
    await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.alert.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  });

  it("POST /api/locations génère automatiquement exactement une facture DRAFT", async () => {
    const locationId = await createLocation(admin, vehicleId, clientId);

    const response = await apiFetch(`/api/invoices?locationId=${locationId}`, {
      headers: { Cookie: admin.sessionCookie },
    });
    const { invoices } = await response.json();

    expect(invoices).toHaveLength(1);
    expect(invoices[0].status).toBe("DRAFT");
    expect(invoices[0].locationId).toBe(locationId);
  });

  it("un appel manuel supplémentaire à POST /api/invoices sur la même location est idempotent : même facture, pas de doublon", async () => {
    const locationId = await createLocation(admin, vehicleId, clientId);

    const autoInvoiceId = await getAutoGeneratedInvoiceId(admin, locationId);

    // Second appel manuel, volontaire, pour prouver l'idempotence plutôt que de la supposer.
    const secondInvoiceId = await createInvoice(admin, locationId);
    expect(secondInvoiceId).toBe(autoInvoiceId);

    const listResponse = await apiFetch(`/api/invoices?locationId=${locationId}`, {
      headers: { Cookie: admin.sessionCookie },
    });
    const { invoices } = await listResponse.json();
    expect(invoices).toHaveLength(1);
    expect(invoices[0].id).toBe(autoInvoiceId);
  });
});
