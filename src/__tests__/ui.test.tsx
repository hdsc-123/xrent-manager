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
    password: "correct-horse-battery-staple",
  });
  createdTenantIds.push(admin.tenantId);

  member = await createAndLoginMember({
    tenantId: admin.tenantId,
    name: "UI Member",
    email: `ui-member-${runId}@test.local`,
    password: "correct-horse-battery-staple",
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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
