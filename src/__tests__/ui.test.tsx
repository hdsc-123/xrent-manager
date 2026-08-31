import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

/**
 * Tests d'intégration HTTP sur le rendu des pages UI (Sprint 4), dans la continuité
 * de auth.test.ts/tenants.test.ts/agencies.test.ts : un vrai serveur `next dev` de
 * test est déjà démarré par vitest.global-setup.ts (requis par NextAuth). Pas de
 * jsdom/@testing-library ici pour rester cohérent avec cette approche existante
 * plutôt que d'introduire un second paradigme de test.
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let admin: AuthenticatedTestUser;
let member: AuthenticatedTestUser;

beforeAll(async () => {
  admin = await registerTenantAdmin({
    tenantName: "UI Test Tenant",
    tenantSlug: `ui-test-tenant-${runId}`,
    name: "UI Admin",
    email: `ui-admin-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(admin.tenantId);

  member = await createAndLoginMember({
    tenantId: admin.tenantId,
    name: "UI Member",
    email: `ui-member-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
});

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
  await prisma.$disconnect();
});

describe("Pages d'authentification", () => {
  it("GET /login est accessible sans authentification, rend le formulaire de connexion et n'affiche aucune inscription publique permettant de créer un tenant", async () => {
    const response = await apiFetch("/login");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    // 2026-08-29 : suppression du parcours d'inscription publique (DOMAINRULES.md — création
    // de tenant réservée au Super Admin plateforme). Ni lien vers /register, ni formulaire de
    // création de tenant (tenantName) ne doivent plus apparaître sur la page de connexion.
    expect(html).not.toContain("/register");
    expect(html).not.toContain('name="tenantName"');
  });

  it("GET /register n'existe plus (404) — la création de tenant n'est plus un parcours public", async () => {
    const response = await apiFetch("/register");
    expect(response.status).toBe(404);
  });

  it("POST /api/auth/register n'existe plus — aucun visiteur non authentifié ne peut créer de tenant", async () => {
    // Aucune route dédiée sous src/app/api/auth/register/ : le chemin retombe sur le
    // catch-all NextAuth (src/app/api/auth/[...nextauth]/route.ts, qui intercepte tout
    // /api/auth/* non explicitement routé ailleurs) — 400 "UnknownAction", jamais 201, et
    // surtout aucun tenant/utilisateur n'est créé (vérifié ci-dessous).
    const tenantSlug = "should-not-exist-anymore";
    const response = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        tenantName: "Should Not Exist",
        tenantSlug,
        name: "Nobody",
        email: "nobody-register-gone@test.local",
        password: "Correct-Horse-Battery-Staple9!",
      }),
    });
    expect(response.status).not.toBe(201);
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    expect(tenant).toBeNull();
  });
});

describe("Protection des pages /dashboard", () => {
  it("redirige vers /login si non authentifié", async () => {
    const response = await apiFetch("/dashboard", { redirect: "manual" });
    expect([307, 308]).toContain(response.status);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("rend le tableau de bord pour un utilisateur authentifié", async () => {
    const response = await apiFetch("/dashboard", {
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("UI Test Tenant");
  });
});

describe("Page /dashboard/users (lecture seule)", () => {
  it("rend la liste des utilisateurs pour un ADMIN", async () => {
    const response = await apiFetch("/dashboard/users", {
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("UI Admin");
    expect(html).toContain("UI Member");
  });

  it("refuse un MEMBER avec le message explicite « réservée aux administrateurs » (pas d'accès à l'annuaire)", async () => {
    // Correctif UX (sprint stabilisation) : cette page redirigeait auparavant
    // silencieusement vers /dashboard (redirect()) — désormais alignée sur le même
    // patron que /dashboard/permissions, /dashboard/audit et /dashboard/administration
    // (message explicite rendu directement, vraie garde serveur, aucune donnée chargée).
    const response = await apiFetch("/dashboard/users", {
      headers: { Cookie: member.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("réservée aux administrateurs");
    // "UI Member" (le nom du demandeur lui-même) apparaît légitimement dans l'en-tête de la
    // page (menu utilisateur) quelle que soit la page — seule l'absence de "UI Admin" (donnée
    // d'un AUTRE utilisateur, jamais la sienne) prouve l'absence de fuite de l'annuaire.
    expect(html).not.toContain("UI Admin");
  });

  it("distingue le rôle système (ADMIN/MEMBER) du groupe de permissions réel — jamais le second déduit du premier (correctif bug d'affichage)", async () => {
    const groupsResponse = await apiFetch("/api/permission-groups", { headers: { Cookie: admin.sessionCookie } });
    const groups: { id: string; name: string }[] = (await groupsResponse.json()).groups;
    const agenceGroupId = groups.find((g) => g.name === "AGENCE")!.id;
    const comptaGroupId = groups.find((g) => g.name === "COMPTABILITÉ")!.id;

    const customGroupName = `UI Custom Group ${runId}`;
    const customGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: customGroupName, permissions: ["vehicles.view"] }),
    });
    const customGroupId = (await customGroupResponse.json()).group.id;

    const agenceMember = await createAndLoginMember({
      tenantId: admin.tenantId,
      name: "UI Table Agence",
      email: `ui-table-agence-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    const comptaMember = await createAndLoginMember({
      tenantId: admin.tenantId,
      name: "UI Table Compta",
      email: `ui-table-compta-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    const customMember = await createAndLoginMember({
      tenantId: admin.tenantId,
      name: "UI Table Custom",
      email: `ui-table-custom-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });

    await apiFetch(`/api/users/${agenceMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ permissionGroupId: agenceGroupId }),
    });
    await apiFetch(`/api/users/${comptaMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ permissionGroupId: comptaGroupId }),
    });
    await apiFetch(`/api/users/${customMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ permissionGroupId: customGroupId }),
    });

    const response = await apiFetch("/dashboard/users", { headers: { Cookie: admin.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();

    // Rôle système : ADMIN -> "Administrateur", MEMBER -> "Utilisateur" (jamais "Membre",
    // qui prêtait à confusion avec le nom du groupe par défaut "MEMBER").
    expect(html).toContain("Administrateur");
    expect(html).toContain("Utilisateur");

    // Groupe de permissions affiché distinctement pour chaque utilisateur, jamais déduit du
    // rôle système — trois groupes différents doivent apparaître littéralement.
    expect(html).toContain("AGENCE");
    expect(html).toContain("COMPTABILITÉ");
    expect(html).toContain(customGroupName);
    // `member` (fixture du beforeAll) n'a jamais reçu de groupe assigné dans ce fichier.
    expect(html).toContain("Aucun groupe");
    // L'ADMIN contourne toujours can() (src/lib/permissions.ts) quel que soit son
    // permissionGroupId (toujours `null` en pratique) — jamais confondu avec "Aucun groupe".
    expect(html).toContain("Contournement ADMIN");

    // Le groupe affiché ne modifie pas les permissions effectives : COMPTABILITÉ reste
    // scopée finance/reporting (pas d'accès véhicules), exactement comme avant ce correctif
    // purement visuel — comportement inchangé, vérifié au niveau de l'API réelle.
    const comptaVehicles = await apiFetch("/api/vehicles", { headers: { Cookie: comptaMember.sessionCookie } });
    expect(comptaVehicles.status).toBe(403);
    const comptaInvoices = await apiFetch("/api/invoices", { headers: { Cookie: comptaMember.sessionCookie } });
    expect(comptaInvoices.status).toBe(200);
  });
});

describe("Sprint 18 — dashboard : alertes non gatées par alerts.view", () => {
  it("masque la carte « Alertes récentes » et le badge du header à un MEMBER sans alerts.view (COMPTABILITÉ)", async () => {
    const alertMessage = `Alerte confidentielle ${runId}`;
    await prisma.alert.create({
      data: {
        tenantId: admin.tenantId,
        type: "OTHER",
        priority: "URGENT",
        message: alertMessage,
      },
    });

    const groupsResponse = await apiFetch("/api/permission-groups", { headers: { Cookie: admin.sessionCookie } });
    const comptaGroupId = (await groupsResponse.json()).groups.find(
      (g: { name: string }) => g.name === "COMPTABILITÉ"
    ).id;

    const comptaMember = await createAndLoginMember({
      tenantId: admin.tenantId,
      name: "UI Compta",
      email: `ui-compta-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await apiFetch(`/api/users/${comptaMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ permissionGroupId: comptaGroupId }),
    });

    // Un ADMIN (alerts.view implicite) voit bien l'alerte — confirme que le test la trouverait
    // si elle n'était pas gatée.
    const adminResponse = await apiFetch("/dashboard", { headers: { Cookie: admin.sessionCookie } });
    const adminHtml = await adminResponse.text();
    expect(adminHtml).toContain(alertMessage);

    const comptaResponse = await apiFetch("/dashboard", { headers: { Cookie: comptaMember.sessionCookie } });
    const comptaHtml = await comptaResponse.text();
    expect(comptaHtml).not.toContain(alertMessage);
    expect(comptaHtml).not.toContain("Alertes récentes");
  });
});

describe("Sprint 18 — /dashboard/reports : lien mort pour un MEMBER malgré reports.view accordé par défaut", () => {
  it("rend la page Rapports (pas le mur « réservée aux administrateurs ») pour un MEMBER par défaut", async () => {
    const response = await apiFetch("/dashboard/reports", { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("réservée aux administrateurs");
    expect(html).toContain("Rapports");
  });
});

describe("Sprint 18 — /dashboard/reservations/import : garde serveur + reservations.import pour MEMBER", () => {
  it("rend le formulaire pour un MEMBER par défaut (reservations.import désormais accordé)", async () => {
    const response = await apiFetch("/dashboard/reservations/import", { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Importer des réservations (Excel)");
  });

  it("404 pour un rôle sans reservations.import (COMPTABILITÉ), même par accès direct à l'URL", async () => {
    const groupsResponse = await apiFetch("/api/permission-groups", { headers: { Cookie: admin.sessionCookie } });
    const comptaGroupId = (await groupsResponse.json()).groups.find(
      (g: { name: string }) => g.name === "COMPTABILITÉ"
    ).id;

    const comptaMember = await createAndLoginMember({
      tenantId: admin.tenantId,
      name: "UI Compta Import",
      email: `ui-compta-import-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await apiFetch(`/api/users/${comptaMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ permissionGroupId: comptaGroupId }),
    });

    const response = await apiFetch("/dashboard/reservations/import", {
      headers: { Cookie: comptaMember.sessionCookie },
    });
    // Correctif sprint soft 404 (2026-08-24) : /dashboard/reservations/import est désormais
    // couverte par le garde de route centralisé (src/lib/route-guards.ts, exécuté depuis
    // src/proxy.ts avant toute frontière Suspense) — vrai statut HTTP 404, plus un "soft 404"
    // (200 + noindex). Voir SECURITY.md section 35 et DOMAINRULES.md section 64.
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).not.toContain("Importer des réservations (Excel)");
  });
});

describe("Sprint 18 — /dashboard/tenants/[id] : formulaire d'édition masqué pour un non-ADMIN", () => {
  it("n'affiche pas le formulaire d'édition à un MEMBER (PATCH réservé ADMIN)", async () => {
    const response = await apiFetch(`/dashboard/tenants/${admin.tenantId}`, {
      headers: { Cookie: member.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("Modifier le tenant");
  });

  it("affiche le formulaire d'édition à un ADMIN", async () => {
    const response = await apiFetch(`/dashboard/tenants/${admin.tenantId}`, {
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Modifier le tenant");
  });
});

describe("Sprint 18 — /dashboard/permission-groups/[id] : avertissement sur le groupe ADMIN décoratif", () => {
  it("affiche un avertissement sur la page du groupe ADMIN (sans effet réel sur le rôle ADMIN)", async () => {
    const groupsResponse = await apiFetch("/api/permission-groups", { headers: { Cookie: admin.sessionCookie } });
    const adminGroupId = (await groupsResponse.json()).groups.find((g: { name: string }) => g.name === "ADMIN").id;

    const response = await apiFetch(`/dashboard/permission-groups/${adminGroupId}`, {
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("affiché pour référence uniquement");
  });
});

describe("GET /api/users", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/users");
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER", async () => {
    const response = await apiFetch("/api/users", {
      headers: { Cookie: member.sessionCookie },
    });
    expect(response.status).toBe(403);
  });

  it("liste les utilisateurs du tenant pour un ADMIN, sans passwordHash", async () => {
    const response = await apiFetch("/api/users", {
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    const emails: string[] = body.users.map((u: { email: string }) => u.email);
    expect(emails).toContain(admin.email);
    expect(emails).toContain(member.email);
    for (const user of body.users) {
      expect(user).not.toHaveProperty("passwordHash");
    }
  });

  it("expose permissionGroupName (nom réel du groupe, jamais déduit de role), null si aucun groupe assigné", async () => {
    const groupsResponse = await apiFetch("/api/permission-groups", { headers: { Cookie: admin.sessionCookie } });
    const groups: { id: string; name: string }[] = (await groupsResponse.json()).groups;
    const agenceGroupId = groups.find((g) => g.name === "AGENCE")!.id;

    const agenceMember = await createAndLoginMember({
      tenantId: admin.tenantId,
      name: "UI Agence GroupCheck",
      email: `ui-agence-groupcheck-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await apiFetch(`/api/users/${agenceMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ permissionGroupId: agenceGroupId }),
    });

    const response = await apiFetch("/api/users", { headers: { Cookie: admin.sessionCookie } });
    const body = await response.json();
    const byEmail = Object.fromEntries(
      body.users.map((u: { email: string; role: string; permissionGroupName: string | null }) => [u.email, u])
    );

    expect(byEmail[admin.email].role).toBe("ADMIN");
    expect(byEmail[member.email].role).toBe("MEMBER");
    // `member` (fixture du beforeAll) n'a jamais reçu de groupe assigné dans ce fichier.
    expect(byEmail[member.email].permissionGroupName).toBeNull();
    expect(byEmail[agenceMember.email].role).toBe("MEMBER");
    expect(byEmail[agenceMember.email].permissionGroupName).toBe("AGENCE");
  });
});

describe("Sprint 23 — nouveaux onglets Contrats/Performance véhicules, gated par permission (DOMAINRULES.md section 39)", () => {
  it("/dashboard/contracts rend la page pour un MEMBER par défaut (contracts_overview.view accordée)", async () => {
    const response = await apiFetch("/dashboard/contracts", { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("permission de consulter");
    expect(html).toContain("Contrats");
  });

  it("/dashboard/contracts : champ de recherche par numéro de contrat présent, combinable avec le filtre Statut, valeur trop longue signalée", async () => {
    const noSearch = await apiFetch("/dashboard/contracts", { headers: { Cookie: member.sessionCookie } });
    const noSearchHtml = await noSearch.text();
    expect(noSearchHtml).toContain('name="contractNumber"');
    expect(noSearchHtml).toContain("N° de contrat");

    // Combinaison avec Statut : les deux paramètres cohabitent dans la même URL (formulaire
    // GET natif, même patron déjà en place pour Statut seul) sans erreur serveur.
    const combined = await apiFetch("/dashboard/contracts?contractNumber=00001&status=PENDING", {
      headers: { Cookie: member.sessionCookie },
    });
    expect(combined.status).toBe(200);
    const combinedHtml = await combined.text();
    expect(combinedHtml).toContain('value="00001"');

    // Valeur trop longue (> 50 caractères) : signalée, jamais transmise telle quelle à la
    // requête (voir MAX_CONTRACT_NUMBER_SEARCH_LENGTH, page.tsx).
    const tooLong = await apiFetch(`/dashboard/contracts?contractNumber=${"X".repeat(60)}`, {
      headers: { Cookie: member.sessionCookie },
    });
    expect(tooLong.status).toBe(200);
    const tooLongHtml = await tooLong.text();
    expect(tooLongHtml).toContain("caractères maximum");
  });

  it("/dashboard/vehicle-performance rend la page pour un MEMBER par défaut (vehicle_performance.view accordée)", async () => {
    const response = await apiFetch("/dashboard/vehicle-performance", { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("permission de consulter");
    expect(html).toContain("Performance véhicules");
  });

  it("/dashboard/contracts refuse un MEMBER dont le groupe personnalisé n'a pas contracts_overview.view", async () => {
    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: `NoContractsOverview-${runId}`, permissions: ["reservations.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: admin.tenantId,
      name: "UI Restricted Contracts",
      email: `ui-restricted-contracts-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const response = await apiFetch("/dashboard/contracts", { headers: { Cookie: restrictedMember.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("permission de consulter");
  });
});

describe("Sprint 23 — /dashboard/administration : vue par ville/agence, réservée ADMIN (DOMAINRULES.md section 39)", () => {
  it("refuse un MEMBER (message « réservée aux administrateurs »)", async () => {
    const response = await apiFetch("/dashboard/administration", { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("réservée aux administrateurs");
  });

  it("rend la page pour un ADMIN, avec le sélecteur de station", async () => {
    const response = await apiFetch("/dashboard/administration", { headers: { Cookie: admin.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("réservée aux administrateurs");
    expect(html).toContain("Administration");
    expect(html).toContain("Choisir une station");
  });
});

/**
 * Sprint 30 (point 6b, Sprint B — DOMAINRULES.md) : filtres Agence/Date de retour de
 * VehicleStatusOverviewTable — composant Client Component filtré en mémoire (pas d'appel réseau
 * séparé), donc non testable via une requête HTTP dédiée comme les filtres Sprint A. Seul ce qui
 * est réellement vérifiable par ce paradigme de test (rendu SSR initial, pas d'exécution JS
 * côté client — voir le commentaire en tête de fichier) est couvert ici : présence des contrôles
 * dans le HTML rendu, et surtout la contrainte de sécurité réelle — la liste d'agences proposée
 * dans le filtre est strictement limitée aux agences accessibles à l'appelant, jamais dérivée
 * des seules lignes déjà chargées. Le comportement interactif du filtrage lui-même (combinaison
 * agence + période, bascule "Sans date de retour") reste hors de portée de ce paradigme de test
 * (aucun outil d'automatisation navigateur disponible en session, voir HANDOFF.md) — non testé
 * automatiquement, à vérifier manuellement si une session avec navigateur devient disponible.
 */
