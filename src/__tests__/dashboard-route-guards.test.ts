import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

/**
 * Correctif sprint soft 404 (2026-08-24, DOMAINRULES.md section 64, SECURITY.md section 35) —
 * matrice exhaustive du garde de route centralisé (`src/lib/route-guards.ts`, exécuté depuis
 * `src/proxy.ts`). Teste explicitement le STATUT HTTP RÉEL (jamais seulement le contenu HTML —
 * exigence explicite de ce sprint), pour chaque type de ressource sous `/dashboard/*` et chaque
 * niveau d'autorisation. Utilise `redirect: "manual"` pour inspecter les redirections sans les
 * suivre (`undici`/Node ne les opacifie pas, contrairement à un navigateur).
 *
 * Panne de base de données / erreur technique : AUCUNE infrastructure de fault injection
 * n'existe dans ce projet (aucun mock nulle part dans la suite existante, toujours de vraies
 * requêtes contre un vrai Postgres). Ce cas n'est donc PAS testé ici en conditions réelles — il
 * est garanti par construction (`try/catch` autour de l'évaluation du garde dans
 * `src/proxy.ts`, qui journalise et laisse la requête continuer vers la page plutôt que de
 * renvoyer un 404) et vérifiable par relecture directe de ce fichier. Ne pas confondre avec un
 * test réellement exécuté — voir TESTREPORT.md pour cette distinction explicite.
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];
const password = "Correct-Horse-Battery-Staple9!";

interface Tenant {
  admin: AuthenticatedTestUser;
  agencyId: string;
  agencyCity: string;
  clientId: string;
}

async function setupTenant(label: string): Promise<Tenant> {
  const admin = await registerTenantAdmin({
    tenantName: `Guard ${label} ${runId}`,
    tenantSlug: `guard-${label}-${runId}`,
    name: "Admin",
    email: `admin-guard-${label}-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(admin.tenantId);

  const agencyCity = `Ville-${label}-${runId}`;
  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: `Agence ${label}`, slug: `guard-agence-${label}-${runId}`, city: agencyCity }),
  });
  const agencyId = (await agencyResponse.json()).agency.id;

  const clientResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      name: `Client ${label}`,
      email: `client-guard-${label}-${runId}@test.local`,
      licenseExpiryDate: "2099-12-31",
      birthDate: "1990-01-01",
    }),
  });
  const clientId = (await clientResponse.json()).client.id;

  return { admin, agencyId, agencyCity, clientId };
}

async function createSecondAgency(tenant: Tenant, label: string) {
  const response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ name: `Agence B ${label}`, slug: `guard-agenceb-${label}-${runId}` }),
  });
  return (await response.json()).agency as { id: string; name: string };
}

async function createScopedMember(
  tenant: Tenant,
  label: string,
  permissions: string[],
  agencyIds: string[] = [tenant.agencyId]
) {
  const groupResponse = await apiFetch("/api/permission-groups", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ name: `GRD-${label}-${runId}`, permissions }),
  });
  const groupId = (await groupResponse.json()).group.id;

  const member = await createAndLoginMember({
    tenantId: tenant.admin.tenantId,
    name: label,
    email: `grd-${label}-${runId}@test.local`,
    password,
  });
  await apiFetch(`/api/users/${member.userId}`, {
    method: "PATCH",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ agencyIds }),
  });
  await apiFetch(`/api/users/${member.userId}/permissions`, {
    method: "PATCH",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ permissionGroupId: groupId }),
  });
  return member;
}

async function createVehicle(tenant: Tenant, label: string, agencyId: string = tenant.agencyId) {
  const response = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({
      agencyId,
      name: "Clio",
      licensePlate: `GRD-${Math.floor(Math.random() * 1_000_000)}-${label}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay: 20000,
      chassisNumber: `VF1GRD${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 90,
      powerKW: 67,
      engineSize: 1.5,
    }),
  });
  return (await response.json()).vehicle as { id: string; agencyId: string };
}

async function createAndActivateLocation(tenant: Tenant, vehicleId: string) {
  const now = Date.now();
  const start = new Date(now);
  const end = new Date(now + 2 * 24 * 60 * 60 * 1000);
  const createResponse = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      clientId: tenant.clientId,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      payment: { deferred: true },
    }),
  });
  const { location } = await createResponse.json();
  await apiFetch(`/api/locations/${location.id}`, {
    method: "PATCH",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ status: "CONFIRMED" }),
  });
  const activateResponse = await apiFetch(`/api/locations/${location.id}`, {
    method: "PATCH",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ status: "ACTIVE" }),
  });
  return (await activateResponse.json()).location as { id: string; agencyId: string };
}

async function createInvoiceForLocation(tenant: Tenant, locationId: string) {
  const response = await apiFetch("/api/invoices", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ locationId }),
  });
  return (await response.json()).invoice as { id: string };
}

async function createBilledDamageInvoice(tenant: Tenant, locationId: string) {
  const response = await apiFetch("/api/damages", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({ locationId, nature: "Rayure test", billableAmount: 1000 }),
  });
  const body = await response.json();
  return body.damageInvoice.id as string;
}

async function createReservation(tenant: Tenant, overrides: Record<string, unknown> = {}) {
  const response = await apiFetch("/api/reservations", {
    method: "POST",
    headers: { Cookie: tenant.admin.sessionCookie },
    body: JSON.stringify({
      voucherNumber: `V-${runId}-${Math.random().toString(36).slice(2, 8)}`,
      clientFirstName: "Jean",
      clientLastName: "Testeur",
      startDate: "2030-06-01",
      endDate: "2030-06-03",
      ...overrides,
    }),
  });
  return (await response.json()).reservation as { id: string };
}

/** `redirect: "manual"` : undici (fetch Node.js) n'opacifie pas la réponse contrairement à un
 * navigateur — statut et header Location restent lisibles directement. */
