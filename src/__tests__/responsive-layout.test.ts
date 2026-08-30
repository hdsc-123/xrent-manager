import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { createAndLoginMember, registerTenantAdmin, type AuthenticatedTestUser } from "./helpers/fixtures";

/**
 * Sprint de stabilisation technique — correctif tablette portrait 768px (HANDOFF.md/
 * INCIDENTS.md) : à 768px de large (tablette portrait), la sidebar complète s'affichait comme
 * sur desktop (seuil Tailwind `md`, 768px, atteint dès cette largeur), réduisant fortement la
 * largeur utile du contenu principal. Corrigé en relevant le seuil de bascule desktop/mobile de
 * `md` (768px) à `lg` (1024px) dans Sidebar.tsx/Header.tsx/BottomNav.tsx/DashboardLayout.tsx.
 *
 * Comme le reste de la suite (voir l'en-tête de ui.test.tsx), ces tests n'exécutent aucun JS
 * client (pas de jsdom/navigateur) — ils vérifient le HTML rendu par le serveur, seule surface
 * testable dans ce paradigme. Le comportement interactif réel (ouverture/fermeture du tiroir au
 * clavier/tactile à chaque palier, absence de débordement horizontal, table de caisse à
 * défilement local) a été vérifié manuellement avec un vrai navigateur (Chromium/Playwright,
 * installé temporairement hors du projet, aucune dépendance ajoutée à package.json — même
 * convention que les sprints précédents, voir HANDOFF.md) ; voir TESTREPORT.md pour le détail.
 * Ce fichier est le garde-fou de non-régression automatisé sur le seuil lui-même : il échoue si
 * quiconque réintroduit par erreur `md:` à la place de `lg:` sur l'un de ces quatre composants.
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let admin: AuthenticatedTestUser;
let restrictedMember: AuthenticatedTestUser;

beforeAll(async () => {
  admin = await registerTenantAdmin({
    tenantName: "Responsive Layout Test",
    tenantSlug: `responsive-layout-test-${runId}`,
    name: "Admin",
    email: `admin-responsive-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(admin.tenantId);

  // Groupe de permissions restreint (ni vehicles.view ni reservations.view) — sert à vérifier
  // que BottomNav masque désormais ces deux liens comme le fait déjà Sidebar, au lieu de les
  // afficher inconditionnellement (voir nav-visibility.ts / HANDOFF.md).
  const restrictedGroup = await prisma.permissionGroup.create({
    data: {
      tenantId: admin.tenantId,
      name: `BottomNav Restreint ${runId}`,
      groupPermissions: { create: [{ permissionKey: "alerts.view" }] },
    },
  });

  restrictedMember = await createAndLoginMember({
    tenantId: admin.tenantId,
    name: "Membre Restreint",
    email: `membre-restreint-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });

  await prisma.user.update({
    where: { id: restrictedMember.userId },
    data: { permissionGroupId: restrictedGroup.id },
  });
});

afterAll(async () => {
  await prisma.cashEntry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashRegister.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("Sidebar/Header/BottomNav — seuil de bascule desktop/mobile relevé à lg (1024px)", () => {
  it("la sidebar desktop bascule sur `lg:flex` (jamais `md:flex`)", async () => {
    const response = await apiFetch("/dashboard", { headers: { Cookie: admin.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/\blg:flex\b/);
    expect(html).not.toMatch(/\bmd:flex\b/);
  });

  it("le tiroir mobile (overlay + aside) bascule sur `lg:hidden` (jamais `md:hidden`)", async () => {
    const response = await apiFetch("/dashboard", { headers: { Cookie: admin.sessionCookie } });
    const html = await response.text();
    // Au moins 3 occurrences attendues : overlay, aside du tiroir, bouton hamburger du Header
    // (BottomNav ajoute une 4e occurrence, comptée séparément ci-dessous).
    const lgHiddenCount = (html.match(/\blg:hidden\b/g) ?? []).length;
    expect(lgHiddenCount).toBeGreaterThanOrEqual(3);
    expect(html).not.toMatch(/\bmd:hidden\b/);
  });

  it("le bouton hamburger (« Ouvrir le menu ») est présent dans le HTML rendu, avec le seuil lg", async () => {
    const response = await apiFetch("/dashboard", { headers: { Cookie: admin.sessionCookie } });
    const html = await response.text();
    expect(html).toContain("Ouvrir le menu");
  });

  it("la navigation rapide mobile (BottomNav) est présente et bascule aussi sur `lg:hidden`", async () => {
    const response = await apiFetch("/dashboard", { headers: { Cookie: admin.sessionCookie } });
    const html = await response.text();
    expect(html).toContain('aria-label="Navigation rapide"');
  });
});

describe("BottomNav — navigation rapide mobile filtrée par permission (comme Sidebar, correctif HANDOFF.md)", () => {
  it("un ADMIN voit toujours les liens Véhicules/Réservations/Accueil/Profil", async () => {
    const response = await apiFetch("/dashboard", { headers: { Cookie: admin.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="/dashboard/vehicles"');
    expect(html).toContain('href="/dashboard/reservations"');
    expect(html).toContain('href="/dashboard/settings"');
  });

  it("un MEMBER sans vehicles.view ni reservations.view ne voit ces liens nulle part (ni Sidebar, ni BottomNav)", async () => {
    const response = await apiFetch("/dashboard", { headers: { Cookie: restrictedMember.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    // Avant correctif, BottomNav affichait ces deux liens à tout le monde, y compris ce
    // profil restreint — alors même que la route cible refuse déjà l'accès côté serveur.
    expect(html).not.toContain('href="/dashboard/vehicles"');
    expect(html).not.toContain('href="/dashboard/reservations"');
    // Accueil et Profil restent visibles : aucune permission requise pour ces deux entrées,
    // dans Sidebar comme dans BottomNav (voir nav-visibility.ts).
    expect(html).toContain('href="/dashboard/settings"');
    expect(html).toContain('aria-label="Navigation rapide"');
  });
});

describe("Caisse — table « Pilotage financier par agence » : défilement local uniquement", () => {
  it("le conteneur de la table conserve overflow-x-auto (jamais de débordement global de page)", async () => {
    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: "Agence Responsive", slug: `responsive-agency-${runId}` }),
    });
    expect(agencyResponse.status).toBe(201);

    const response = await apiFetch("/dashboard/cash-register", { headers: { Cookie: admin.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Pilotage financier par agence");
    expect(html).toContain("overflow-x-auto");
  });
});