describe("Sprint 30 — /dashboard/maintenances : filtres Agence et Date de retour de VehicleStatusOverviewTable (point 6b, Sprint B)", () => {
  it("rend les contrôles de filtre (Agence, Date de retour du/au, Sans date de retour) en plus des filtres existants (recherche/état/disponibilité)", async () => {
    const response = await apiFetch("/dashboard/maintenances", { headers: { Cookie: admin.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("État des véhicules");
    expect(html).toContain("Agence");
    expect(html).toContain("Date de retour");
    expect(html).toContain("Sans date de retour");
    // Filtres préexistants (recherche/état/disponibilité) toujours présents, non régressés.
    expect(html).toContain("Rechercher...");
    expect(html).toContain("Disponibilité");
  });

  it("le filtre Agence ne propose que les agences accessibles à l'appelant, jamais dérivées des seules lignes déjà chargées", async () => {
    const agencyOneResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: `Agence Filtre Un ${runId}`, slug: `agence-filtre-un-${runId}` }),
    });
    const agencyOneId = (await agencyOneResponse.json()).agency.id;

    await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: `Agence Filtre Deux ${runId}`, slug: `agence-filtre-deux-${runId}` }),
    });

    // Un ADMIN voit toutes les agences du tenant dans le filtre, y compris une agence sans
    // aucun véhicule visible (la liste n'est jamais dérivée des lignes déjà chargées).
    const adminResponse = await apiFetch("/dashboard/maintenances", { headers: { Cookie: admin.sessionCookie } });
    const adminHtml = await adminResponse.text();
    expect(adminHtml).toContain(`Agence Filtre Un ${runId}`);
    expect(adminHtml).toContain(`Agence Filtre Deux ${runId}`);

    // Un MEMBER rattaché uniquement à la première agence ne doit voir que celle-ci dans le
    // filtre — jamais la seconde, même en lecture seule dans un <select>.
    const restrictedMember = await createAndLoginMember({
      tenantId: admin.tenantId,
      name: "UI Maintenance Filtre Agence",
      email: `ui-maintenance-filtre-agence-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: restrictedMember.userId, agencyId: agencyOneId } });

    const memberResponse = await apiFetch("/dashboard/maintenances", {
      headers: { Cookie: restrictedMember.sessionCookie },
    });
    expect(memberResponse.status).toBe(200);
    const memberHtml = await memberResponse.text();
    expect(memberHtml).toContain(`Agence Filtre Un ${runId}`);
    expect(memberHtml).not.toContain(`Agence Filtre Deux ${runId}`);
  });
});
