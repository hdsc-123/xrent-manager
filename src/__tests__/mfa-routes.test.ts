import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateTotpToken } from "@/lib/mfa";
import { hasValidStepUp, purgeStepUpProofs } from "@/lib/mfa-session";
import {
  mfaLoginThrottleKey,
  mfaRecoveryThrottleKey,
  mfaEnrollConfirmThrottleKey,
} from "@/lib/login-throttle";
import { apiFetch, extractSessionCookie } from "./helpers/http";
import { registerTenantAdmin, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

/**
 * Phase 3B MFA (2026-08-29, AGENTS.md brief) : tests d'intégration HTTP réels (serveur `next
 * dev` de test, voir vitest.global-setup.ts) des routes d'enrôlement/confirmation/step-up et de
 * l'intégration au login. MFA_ENCRYPTION_KEY de test dédiée (.env.test, valeur fictive générée
 * pour cette session). Aucun compte réel, aucun secret réel — chaque test crée son propre
 * tenant/admin via registerTenantAdmin (jamais xrent_test modifiée hors du périmètre créé ici,
 * intégralement nettoyé en afterAll).
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const password = "Correct-Horse-Battery-Staple9!";
const createdTenantIds: string[] = [];
const usedThrottleKeys: string[] = [];

afterAll(async () => {
  await prisma.loginThrottle.deleteMany({ where: { key: { in: usedThrottleKeys } } });
  await deleteTestTenants(createdTenantIds);
  await prisma.$disconnect();
});

async function newAdmin(label: string): Promise<AuthenticatedTestUser> {
  const email = `mfa-${label}-${runId}@test.local`;
  const admin = await registerTenantAdmin({
    tenantName: `MFA ${label} ${runId}`,
    tenantSlug: `mfa-${label}-${runId}`,
    name: `MFA ${label} Admin`,
    email,
    password,
  });
  createdTenantIds.push(admin.tenantId);
  usedThrottleKeys.push(mfaLoginThrottleKey(email), mfaRecoveryThrottleKey(email));
  usedThrottleKeys.push(mfaEnrollConfirmThrottleKey(admin.userId));
  return admin;
}

interface EnrollResponse {
  secretBase32: string;
  otpauthUri: string;
}

async function enroll(cookie: string): Promise<EnrollResponse> {
  const response = await apiFetch("/api/mfa/enroll", {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function confirm(cookie: string, code: string) {
  return apiFetch("/api/mfa/enroll/confirm", {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({ code }),
  });
}

/** Enrôle et confirme MFA pour un admin de test, retourne les codes de récupération. */
async function enableMfa(admin: AuthenticatedTestUser): Promise<{ secretBase32: string; recoveryCodes: string[] }> {
  const { secretBase32 } = await enroll(admin.sessionCookie);
  const code = await generateTotpToken(secretBase32);
  const response = await confirm(admin.sessionCookie, code);
  expect(response.status).toBe(200);
  const body = await response.json();
  return { secretBase32, recoveryCodes: body.recoveryCodes };
}

const TOTP_PERIOD_SECONDS = 30;

/**
 * INC-26 (2026-08-30) : remplace l'ancienne marge fixe « +31s » (`subsequentTotpCode`),
 * intermittente sous forte charge — voir INCIDENTS.md pour le détail de la cause racine. Même
 * stratégie déjà en place et stable dans src/__tests__/mfa-lifecycle.test.ts/
 * mfa-step-up-gating.test.ts : cible le pas de temps courant (ou `mfaLastUsedStep + 1` si ce
 * dernier est postérieur, pour l'anti-rejeu — nécessaire après `enableMfa()` ci-dessus, dont la
 * confirmation d'enrôlement consomme déjà un pas), jamais un décalage arbitraire dans le futur —
 * reste valide quelle que soit la latence réelle avant vérification côté serveur (fenêtre de
 * tolérance ±30s autour du « maintenant » du serveur, jamais un horodatage client, voir
 * src/lib/mfa.ts).
 */
async function nextTotpCode(userId: string, secretBase32: string): Promise<string> {
  const current = await prisma.user.findUnique({ where: { id: userId }, select: { mfaLastUsedStep: true } });
  const now = Math.floor(Date.now() / 1000);
  const nowStep = Math.floor(now / TOTP_PERIOD_SECONDS);
  const lastUsedStep = current?.mfaLastUsedStep ?? null;
  const targetStep = lastUsedStep !== null ? Math.max(nowStep, lastUsedStep + 1) : nowStep;
  return generateTotpToken(secretBase32, targetStep * TOTP_PERIOD_SECONDS + 1);
}

describe("MFA — enrôlement (POST /api/mfa/enroll)", () => {
  it("refuse un visiteur non authentifié", async () => {
    const response = await apiFetch("/api/mfa/enroll", { method: "POST", body: JSON.stringify({}) });
    expect(response.status).toBe(401);
  });

  it("enrôle l'utilisateur de la session, jamais un autre utilisateur ciblé par identifiant", async () => {
    const admin = await newAdmin("enroll-target");
    const other = await newAdmin("enroll-other");

    const response = await apiFetch("/api/mfa/enroll", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      // userId étranger glissé dans le corps — ne doit avoir strictement aucun effet, la route
      // n'accepte aucun paramètre, seule la session détermine la cible.
      body: JSON.stringify({ userId: other.userId }),
    });
    expect(response.status).toBe(200);
    const body: EnrollResponse = await response.json();
    expect(body.secretBase32).toBeTruthy();
    expect(body.otpauthUri).toContain(encodeURIComponent(admin.email));

    const targetUser = await prisma.user.findUnique({ where: { id: admin.userId } });
    const otherUser = await prisma.user.findUnique({ where: { id: other.userId } });
    expect(targetUser?.mfaSecretCiphertext).toBeTruthy();
    expect(targetUser?.mfaEnabled).toBe(false);
    expect(otherUser?.mfaSecretCiphertext).toBeNull();
  });

  it("le secret en attente n'est jamais stocké en clair (mfaSecretCiphertext ne contient jamais le secret Base32 retourné)", async () => {
    const admin = await newAdmin("enroll-encrypted");
    const { secretBase32 } = await enroll(admin.sessionCookie);

    const dbUser = await prisma.user.findUnique({ where: { id: admin.userId } });
    expect(dbUser?.mfaSecretCiphertext).toBeTruthy();
    expect(dbUser?.mfaSecretCiphertext).not.toContain(secretBase32);
    expect(dbUser?.mfaEnabled).toBe(false);
    expect(dbUser?.mfaSecretConfirmedAt).toBeNull();
  });

  it("un nouvel appel remplace l'enrôlement non confirmé précédent", async () => {
    const admin = await newAdmin("enroll-replace");
    const first = await enroll(admin.sessionCookie);
    const second = await enroll(admin.sessionCookie);
    expect(second.secretBase32).not.toBe(first.secretBase32);

    // L'ancien secret ne doit plus permettre de confirmer.
    const staleCode = await generateTotpToken(first.secretBase32);
    const staleResponse = await confirm(admin.sessionCookie, staleCode);
    expect(staleResponse.status).toBe(400);
  });
});