function fetchPage(path: string, cookie?: string) {
  return apiFetch(path, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
}

afterAll(async () => {
  for (const tenantId of createdTenantIds) {
    await prisma.location.deleteMany({ where: { tenantId } }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------------------------
// Utilisateur non authentifié — toutes les catégories de route redirigent vers /login
// ---------------------------------------------------------------------------------------------

describe("Utilisateur non authentifié — vraie redirection HTTP vers /login", () => {
  const representativePaths = [
    "/dashboard",
    "/dashboard/agencies/anything",
    "/dashboard/agencies/new",
    "/dashboard/clients/anything",
    "/dashboard/vehicles/anything",
    "/dashboard/locations/anything",
    "/dashboard/locations/anything/return",
    "/dashboard/reservations/anything",
    "/dashboard/reservations/anything/convert",
    "/dashboard/reservations/anything/edit",
    "/dashboard/reservations/new",
    "/dashboard/reservations/import",
    "/dashboard/invoices/anything",
    "/dashboard/damage-invoices/anything",
    "/dashboard/permission-groups/anything",
    "/dashboard/tenants/anything",
    "/dashboard/users/anything",
    "/dashboard/users/anything/permissions",
  ];

  for (const path of representativePaths) {
    it(`redirige ${path} vers /login (jamais de contenu protégé rendu avant)`, async () => {
      const response = await fetchPage(path);
      expect([302, 307, 308]).toContain(response.status);
      const location = response.headers.get("location");
      expect(location).toContain("/login");
      expect(location).toContain("callbackUrl");
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Agences — /dashboard/agencies/[id], /dashboard/agencies/new
// ---------------------------------------------------------------------------------------------

describe("Agences — /dashboard/agencies/[id]", () => {
  it("autorisé (ADMIN) → 200, contenu complet", async () => {
    const tenant = await setupTenant("agview");
    const response = await fetchPage(`/dashboard/agencies/${tenant.agencyId}`, tenant.admin.sessionCookie);
    expect(response.status).toBe(200);
  });

  it("sans agencies.view → 404 (gate corrigé ce sprint)", async () => {
    const tenant = await setupTenant("agnoperm");
    const member = await createScopedMember(tenant, "agnoperm", ["clients.view"], [tenant.agencyId]);
    const response = await fetchPage(`/dashboard/agencies/${tenant.agencyId}`, member.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("agence d'un autre tenant → 404", async () => {
    const tenantA = await setupTenant("agisoA");
    const tenantB = await setupTenant("agisoB");
    const response = await fetchPage(`/dashboard/agencies/${tenantB.agencyId}`, tenantA.admin.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("agence non accessible (MEMBER sans UserAgency dessus) → 404", async () => {
    const tenant = await setupTenant("agnoaccess");
    const otherAgency = await createSecondAgency(tenant, "agnoaccess");
    const member = await createScopedMember(tenant, "agnoaccess", ["agencies.view"], [tenant.agencyId]);
    const response = await fetchPage(`/dashboard/agencies/${otherAgency.id}`, member.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("identifiant malformé → 404", async () => {
    const tenant = await setupTenant("agmalformed");
    const response = await fetchPage("/dashboard/agencies/%23%24%25-not-an-id", tenant.admin.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("identifiant inexistant → 404", async () => {
    const tenant = await setupTenant("agmissing");
    const response = await fetchPage("/dashboard/agencies/clxxxxxxxxxxxxxxxxxxxxxxxx", tenant.admin.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("/dashboard/agencies/new — sans agencies.create → 404, avec → 200", async () => {
    const tenant = await setupTenant("agnewperm");
    const member = await createScopedMember(tenant, "agnewperm", ["agencies.view"], [tenant.agencyId]);
    const denied = await fetchPage("/dashboard/agencies/new", member.sessionCookie);
    expect(denied.status).toBe(404);

    const allowed = await fetchPage("/dashboard/agencies/new", tenant.admin.sessionCookie);
    expect(allowed.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Clients — /dashboard/clients/[id], /dashboard/clients/new
// ---------------------------------------------------------------------------------------------

describe("Clients — /dashboard/clients/[id]", () => {
  it("autorisé (ADMIN) → 200", async () => {
    const tenant = await setupTenant("clview");
    const response = await fetchPage(`/dashboard/clients/${tenant.clientId}`, tenant.admin.sessionCookie);
    expect(response.status).toBe(200);
  });

  it("sans clients.view → 404 (gate corrigé ce sprint)", async () => {
    const tenant = await setupTenant("clnoperm");
    const member = await createScopedMember(tenant, "clnoperm", ["vehicles.view"], [tenant.agencyId]);
    const response = await fetchPage(`/dashboard/clients/${tenant.clientId}`, member.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("client d'un autre tenant → 404", async () => {
    const tenantA = await setupTenant("clisoA");
    const tenantB = await setupTenant("clisoB");
    const response = await fetchPage(`/dashboard/clients/${tenantB.clientId}`, tenantA.admin.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("identifiant malformé → 404", async () => {
    const tenant = await setupTenant("clmalformed");
    const response = await fetchPage("/dashboard/clients/!!!invalid!!!", tenant.admin.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("/dashboard/clients/new — sans clients.create → 404, avec → 200", async () => {
    const tenant = await setupTenant("clnewperm");
    const member = await createScopedMember(tenant, "clnewperm", ["clients.view"], [tenant.agencyId]);
    const denied = await fetchPage("/dashboard/clients/new", member.sessionCookie);
    expect(denied.status).toBe(404);
    const allowed = await fetchPage("/dashboard/clients/new", tenant.admin.sessionCookie);
    expect(allowed.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Véhicules — /dashboard/vehicles/[id], /dashboard/vehicles/new
// ---------------------------------------------------------------------------------------------

describe("Véhicules — /dashboard/vehicles/[id]", () => {
  it("autorisé (ADMIN) → 200", async () => {
    const tenant = await setupTenant("vhview");
    const vehicle = await createVehicle(tenant, "VHVIEW");
    const response = await fetchPage(`/dashboard/vehicles/${vehicle.id}`, tenant.admin.sessionCookie);
    expect(response.status).toBe(200);
  });

  it("sans vehicles.view → 404 (gate corrigé ce sprint)", async () => {
    const tenant = await setupTenant("vhnoperm");
    const vehicle = await createVehicle(tenant, "VHNOPERM");
    const member = await createScopedMember(tenant, "vhnoperm", ["clients.view"], [tenant.agencyId]);
    const response = await fetchPage(`/dashboard/vehicles/${vehicle.id}`, member.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("véhicule d'un autre tenant → 404", async () => {
    const tenantA = await setupTenant("vhisoA");
    const tenantB = await setupTenant("vhisoB");
    const vehicleB = await createVehicle(tenantB, "VHISOB");
    const response = await fetchPage(`/dashboard/vehicles/${vehicleB.id}`, tenantA.admin.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("véhicule d'une agence non accessible → 404", async () => {
    const tenant = await setupTenant("vhnoagency");
    const otherAgency = await createSecondAgency(tenant, "vhnoagency");
    const vehicle = await createVehicle(tenant, "VHNOAGENCY", otherAgency.id);
    const member = await createScopedMember(tenant, "vhnoagency", ["vehicles.view"], [tenant.agencyId]);
    const response = await fetchPage(`/dashboard/vehicles/${vehicle.id}`, member.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("identifiant inexistant → 404", async () => {
    const tenant = await setupTenant("vhmissing");
    const response = await fetchPage("/dashboard/vehicles/clxxxxxxxxxxxxxxxxxxxxxxxx", tenant.admin.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("/dashboard/vehicles/new — sans vehicles.create → 404, avec → 200", async () => {
    const tenant = await setupTenant("vhnewperm");
    const member = await createScopedMember(tenant, "vhnewperm", ["vehicles.view"], [tenant.agencyId]);
    const denied = await fetchPage("/dashboard/vehicles/new", member.sessionCookie);
    expect(denied.status).toBe(404);
    const allowed = await fetchPage("/dashboard/vehicles/new", tenant.admin.sessionCookie);
    expect(allowed.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Factures — /dashboard/invoices/[id], /dashboard/invoices/new
// ---------------------------------------------------------------------------------------------

describe("Factures — /dashboard/invoices/[id]", () => {
  it("autorisé (ADMIN) → 200", async () => {
    const tenant = await setupTenant("invview");
    const vehicle = await createVehicle(tenant, "INVVIEW");
    const location = await createAndActivateLocation(tenant, vehicle.id);
    const invoice = await createInvoiceForLocation(tenant, location.id);
    const response = await fetchPage(`/dashboard/invoices/${invoice.id}`, tenant.admin.sessionCookie);
    expect(response.status).toBe(200);
  });

  it("sans invoices.view → 404", async () => {
    const tenant = await setupTenant("invnoperm");
    const vehicle = await createVehicle(tenant, "INVNOPERM");
    const location = await createAndActivateLocation(tenant, vehicle.id);
    const invoice = await createInvoiceForLocation(tenant, location.id);
    const member = await createScopedMember(tenant, "invnoperm", ["clients.view"], [tenant.agencyId]);
    const response = await fetchPage(`/dashboard/invoices/${invoice.id}`, member.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("facture d'un autre tenant → 404", async () => {
    const tenantA = await setupTenant("invisoA");
    const tenantB = await setupTenant("invisoB");
    const vehicleB = await createVehicle(tenantB, "INVISOB");
    const locationB = await createAndActivateLocation(tenantB, vehicleB.id);
    const invoiceB = await createInvoiceForLocation(tenantB, locationB.id);
    const response = await fetchPage(`/dashboard/invoices/${invoiceB.id}`, tenantA.admin.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("facture d'une agence non accessible → 404", async () => {
    const tenant = await setupTenant("invnoagency");
    const otherAgency = await createSecondAgency(tenant, "invnoagency");
    const vehicle = await createVehicle(tenant, "INVNOAGENCY", otherAgency.id);
    const location = await createAndActivateLocation(tenant, vehicle.id);
    const invoice = await createInvoiceForLocation(tenant, location.id);
    const member = await createScopedMember(tenant, "invnoagency", ["invoices.view"], [tenant.agencyId]);
    const response = await fetchPage(`/dashboard/invoices/${invoice.id}`, member.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("/dashboard/invoices/new — sans invoices.create → 404, avec → 200", async () => {
    const tenant = await setupTenant("invnewperm");
    const member = await createScopedMember(tenant, "invnewperm", ["invoices.view"], [tenant.agencyId]);
    const denied = await fetchPage("/dashboard/invoices/new", member.sessionCookie);
    expect(denied.status).toBe(404);
    const allowed = await fetchPage("/dashboard/invoices/new", tenant.admin.sessionCookie);
    expect(allowed.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Factures de dégâts — /dashboard/damage-invoices/[id] (pas de route "new")
// ---------------------------------------------------------------------------------------------

describe("Factures de dégâts — /dashboard/damage-invoices/[id]", () => {
  it("autorisé (ADMIN) → 200", async () => {
    const tenant = await setupTenant("dmgview");
    const vehicle = await createVehicle(tenant, "DMGVIEW");
    const location = await createAndActivateLocation(tenant, vehicle.id);
    const damageInvoiceId = await createBilledDamageInvoice(tenant, location.id);
    const response = await fetchPage(`/dashboard/damage-invoices/${damageInvoiceId}`, tenant.admin.sessionCookie);
    expect(response.status).toBe(200);
  });

  it("sans damage_invoices.view → 404", async () => {
    const tenant = await setupTenant("dmgnoperm");
    const vehicle = await createVehicle(tenant, "DMGNOPERM");
    const location = await createAndActivateLocation(tenant, vehicle.id);
    const damageInvoiceId = await createBilledDamageInvoice(tenant, location.id);
    const member = await createScopedMember(tenant, "dmgnoperm", ["clients.view"], [tenant.agencyId]);
    const response = await fetchPage(`/dashboard/damage-invoices/${damageInvoiceId}`, member.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("facture de dégâts d'un autre tenant → 404", async () => {
    const tenantA = await setupTenant("dmgisoA");
    const tenantB = await setupTenant("dmgisoB");
    const vehicleB = await createVehicle(tenantB, "DMGISOB");
    const locationB = await createAndActivateLocation(tenantB, vehicleB.id);
    const damageInvoiceIdB = await createBilledDamageInvoice(tenantB, locationB.id);
    const response = await fetchPage(`/dashboard/damage-invoices/${damageInvoiceIdB}`, tenantA.admin.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("identifiant inexistant → 404", async () => {
    const tenant = await setupTenant("dmgmissing");
    const response = await fetchPage("/dashboard/damage-invoices/clxxxxxxxxxxxxxxxxxxxxxxxx", tenant.admin.sessionCookie);
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
// Locations — malformé/inexistant/nouveau (la matrice fonctionnelle complète est déjà couverte
// par src/__tests__/location-chain-balance.test.ts, non dupliquée ici)
// ---------------------------------------------------------------------------------------------

describe("Locations — /dashboard/locations/[id] et /return (complément à location-chain-balance.test.ts)", () => {
  it("identifiant malformé → 404", async () => {
    const tenant = await setupTenant("locmalformed");
    const response = await fetchPage("/dashboard/locations/%20%20%20", tenant.admin.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("location d'un autre tenant → 404 sur /return aussi", async () => {
    const tenantA = await setupTenant("locisoA");
    const tenantB = await setupTenant("locisoB");
    const vehicleB = await createVehicle(tenantB, "LOCISOB");
    const locationB = await createAndActivateLocation(tenantB, vehicleB.id);

    const detail = await fetchPage(`/dashboard/locations/${locationB.id}`, tenantA.admin.sessionCookie);
    expect(detail.status).toBe(404);
    const returnPage = await fetchPage(`/dashboard/locations/${locationB.id}/return`, tenantA.admin.sessionCookie);
    expect(returnPage.status).toBe(404);
  });

  it("/return sans locations.complete → 404, avec → 200", async () => {
    const tenant = await setupTenant("locreturnperm");
    const vehicle = await createVehicle(tenant, "LOCRETURNPERM");
    const location = await createAndActivateLocation(tenant, vehicle.id);
    const member = await createScopedMember(tenant, "locreturnperm", ["locations.view"], [tenant.agencyId]);

    const denied = await fetchPage(`/dashboard/locations/${location.id}/return`, member.sessionCookie);
    expect(denied.status).toBe(404);

    const allowed = await fetchPage(`/dashboard/locations/${location.id}/return`, tenant.admin.sessionCookie);
    expect(allowed.status).toBe(200);
  });

  it("/dashboard/locations/new n'est jamais intercepté par le garde [id] (pas de collision de motif)", async () => {
    const tenant = await setupTenant("locnewcollision");
    const member = await createScopedMember(tenant, "locnewcollision", ["locations.view"], [tenant.agencyId]);
    // locations.view seule (sans locations.create) : la page /new doit être refusée par SON
    // PROPRE motif (locations.create), jamais confondue avec le motif locations/[id].
    const denied = await fetchPage("/dashboard/locations/new", member.sessionCookie);
    expect(denied.status).toBe(404);

    const memberWithCreate = await createScopedMember(
      tenant,
      "locnewcollision2",
      ["locations.create"],
      [tenant.agencyId]
    );
    const allowed = await fetchPage("/dashboard/locations/new", memberWithCreate.sessionCookie);
    expect(allowed.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Réservations — /dashboard/reservations/[id], /convert, /edit, /new, /import
// ---------------------------------------------------------------------------------------------

describe("Réservations — /dashboard/reservations/[id], /convert, /edit", () => {
  it("autorisé (ADMIN) → 200 sur les trois routes", async () => {
    const tenant = await setupTenant("resview");
    const reservation = await createReservation(tenant);
    const detail = await fetchPage(`/dashboard/reservations/${reservation.id}`, tenant.admin.sessionCookie);
    expect(detail.status).toBe(200);
    const edit = await fetchPage(`/dashboard/reservations/${reservation.id}/edit`, tenant.admin.sessionCookie);
    expect(edit.status).toBe(200);
    const convert = await fetchPage(`/dashboard/reservations/${reservation.id}/convert`, tenant.admin.sessionCookie);
    expect(convert.status).toBe(200);
  });

  it("sans reservations.view/edit/convert respectivement → 404", async () => {
    const tenant = await setupTenant("resnoperm");
    const reservation = await createReservation(tenant);
    const member = await createScopedMember(tenant, "resnoperm", ["clients.view"], [tenant.agencyId]);
    expect((await fetchPage(`/dashboard/reservations/${reservation.id}`, member.sessionCookie)).status).toBe(404);
    expect((await fetchPage(`/dashboard/reservations/${reservation.id}/edit`, member.sessionCookie)).status).toBe(404);
    expect((await fetchPage(`/dashboard/reservations/${reservation.id}/convert`, member.sessionCookie)).status).toBe(
      404
    );
  });

  it("réservation d'un autre tenant → 404 sur les trois routes", async () => {
    const tenantA = await setupTenant("resisoA");
    const tenantB = await setupTenant("resisoB");
    const reservationB = await createReservation(tenantB);
    expect((await fetchPage(`/dashboard/reservations/${reservationB.id}`, tenantA.admin.sessionCookie)).status).toBe(
      404
    );
    expect(
      (await fetchPage(`/dashboard/reservations/${reservationB.id}/edit`, tenantA.admin.sessionCookie)).status
    ).toBe(404);
    expect(
      (await fetchPage(`/dashboard/reservations/${reservationB.id}/convert`, tenantA.admin.sessionCookie)).status
    ).toBe(404);
  });

  it("réservation résolue vers une agence non accessible → 404", async () => {
    const tenant = await setupTenant("resnoagency");
    const otherAgency = await createSecondAgency(tenant, "resnoagency");
    // pickupAgency en texte libre résolu côté serveur vers une Agency réelle si le texte
    // correspond (voir src/lib/reservations.ts, buildAgencyLookupMap) — on utilise le nom de
    // l'agence B pour forcer cette résolution.
    const reservation = await createReservation(tenant, { pickupAgency: otherAgency.name });
    const member = await createScopedMember(tenant, "resnoagency", ["reservations.view"], [tenant.agencyId]);
    const response = await fetchPage(`/dashboard/reservations/${reservation.id}`, member.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("identifiant inexistant → 404 sur les trois routes", async () => {
    const tenant = await setupTenant("resmissing");
    const missing = "clxxxxxxxxxxxxxxxxxxxxxxxx";
    expect((await fetchPage(`/dashboard/reservations/${missing}`, tenant.admin.sessionCookie)).status).toBe(404);
    expect((await fetchPage(`/dashboard/reservations/${missing}/edit`, tenant.admin.sessionCookie)).status).toBe(404);
    expect((await fetchPage(`/dashboard/reservations/${missing}/convert`, tenant.admin.sessionCookie)).status).toBe(
      404
    );
  });
});

describe("Réservations — /dashboard/reservations/new et /import", () => {
  it("/new — sans reservations.create → 404 (gate ajouté ce sprint, page auparavant sans aucune garde serveur)", async () => {
    const tenant = await setupTenant("resnewperm");
    const member = await createScopedMember(tenant, "resnewperm", ["reservations.view"], [tenant.agencyId]);
    const denied = await fetchPage("/dashboard/reservations/new", member.sessionCookie);
    expect(denied.status).toBe(404);
    const allowed = await fetchPage("/dashboard/reservations/new", tenant.admin.sessionCookie);
    expect(allowed.status).toBe(200);
  });

  it("/import — sans reservations.import → 404, avec → 200", async () => {
    const tenant = await setupTenant("resimportperm");
    const member = await createScopedMember(tenant, "resimportperm", ["reservations.view"], [tenant.agencyId]);
    const denied = await fetchPage("/dashboard/reservations/import", member.sessionCookie);
    expect(denied.status).toBe(404);
    const allowed = await fetchPage("/dashboard/reservations/import", tenant.admin.sessionCookie);
    expect(allowed.status).toBe(200);
  });

  it("/new et /import ne sont jamais interceptés par le garde [id] (pas de collision de motif)", async () => {
    const tenant = await setupTenant("resnewcollision");
    // Un ADMIN a toujours accès — le test pertinent est que ces deux chemins produisent bien
    // 200 (page réellement servie), pas un 404 accidentel du garde [id] qui les confondrait
    // avec un identifiant littéral "new"/"import".
    expect((await fetchPage("/dashboard/reservations/new", tenant.admin.sessionCookie)).status).toBe(200);
    expect((await fetchPage("/dashboard/reservations/import", tenant.admin.sessionCookie)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Groupes de permissions — ADMIN uniquement, redirection réelle (jamais un 404)
// ---------------------------------------------------------------------------------------------

describe("Groupes de permissions — /dashboard/permission-groups/[id] (ADMIN-only, redirect)", () => {
  it("ADMIN autorisé → 200", async () => {
    const tenant = await setupTenant("pgview");
    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ name: `PG-view-${runId}`, permissions: ["clients.view"] }),
    });
    const groupId = (await groupResponse.json()).group.id;
    const response = await fetchPage(`/dashboard/permission-groups/${groupId}`, tenant.admin.sessionCookie);
    expect(response.status).toBe(200);
  });

  it("MEMBER (non ADMIN) → vraie redirection HTTP vers /dashboard, jamais de contenu rendu, jamais un 404", async () => {
    const tenant = await setupTenant("pgmember");
    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: tenant.admin.sessionCookie },
      body: JSON.stringify({ name: `PG-member-${runId}`, permissions: ["clients.view"] }),
    });
    const groupId = (await groupResponse.json()).group.id;
    const member = await createScopedMember(tenant, "pgmember", ["clients.view"], [tenant.agencyId]);

    const response = await fetchPage(`/dashboard/permission-groups/${groupId}`, member.sessionCookie);
    expect([302, 307, 308]).toContain(response.status);
    expect(response.headers.get("location")).toContain("/dashboard");
    const body = await response.text();
    // Aucun contenu du groupe (nom, permissions) ne doit apparaître dans le corps de la
    // redirection elle-même.
    expect(body).not.toContain(`PG-member-${runId}`);
  });

  it("groupe d'un autre tenant (ADMIN) → 404, jamais révélé", async () => {
    const tenantA = await setupTenant("pgisoA");
    const tenantB = await setupTenant("pgisoB");
    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: tenantB.admin.sessionCookie },
      body: JSON.stringify({ name: `PG-isoB-${runId}`, permissions: ["clients.view"] }),
    });
    const groupIdB = (await groupResponse.json()).group.id;
    const response = await fetchPage(`/dashboard/permission-groups/${groupIdB}`, tenantA.admin.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("identifiant inexistant (ADMIN) → 404", async () => {
    const tenant = await setupTenant("pgmissing");
    const response = await fetchPage(
      "/dashboard/permission-groups/clxxxxxxxxxxxxxxxxxxxxxxxx",
      tenant.admin.sessionCookie
    );
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
// Tenants — /dashboard/tenants/[id] (jamais un autre tenant, même pour un ADMIN)
// ---------------------------------------------------------------------------------------------

describe("Tenants — /dashboard/tenants/[id]", () => {
  it("propre tenant → 200", async () => {
    const tenant = await setupTenant("tnview");
    const response = await fetchPage(`/dashboard/tenants/${tenant.admin.tenantId}`, tenant.admin.sessionCookie);
    expect(response.status).toBe(200);
  });

  it("autre tenant (même ADMIN) → 404, jamais 200", async () => {
    const tenantA = await setupTenant("tnisoA");
    const tenantB = await setupTenant("tnisoB");
    const response = await fetchPage(`/dashboard/tenants/${tenantB.admin.tenantId}`, tenantA.admin.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("identifiant malformé → 404", async () => {
    const tenant = await setupTenant("tnmalformed");
    const response = await fetchPage("/dashboard/tenants/not-a-real-tenant-id", tenant.admin.sessionCookie);
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
// Utilisateurs — /dashboard/users/[id] (block) et /permissions (redirect) — ADMIN uniquement
// ---------------------------------------------------------------------------------------------

describe("Utilisateurs — /dashboard/users/[id] et /permissions (ADMIN-only)", () => {
  it("ADMIN autorisé → 200 sur les deux routes", async () => {
    const tenant = await setupTenant("usview");
    const member = await createAndLoginMember({
      tenantId: tenant.admin.tenantId,
      name: "Cible",
      email: `usview-target-${runId}@test.local`,
      password,
    });
    const detail = await fetchPage(`/dashboard/users/${member.userId}`, tenant.admin.sessionCookie);
    expect(detail.status).toBe(200);
    const permissions = await fetchPage(`/dashboard/users/${member.userId}/permissions`, tenant.admin.sessionCookie);
    expect(permissions.status).toBe(200);
  });

  it("MEMBER sur /dashboard/users/[id] → 404 (comportement existant de la page : notFound(), pas redirect)", async () => {
    const tenant = await setupTenant("usmember1");
    const target = await createAndLoginMember({
      tenantId: tenant.admin.tenantId,
      name: "Cible",
      email: `usmember1-target-${runId}@test.local`,
      password,
    });
    const requester = await createAndLoginMember({
      tenantId: tenant.admin.tenantId,
      name: "Demandeur",
      email: `usmember1-req-${runId}@test.local`,
      password,
    });
    const response = await fetchPage(`/dashboard/users/${target.userId}`, requester.sessionCookie);
    expect(response.status).toBe(404);
  });

  it("MEMBER sur /dashboard/users/[id]/permissions → vraie redirection HTTP vers /dashboard (comportement existant de la page : redirect(), pas notFound())", async () => {
    const tenant = await setupTenant("usmember2");
    const target = await createAndLoginMember({
      tenantId: tenant.admin.tenantId,
      name: "Cible",
      email: `usmember2-target-${runId}@test.local`,
      password,
    });
    const requester = await createAndLoginMember({
      tenantId: tenant.admin.tenantId,
      name: "Demandeur",
      email: `usmember2-req-${runId}@test.local`,
      password,
    });
    const response = await fetchPage(`/dashboard/users/${target.userId}/permissions`, requester.sessionCookie);
    expect([302, 307, 308]).toContain(response.status);
    expect(response.headers.get("location")).toContain("/dashboard");
  });

  it("utilisateur d'un autre tenant (ADMIN) → 404 sur les deux routes", async () => {
    const tenantA = await setupTenant("usisoA");
    const tenantB = await setupTenant("usisoB");
    const targetB = await createAndLoginMember({
      tenantId: tenantB.admin.tenantId,
      name: "Cible B",
      email: `usisoB-target-${runId}@test.local`,
      password,
    });
    expect((await fetchPage(`/dashboard/users/${targetB.userId}`, tenantA.admin.sessionCookie)).status).toBe(404);
    expect(
      (await fetchPage(`/dashboard/users/${targetB.userId}/permissions`, tenantA.admin.sessionCookie)).status
    ).toBe(404);
  });

  it("identifiant inexistant (ADMIN) → 404 sur les deux routes", async () => {
    const tenant = await setupTenant("usmissing");
    const missing = "clxxxxxxxxxxxxxxxxxxxxxxxx";
    expect((await fetchPage(`/dashboard/users/${missing}`, tenant.admin.sessionCookie)).status).toBe(404);
    expect((await fetchPage(`/dashboard/users/${missing}/permissions`, tenant.admin.sessionCookie)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
// Pages de création restantes (maintenances, vehicle-transfers, vehicle-trips)
// ---------------------------------------------------------------------------------------------

describe("Pages de création restantes — maintenances, vehicle-transfers, vehicle-trips", () => {
  it("maintenances/new — sans maintenances.create → 404, avec → 200", async () => {
    const tenant = await setupTenant("mtnewperm");
    const member = await createScopedMember(tenant, "mtnewperm", ["clients.view"], [tenant.agencyId]);
    expect((await fetchPage("/dashboard/maintenances/new", member.sessionCookie)).status).toBe(404);
    expect((await fetchPage("/dashboard/maintenances/new", tenant.admin.sessionCookie)).status).toBe(200);
  });

  it("vehicle-transfers/new — sans vehicle_transfers.create → 404, avec → 200", async () => {
    const tenant = await setupTenant("vtnewperm");
    const member = await createScopedMember(tenant, "vtnewperm", ["clients.view"], [tenant.agencyId]);
    expect((await fetchPage("/dashboard/vehicle-transfers/new", member.sessionCookie)).status).toBe(404);
    expect((await fetchPage("/dashboard/vehicle-transfers/new", tenant.admin.sessionCookie)).status).toBe(200);
  });

  it("vehicle-trips/new — sans vehicle_trips.create → 404, avec → 200", async () => {
    const tenant = await setupTenant("vpnewperm");
    const member = await createScopedMember(tenant, "vpnewperm", ["clients.view"], [tenant.agencyId]);
    expect((await fetchPage("/dashboard/vehicle-trips/new", member.sessionCookie)).status).toBe(404);
    expect((await fetchPage("/dashboard/vehicle-trips/new", tenant.admin.sessionCookie)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Régression — pages liste et routes hors registre restent inchangées (200 normal)
// ---------------------------------------------------------------------------------------------

describe("Régression — routes non couvertes par le registre restent inchangées", () => {
  it("les pages liste restent 200 (jamais interceptées par un motif [id])", async () => {
    const tenant = await setupTenant("listregression");
    const paths = [
      "/dashboard/agencies",
      "/dashboard/clients",
      "/dashboard/vehicles",
      "/dashboard/locations",
      "/dashboard/reservations",
      "/dashboard/invoices",
      "/dashboard/damage-invoices",
      "/dashboard/permission-groups",
      "/dashboard/tenants",
      "/dashboard/users",
    ];
    for (const path of paths) {
      const response = await fetchPage(path, tenant.admin.sessionCookie);
      expect(response.status).toBe(200);
    }
  });

  it("une route API n'est jamais affectée par le garde dashboard (déjà un vrai statut avant ce sprint)", async () => {
    const tenant = await setupTenant("apiregression");
    const response = await apiFetch("/api/locations/clxxxxxxxxxxxxxxxxxxxxxxxx", {
      headers: { Cookie: tenant.admin.sessionCookie },
    });
    expect(response.status).toBe(404);
  });
});
