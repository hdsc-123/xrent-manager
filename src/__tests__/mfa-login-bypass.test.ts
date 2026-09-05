import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateTotpToken } from "@/lib/mfa";
import { createLoginMfaProof } from "@/lib/mfa-login-proof";
import { apiFetch, extractSessionCookie, findSetCookie } from "./helpers/http";
import { registerTenantAdmin, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

/**
 * Correctif audit MFA (2026-09-05, brief explicite du propriétaire du projet) : tests de
 * non-régression pour le contournement trouvé le même jour — `authorize()` (src/lib/auth.ts,
 * provider Credentials NextAuth) ne vérifiait jamais `User.mfaEnabled`, si bien qu'un appel
 * direct à l'endpoint natif NextAuth `POST /api/auth/callback/credentials` (jamais couvert par
 * `src/proxy.ts`, dont le matcher ne porte que sur `/dashboard`/`/settings`) obtenait une session
 * complète avec seulement email + mot de passe, même sur un compte MFA activée — contournant
 * entièrement `POST /api/auth/mfa/verify`.
 *
 * Le flux officiel (login sans MFA, TOTP valide/invalide, code de récupération valide/rejoué,
 * rate limiting dédié, absence de session avant preuve MFA) reste couvert par
 * `mfa-routes.test.ts` (describe "MFA — intégration au login") — volontairement non dupliqué
 * ici, ce fichier se concentre sur ce qui est nouveau avec ce correctif : l'endpoint natif
 * NextAuth lui-même, et la preuve de login MFA (src/lib/mfa-login-proof.ts).
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const password = "Correct-Horse-Battery-Staple9!";
const createdTenantIds: string[] = [];

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
  await prisma.$disconnect();
});

async function newAdmin(label: string): Promise<AuthenticatedTestUser> {
  const admin = await registerTenantAdmin({
    tenantName: `MFA Bypass ${label} ${runId}`,
    tenantSlug: `mfa-bypass-${label}-${runId}`,
    name: `MFA Bypass ${label} Admin`,
    email: `mfa-bypass-${label}-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(admin.tenantId);
  return admin;
}

async function enableMfa(admin: AuthenticatedTestUser): Promise<void> {
  const enrollResponse = await apiFetch("/api/mfa/enroll", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({}),
  });
  const { secretBase32 } = await enrollResponse.json();
  const code = await generateTotpToken(secretBase32);
  const confirmResponse = await apiFetch("/api/mfa/enroll/confirm", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ code }),
  });
  expect(confirmResponse.status).toBe(200);
}

/**
 * Appel direct de l'endpoint natif NextAuth (`POST /api/auth/callback/credentials`) — jamais
 * via `signIn()`/les routes wrapper `/api/auth/login` ou `/api/auth/mfa/verify`. Reproduit
 * exactement ce qu'un client externe peut faire : `GET /api/auth/csrf` (public, sans session)
 * pour obtenir un jeton CSRF valide (double-submit, `node_modules/@auth/core/lib/init.js`), puis
 * `POST` avec ce jeton — même mécanisme déjà exercé par `users.test.ts` pour `/api/auth/session`.
 */
async function rawCredentialsCallback(params: {
  email: string;
  password: string;
  tenantId?: string;
  mfaProof?: string;
}): Promise<Response> {
  const csrfResponse = await apiFetch("/api/auth/csrf");
  const { csrfToken } = await csrfResponse.json();
  const csrfCookie = findSetCookie(csrfResponse, "csrf-token")?.split(";")[0];
  if (!csrfCookie) {
    throw new Error("Cookie CSRF manquant dans la réponse de test.");
  }

  return apiFetch("/api/auth/callback/credentials", {
    method: "POST",
    // NextAuth répond toujours par une redirection (302, jamais du JSON) sur cet endpoint natif,
    // cookie de session inclus sur CETTE réponse précise (node_modules/@auth/core, action
    // callback) — un `fetch` qui suivrait automatiquement la redirection perdrait ce Set-Cookie
    // (seules les en-têtes de la réponse *finale* suivie restent accessibles, jamais celles d'une
    // étape intermédiaire). `redirect: "manual"` conserve la réponse 302 elle-même.
    redirect: "manual",
    headers: { Cookie: csrfCookie },
    body: JSON.stringify({
      email: params.email,
      password: params.password,
      csrfToken,
      ...(params.tenantId ? { tenantId: params.tenantId } : {}),
      ...(params.mfaProof ? { mfaProof: params.mfaProof } : {}),
    }),
  });
}

describe("Correctif contournement MFA — endpoint natif NextAuth (POST /api/auth/callback/credentials)", () => {
  it("refuse une session sur un compte MFA activée avec seulement email + mot de passe (contournement fermé)", async () => {
    const admin = await newAdmin("native-mfa");
    await enableMfa(admin);

    const response = await rawCredentialsCallback({
      email: admin.email,
      password,
      tenantId: admin.tenantId,
    });

    expect(extractSessionCookie(response)).toBeUndefined();
  });

  it("conserve le comportement actuel pour un compte sans MFA (opt-in, aucune régression)", async () => {
    const admin = await newAdmin("native-no-mfa");

    const response = await rawCredentialsCallback({
      email: admin.email,
      password,
      tenantId: admin.tenantId,
    });

    expect(extractSessionCookie(response)).toBeDefined();
  });

  it("refuse toujours sans preuve même avec un mot de passe correct (pas de repli permissif)", async () => {
    const admin = await newAdmin("native-mfa-no-proof");
    await enableMfa(admin);

    const response = await rawCredentialsCallback({
      email: admin.email,
      password,
      tenantId: admin.tenantId,
      mfaProof: "",
    });

    expect(extractSessionCookie(response)).toBeUndefined();
  });
});

describe("Correctif contournement MFA — preuve de login (src/lib/mfa-login-proof.ts)", () => {
  it("une preuve valide, mintée après un second facteur déjà validé, ouvre bien la session", async () => {
    const admin = await newAdmin("proof-valid");
    await enableMfa(admin);
    const proof = await createLoginMfaProof(admin.userId);

    const response = await rawCredentialsCallback({
      email: admin.email,
      password,
      tenantId: admin.tenantId,
      mfaProof: proof,
    });

    expect(extractSessionCookie(response)).toBeDefined();
  });

  it("usage unique : la même preuve ne peut jamais être consommée deux fois (anti-rejeu)", async () => {
    const admin = await newAdmin("proof-replay");
    await enableMfa(admin);
    const proof = await createLoginMfaProof(admin.userId);

    const first = await rawCredentialsCallback({
      email: admin.email,
      password,
      tenantId: admin.tenantId,
      mfaProof: proof,
    });
    expect(extractSessionCookie(first)).toBeDefined();

    // Le jeton en clair n'apparaît jamais dans la réponse HTTP elle-même.
    const firstBody = await first.text();
    expect(firstBody).not.toContain(proof);

    const second = await rawCredentialsCallback({
      email: admin.email,
      password,
      tenantId: admin.tenantId,
      mfaProof: proof,
    });
    expect(extractSessionCookie(second)).toBeUndefined();
  });

  it("isolation/IDOR : une preuve mintée pour un autre utilisateur est refusée, et reste valide pour son propriétaire réel", async () => {
    const victim = await newAdmin("proof-victim");
    const attacker = await newAdmin("proof-attacker");
    await enableMfa(victim);
    await enableMfa(attacker);

    const victimProof = await createLoginMfaProof(victim.userId);

    const stolenAttempt = await rawCredentialsCallback({
      email: attacker.email,
      password,
      tenantId: attacker.tenantId,
      mfaProof: victimProof,
    });
    expect(extractSessionCookie(stolenAttempt)).toBeUndefined();

    // La tentative échouée sur un autre compte n'a pas consommé la preuve de la victime.
    const legitAttempt = await rawCredentialsCallback({
      email: victim.email,
      password,
      tenantId: victim.tenantId,
      mfaProof: victimProof,
    });
    expect(extractSessionCookie(legitAttempt)).toBeDefined();
  });

  it("une preuve expirée est refusée", async () => {
    const admin = await newAdmin("proof-expired");
    await enableMfa(admin);
    const proof = await createLoginMfaProof(admin.userId);

    // Simule l'expiration naturelle (60s) sans dépendre du temps réel écoulé dans le test.
    await prisma.mfaLoginProof.updateMany({
      where: { userId: admin.userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await rawCredentialsCallback({
      email: admin.email,
      password,
      tenantId: admin.tenantId,
      mfaProof: proof,
    });
    expect(extractSessionCookie(response)).toBeUndefined();
  });

  it("le jeton de preuve en clair n'est jamais persisté ni journalisé", async () => {
    const admin = await newAdmin("proof-no-leak");
    await enableMfa(admin);
    const proof = await createLoginMfaProof(admin.userId);

    const storedRows = await prisma.mfaLoginProof.findMany({ where: { userId: admin.userId } });
    expect(storedRows).toHaveLength(1);
    expect(storedRows[0].tokenHash).not.toBe(proof);
    expect(storedRows[0].tokenHash).not.toContain(proof);

    await rawCredentialsCallback({ email: admin.email, password, tenantId: admin.tenantId, mfaProof: proof });

    const logs = await prisma.auditLog.findMany({ where: { tenantId: admin.tenantId, userId: admin.userId } });
    for (const log of logs) {
      expect(JSON.stringify(log)).not.toContain(proof);
    }
  });
});