describe("MFA — confirmation (POST /api/mfa/enroll/confirm)", () => {
  it("refuse un visiteur non authentifié", async () => {
    const response = await apiFetch("/api/mfa/enroll/confirm", {
      method: "POST",
      body: JSON.stringify({ code: "123456" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse sans enrôlement en attente", async () => {
    const admin = await newAdmin("confirm-none");
    const response = await confirm(admin.sessionCookie, "123456");
    expect(response.status).toBe(400);
  });

  it("refuse un code invalide, MFA reste désactivée", async () => {
    const admin = await newAdmin("confirm-invalid");
    await enroll(admin.sessionCookie);
    const response = await confirm(admin.sessionCookie, "000000");
    expect(response.status).toBe(400);

    const dbUser = await prisma.user.findUnique({ where: { id: admin.userId } });
    expect(dbUser?.mfaEnabled).toBe(false);
  });

  it("applique le rate limiting de confirmation avant toute comparaison supplémentaire", async () => {
    const admin = await newAdmin("confirm-throttle");
    await enroll(admin.sessionCookie);

    for (let i = 0; i < 5; i++) {
      const response = await confirm(admin.sessionCookie, "000000");
      expect(response.status).toBe(400);
    }

    const lockedResponse = await confirm(admin.sessionCookie, "000000");
    expect(lockedResponse.status).toBe(429);
  });

  it("active MFA avec un code valide : codes de récupération retournés une seule fois, hashes uniquement en base", async () => {
    const admin = await newAdmin("confirm-valid");
    const { secretBase32 } = await enroll(admin.sessionCookie);
    const code = await generateTotpToken(secretBase32);

    const response = await confirm(admin.sessionCookie, code);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.recoveryCodes)).toBe(true);
    expect(body.recoveryCodes).toHaveLength(10);

    const dbUser = await prisma.user.findUnique({ where: { id: admin.userId } });
    expect(dbUser?.mfaEnabled).toBe(true);
    expect(dbUser?.mfaSecretConfirmedAt).not.toBeNull();
    expect(dbUser?.mfaSecurityStamp).toBeTruthy();

    const storedCodes = await prisma.mfaRecoveryCode.findMany({ where: { userId: admin.userId } });
    expect(storedCodes).toHaveLength(10);
    for (const stored of storedCodes) {
      expect(stored.usedAt).toBeNull();
      expect(body.recoveryCodes).not.toContain(stored.codeHash);
    }

    // Refus de confirmer une seconde fois une MFA déjà activée.
    const secondAttempt = await confirm(admin.sessionCookie, code);
    expect(secondAttempt.status).toBe(409);
  });

  it("aucun secret ni code de récupération n'est jamais journalisé dans AuditLog", async () => {
    const admin = await newAdmin("confirm-audit");
    const { secretBase32 } = await enroll(admin.sessionCookie);
    const code = await generateTotpToken(secretBase32);
    const response = await confirm(admin.sessionCookie, code);
    const body = await response.json();

    const logs = await prisma.auditLog.findMany({ where: { tenantId: admin.tenantId, userId: admin.userId } });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(secretBase32);
    for (const recoveryCode of body.recoveryCodes as string[]) {
      expect(serialized).not.toContain(recoveryCode);
    }
    expect(logs.some((log) => log.action === "mfa.enroll.started")).toBe(true);
    expect(logs.some((log) => log.action === "mfa.enroll.confirmed")).toBe(true);
  });
});

describe("MFA — statut (GET /api/mfa/status) n'expose jamais de secret", () => {
  it("ne retourne jamais le secret, l'URI otpauth:// ou les codes de récupération après activation", async () => {
    const admin = await newAdmin("status-safe");
    await enableMfa(admin);

    const response = await apiFetch("/api/mfa/status", { headers: { Cookie: admin.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ mfaEnabled: true, hasPendingEnrollment: false });
  });
});

describe("MFA — intégration au login", () => {
  it("un utilisateur sans MFA se connecte normalement (flux inchangé)", async () => {
    const admin = await newAdmin("login-no-mfa");
    const response = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password }),
    });
    expect(response.status).toBe(200);
    expect(extractSessionCookie(response)).toBeDefined();
  });

  it("un utilisateur avec MFA est interrompu avant toute session, sans code fourni", async () => {
    const admin = await newAdmin("login-mfa-required");
    await enableMfa(admin);

    const response = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.requiresMfa).toBe(true);
    expect(body.user).toBeUndefined();
    expect(extractSessionCookie(response)).toBeUndefined();
  });

  it("connexion complète avec un code TOTP valide (POST /api/auth/mfa/verify)", async () => {
    const admin = await newAdmin("login-mfa-valid");
    const { secretBase32 } = await enableMfa(admin);

    const loginResponse = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password }),
    });
    expect((await loginResponse.json()).requiresMfa).toBe(true);

    const code = await nextTotpCode(admin.userId, secretBase32);
    const verifyResponse = await apiFetch("/api/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password, code }),
    });
    expect(verifyResponse.status).toBe(200);
    expect(extractSessionCookie(verifyResponse)).toBeDefined();

    const logs = await prisma.auditLog.findMany({
      where: { tenantId: admin.tenantId, userId: admin.userId, action: "mfa.login.succeeded" },
    });
    expect(logs).toHaveLength(1);
    expect((logs[0].metadata as { viaRecoveryCode: boolean }).viaRecoveryCode).toBe(false);
  });

  it("refuse un code TOTP invalide, sans jamais créer de session", async () => {
    const admin = await newAdmin("login-mfa-invalid");
    await enableMfa(admin);

    const response = await apiFetch("/api/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password, code: "000000" }),
    });
    expect(response.status).toBe(401);
    expect(extractSessionCookie(response)).toBeUndefined();
  });

  it("refuse un mot de passe incorrect même avec un code valide, sans distinguer le motif de l'échec", async () => {
    const admin = await newAdmin("login-mfa-wrong-password");
    const { secretBase32 } = await enableMfa(admin);
    const code = await nextTotpCode(admin.userId, secretBase32);

    const response = await apiFetch("/api/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password: "wrong-password-x", code }),
    });
    expect(response.status).toBe(401);
  });

  it("connexion via un code de récupération : usage unique, marqué utilisé après coup", async () => {
    const admin = await newAdmin("login-mfa-recovery");
    const { recoveryCodes } = await enableMfa(admin);
    const recoveryCode = recoveryCodes[0];

    const firstUse = await apiFetch("/api/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password, code: recoveryCode }),
    });
    expect(firstUse.status).toBe(200);
    expect(extractSessionCookie(firstUse)).toBeDefined();

    const logs = await prisma.auditLog.findMany({
      where: { tenantId: admin.tenantId, userId: admin.userId, action: "mfa.login.succeeded" },
    });
    expect((logs[0].metadata as { viaRecoveryCode: boolean }).viaRecoveryCode).toBe(true);

    // Le même code ne peut plus jamais être réutilisé.
    const secondUse = await apiFetch("/api/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password, code: recoveryCode }),
    });
    expect(secondUse.status).toBe(401);
  });

  it("applique un rate limiting dédié à la connexion MFA, distinct du throttle mot de passe", async () => {
    const admin = await newAdmin("login-mfa-throttle");
    await enableMfa(admin);

    for (let i = 0; i < 5; i++) {
      const response = await apiFetch("/api/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ email: admin.email, password, code: "000000" }),
      });
      expect(response.status).toBe(401);
    }

    const lockedResponse = await apiFetch("/api/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password, code: "000000" }),
    });
    expect(lockedResponse.status).toBe(429);

    const lockoutLogs = await prisma.auditLog.findMany({
      where: { tenantId: admin.tenantId, userId: admin.userId, action: "mfa.lockout" },
    });
    expect(lockoutLogs.length).toBeGreaterThanOrEqual(1);
  });

  it("isolation entre utilisateurs : l'activation MFA d'un compte n'affecte jamais un autre tenant", async () => {
    const withMfa = await newAdmin("isolation-with-mfa");
    const withoutMfa = await newAdmin("isolation-without-mfa");
    await enableMfa(withMfa);

    const response = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: withoutMfa.email, password }),
    });
    expect(response.status).toBe(200);
    expect(extractSessionCookie(response)).toBeDefined();

    const statusOther = await apiFetch("/api/mfa/status", { headers: { Cookie: withoutMfa.sessionCookie } });
    expect((await statusOther.json()).mfaEnabled).toBe(false);
  });
});

