import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { apiFetch, extractSessionCookie, findSetCookie } from "./helpers/http";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const tenantSlug = `auth-test-tenant-${runId}`;
const adminEmail = `admin-${runId}@test.local`;
const password = "Correct-Horse-Battery-Staple9!";

const createdTenantIds: string[] = [];

afterAll(async () => {
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("POST /api/auth/register", () => {
  it("crée un tenant et un user ADMIN, sans jamais retourner passwordHash", async () => {
    const response = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        tenantName: "Auth Test Tenant",
        tenantSlug,
        name: "Admin Test",
        email: adminEmail,
        password,
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    createdTenantIds.push(body.tenant.id);

    expect(body.user.email).toBe(adminEmail);
    expect(body.user.role).toBe("ADMIN");
    expect(body.user.tenantId).toBe(body.tenant.id);
    expect(body.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("passwordHash");

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: body.user.id } });
    expect(stored.passwordHash).toBeTruthy();
    expect(stored.passwordHash).not.toBe(password);
    expect(await bcrypt.compare(password, stored.passwordHash as string)).toBe(true);
  });

  it("rejette un mot de passe trop court", async () => {
    const response = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        tenantName: "Short Pw Tenant",
        tenantSlug: `short-pw-${runId}`,
        name: "Nobody",
        email: `short-${runId}@test.local`,
        password: "short",
      }),
    });

    expect(response.status).toBe(400);
  });

  it("refuse un slug de tenant déjà utilisé", async () => {
    const response = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        tenantName: "Duplicate Slug Tenant",
        tenantSlug,
        name: "Someone Else",
        email: `dup-${runId}@test.local`,
        password,
      }),
    });

    expect(response.status).toBe(409);
  });
});

describe("GET /api/auth/me sans session", () => {
  it("retourne 401", async () => {
    const response = await apiFetch("/api/auth/me");
    expect(response.status).toBe(401);
  });
});

describe("POST /api/auth/login", () => {
  it("refuse un mot de passe incorrect sans distinguer un compte inexistant", async () => {
    const wrongPassword = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: adminEmail, password: "wrong-password" }),
    });
    const unknownAccount = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: `does-not-exist-${runId}@test.local`, password }),
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    expect((await wrongPassword.json()).error).toBe((await unknownAccount.json()).error);
  });

  it("connecte l'utilisateur, pose un cookie de session et jamais passwordHash", async () => {
    const response = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: adminEmail, password }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.email).toBe(adminEmail);
    expect(body.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("passwordHash");

    const sessionCookie = extractSessionCookie(response);
    expect(sessionCookie).toBeDefined();
  });
});

describe("Résolution du tenant à la connexion (Sprint 9, Option B)", () => {
  const sharedEmail = `shared-${runId}@test.local`;
  let sharedTenant1Id: string;
  let sharedTenant2Id: string;

  it("prépare deux tenants avec le même email+mot de passe (registerTenantAdmin non utilisable : sa propre étape de login serait déjà ambiguë pour le 2e tenant)", async () => {
    const register1 = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        tenantName: "Shared Email Tenant 1",
        tenantSlug: `shared-1-${runId}`,
        name: "User One",
        email: sharedEmail,
        password,
      }),
    });
    expect(register1.status).toBe(201);
    sharedTenant1Id = (await register1.json()).tenant.id;
    createdTenantIds.push(sharedTenant1Id);

    const register2 = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        tenantName: "Shared Email Tenant 2",
        tenantSlug: `shared-2-${runId}`,
        name: "User Two",
        email: sharedEmail,
        password,
      }),
    });
    expect(register2.status).toBe(201);
    sharedTenant2Id = (await register2.json()).tenant.id;
    createdTenantIds.push(sharedTenant2Id);
  });

  it("propose une sélection de tenant si le même email+mot de passe existe dans plusieurs tenants", async () => {
    const response = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: sharedEmail, password }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.requiresTenantSelection).toBe(true);
    const tenantIds = body.tenants.map((t: { id: string }) => t.id);
    expect(tenantIds).toContain(sharedTenant1Id);
    expect(tenantIds).toContain(sharedTenant2Id);
    expect(extractSessionCookie(response)).toBeUndefined();
  });

  it("se connecte au tenant précis une fois tenantId fourni", async () => {
    const response = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: sharedEmail, password, tenantId: sharedTenant1Id }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.tenantId).toBe(sharedTenant1Id);
    expect(extractSessionCookie(response)).toBeDefined();
  });

  it("ne révèle jamais la liste de tenants avec un mot de passe invalide", async () => {
    const response = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: sharedEmail, password: "wrong-password-entirely9!" }),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.requiresTenantSelection).toBeUndefined();
    expect(body.tenants).toBeUndefined();
  });
});

describe("cycle de vie complet de la session (login → me → logout → me)", () => {
  it("crée puis détruit la session", async () => {
    const loginResponse = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: adminEmail, password }),
    });
    const sessionCookie = extractSessionCookie(loginResponse);
    expect(sessionCookie).toBeDefined();

    const meResponse = await apiFetch("/api/auth/me", {
      headers: { Cookie: sessionCookie! },
    });
    expect(meResponse.status).toBe(200);
    const meBody = await meResponse.json();
    expect(meBody.user.email).toBe(adminEmail);
    expect(meBody.user.role).toBe("ADMIN");
    expect(meBody.user.passwordHash).toBeUndefined();

    const logoutResponse = await apiFetch("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: sessionCookie! },
    });
    expect(logoutResponse.status).toBe(200);

    // Session JWT (pas de table Session interrogée) : la destruction se traduit par
    // l'effacement du cookie côté serveur (Max-Age=0), à charge pour le client de le
    // respecter — voir la décision "JWT plutôt que database sessions" dans HANDOFF.md.
    const clearedCookie = findSetCookie(logoutResponse, "session-token=");
    expect(clearedCookie).toBeDefined();
    expect(clearedCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });
});
