import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

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
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("Pages d'authentification", () => {
  it("GET /login est accessible sans authentification et rend le formulaire", async () => {
    const response = await apiFetch("/login");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
  });

  it("GET /register est accessible sans authentification et rend le formulaire", async () => {
    const response = await apiFetch("/register");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('name="tenantName"');
    expect(html).toContain('name="email"');
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

  it("redirige un MEMBER vers /dashboard (pas d'accès à l'annuaire)", async () => {
    // redirect() dans un Server Component de cette version de Next.js (contexte de
    // streaming, cf. node_modules/next/dist/docs/.../functions/redirect.md) renvoie
    // un 200 avec une balise meta refresh plutôt qu'un 307 HTTP brut — contrairement
    // à proxy.ts (middleware), qui s'exécute avant tout rendu et renvoie un vrai 307.
    const response = await apiFetch("/dashboard/users", {
      headers: { Cookie: member.sessionCookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('url=/dashboard"');
    expect(html).not.toContain("UI Admin");
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
    // notFound() dans un Server Component de cette version de Next.js (même contexte de
    // streaming que redirect(), voir le test /dashboard/users ci-dessus) renvoie un 200 avec
    // l'UI "not found" (balise <meta name="robots" content="noindex">) plutôt qu'un vrai 404
    // HTTP brut, une fois que le shell du dashboard a déjà commencé à streamer.
    expect(response.status).toBe(200);
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
});