describe("MFA — step-up (POST /api/mfa/step-up/verify)", () => {
  it("refuse un visiteur non authentifié", async () => {
    const response = await apiFetch("/api/mfa/step-up/verify", {
      method: "POST",
      body: JSON.stringify({ code: "123456" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un utilisateur sans MFA activée", async () => {
    const admin = await newAdmin("step-up-no-mfa");
    const response = await apiFetch("/api/mfa/step-up/verify", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ code: "123456" }),
    });
    expect(response.status).toBe(400);
  });

  it("crée une preuve de step-up valide pour la session courante avec un code correct", async () => {
    const admin = await newAdmin("step-up-valid");
    const { secretBase32 } = await enableMfa(admin);
    const code = await nextTotpCode(admin.userId, secretBase32);

    const response = await apiFetch("/api/mfa/step-up/verify", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ code }),
    });
    expect(response.status).toBe(200);

    const proof = await prisma.mfaStepUpProof.findFirst({ where: { userId: admin.userId } });
    expect(proof).not.toBeNull();
    expect(proof!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const logs = await prisma.auditLog.findMany({
      where: { tenantId: admin.tenantId, userId: admin.userId, action: "mfa.step_up.verified" },
    });
    expect(logs).toHaveLength(1);
  });

  it("la preuve de step-up expirée n'est plus considérée valide côté serveur", async () => {
    const admin = await newAdmin("step-up-expired");
    const { secretBase32 } = await enableMfa(admin);
    const code = await nextTotpCode(admin.userId, secretBase32);

    await apiFetch("/api/mfa/step-up/verify", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ code }),
    });

    const proof = await prisma.mfaStepUpProof.findFirst({ where: { userId: admin.userId } });
    expect(proof).not.toBeNull();

    // Vérifie que hasValidStepUp() ne fait confiance qu'à expiresAt côté serveur — jamais un
    // timestamp client.
    expect(await hasValidStepUp(admin.userId, proof!.sessionId)).toBe(true);

    await prisma.mfaStepUpProof.update({
      where: { id: proof!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await hasValidStepUp(admin.userId, proof!.sessionId)).toBe(false);
  });

  it("purgeStepUpProofs invalide toutes les preuves d'un utilisateur (mécanisme de rotation de mfaSecurityStamp)", async () => {
    const admin = await newAdmin("step-up-purge");
    await prisma.mfaStepUpProof.create({
      data: { userId: admin.userId, sessionId: "test-session-id", expiresAt: new Date(Date.now() + 60_000) },
    });

    expect(await hasValidStepUp(admin.userId, "test-session-id")).toBe(true);
    await purgeStepUpProofs(admin.userId);
    expect(await hasValidStepUp(admin.userId, "test-session-id")).toBe(false);
  });
});
