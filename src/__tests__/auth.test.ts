import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decode as decodeSessionJwt } from "next-auth/jwt";
import { prisma } from "@/lib/prisma";
import { apiFetch, extractSessionCookie, findSetCookie } from "./helpers/http";
import { registerTenantAdmin, createTenantAdmin, deleteTestTenants } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const tenantSlug = `auth-test-tenant-${runId}`;
const adminEmail = `admin-${runId}@test.local`;
const password = "Correct-Horse-Battery-Staple9!";

const createdTenantIds: string[] = [];

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
  await prisma.$disconnect();
});

// Bootstrap direct (Prisma), pas via HTTP : POST /api/auth/register a été retiré (2026-08-29,
// DOMAINRULES.md — création de tenant réservée au Super Admin plateforme). La couverture de la
// création de tenant elle-même (garde Super Admin, premier ADMIN correctement rattaché, refus
// visiteur/MEMBER/ADMIN ordinaire) vit désormais dans tenants.test.ts (POST /api/tenants) et
// ui.test.tsx (confirmation que /register et POST /api/auth/register n'existent plus).
let bootstrapped: Awaited<ReturnType<typeof registerTenantAdmin>>;

beforeAll(async () => {
  bootstrapped = await registerTenantAdmin({
    tenantName: "Auth Test Tenant",
    tenantSlug,
    name: "Admin Test",
    email: adminEmail,
    password,
  });
  createdTenantIds.push(bootstrapped.tenantId);
});

describe("GET /api/auth/me sans session", () => {
  it("retourne 401", async () => {
    const response = await apiFetch("/api/auth/me");
    expect(response.status).toBe(401);
  });
});

describe("POST /api/auth/login", () => {
  it("refuse un corps de requête disproportionné avant tout parsing/rate limiting (413, revue OWASP Phase 6, 2026-08-31)", async () => {
    // Route publique, corps parsé avant même la vérification du verrou de connexion — voir
    // src/lib/request-guards.ts pour le détail complet de la faille corrigée.
    const response = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "x@test.local", password: "A".repeat(2 * 1024 * 1024) }),
    });
    expect(response.status).toBe(413);
  });

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

/**
 * Correctif revue OWASP Phase 6 (2026-08-31) — faille trouvée : `@auth/core` ignorait
 * entièrement l'`exp` dynamique calculé par le callback `jwt()` (src/lib/auth.ts) selon
 * "Se souvenir de moi", et émettait systématiquement un jeton valide 30 jours (`session.maxAge`
 * statique), y compris quand la case était décochée. Corrigé par un `jwt.encode` personnalisé
 * qui dérive le `maxAge` réellement transmis à `@auth/core` de l'`exp` déjà posé sur le token.
 * Décode ici le vrai cookie émis par le serveur (même secret/sel qu'`@auth/core`) pour vérifier
 * l'`exp` réellement chiffré dans le jeton — pas seulement son enveloppe HTTP (`Max-Age` du
 * cookie, qui reste volontairement à 30 jours côté navigateur, voir le commentaire dans
 * src/lib/auth.ts : c'est la validité cryptographique du jeton qui doit refléter le choix de
 * l'utilisateur, seule chose qu'`getSessionUser()`/`auth()` vérifient réellement).
 */
describe("Durée de session selon 'Se souvenir de moi' (revue OWASP Phase 6, 2026-08-31)", () => {
  const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

  async function loginAndDecodeExp(rememberMe: boolean | undefined): Promise<number | undefined> {
    const response = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: adminEmail,
        password,
        ...(rememberMe === undefined ? {} : { rememberMe }),
      }),
    });
    expect(response.status).toBe(200);

    const cookie = extractSessionCookie(response);
    expect(cookie).toBeDefined();
    const equalsIndex = cookie!.indexOf("=");
    const cookieName = cookie!.slice(0, equalsIndex);
    const cookieValue = cookie!.slice(equalsIndex + 1);

    const payload = await decodeSessionJwt({
      token: cookieValue,
      secret: process.env.AUTH_SECRET as string,
      salt: cookieName,
    });
    return payload?.exp as number | undefined;
  }

  it("'Se souvenir de moi' décoché émet un jeton dont l'expiration réelle est proche d'1 jour, jamais de 30 jours", async () => {
    const exp = await loginAndDecodeExp(false);
    expect(exp).toBeDefined();
    const remainingSeconds = exp! - Math.floor(Date.now() / 1000);
    // Marge large (1h à 2 jours) pour rester robuste au temps d'exécution du test tout en
    // détectant sans ambiguïté une régression vers les 30 jours du comportement coché.
    expect(remainingSeconds).toBeGreaterThan(60 * 60);
    expect(remainingSeconds).toBeLessThan(2 * 24 * 60 * 60);
  });

  it("'Se souvenir de moi' coché émet un jeton dont l'expiration réelle est proche de 30 jours", async () => {
    const exp = await loginAndDecodeExp(true);
    expect(exp).toBeDefined();
    const remainingSeconds = exp! - Math.floor(Date.now() / 1000);
    expect(remainingSeconds).toBeGreaterThan(20 * 24 * 60 * 60);
    expect(remainingSeconds).toBeLessThanOrEqual(SESSION_MAX_AGE_SECONDS + 60);
  });

  it("absence du champ 'rememberMe' (valeur par défaut du corps de requête) se comporte comme coché", async () => {
    const exp = await loginAndDecodeExp(undefined);
    expect(exp).toBeDefined();
    const remainingSeconds = exp! - Math.floor(Date.now() / 1000);
    expect(remainingSeconds).toBeGreaterThan(20 * 24 * 60 * 60);
  });
});

describe("Résolution du tenant à la connexion (Sprint 9, Option B)", () => {
  const sharedEmail = `shared-${runId}@test.local`;
  let sharedTenant1Id: string;
  let sharedTenant2Id: string;

  it("prépare deux tenants avec le même email+mot de passe (createTenantAdmin, sans connexion : registerTenantAdmin déclencherait une connexion déjà ambiguë pour le 2e tenant)", async () => {
    const tenant1 = await createTenantAdmin({
      tenantName: "Shared Email Tenant 1",
      tenantSlug: `shared-1-${runId}`,
      name: "User One",
      email: sharedEmail,
      password,
    });
    sharedTenant1Id = tenant1.tenantId;
    createdTenantIds.push(sharedTenant1Id);

    const tenant2 = await createTenantAdmin({
      tenantName: "Shared Email Tenant 2",
      tenantSlug: `shared-2-${runId}`,
      name: "User Two",
      email: sharedEmail,
      password,
    });
    sharedTenant2Id = tenant2.tenantId;
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
