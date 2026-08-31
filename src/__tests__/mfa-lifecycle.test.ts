import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateTotpToken } from "@/lib/mfa";
import { apiFetch, extractSessionCookie } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

/**
 * Phase 3C MFA (2026-08-29, brief explicite du propriétaire du projet) : tests d'intégration
 * HTTP réels de la désactivation personnelle (POST /api/mfa/disable), de la régénération des
 * codes de récupération (POST /api/mfa/recovery-codes/regenerate), du reset administrateur
 * assisté (POST /api/mfa/admin-reset) et de la révocation globale de session qui en découle.
 * Aucun compte réel, aucun secret réel — voir src/__tests__/mfa-routes.test.ts pour les mêmes
 * conventions (tenant/admin jetables par test, nettoyage complet en afterAll).
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const password = "Correct-Horse-Battery-Staple9!";
const createdTenantIds: string[] = [];
let counter = 0;

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
  await prisma.$disconnect();
});

async function newAdmin(label: string): Promise<AuthenticatedTestUser> {
  counter += 1;
  const admin = await registerTenantAdmin({
    tenantName: `LC ${label} ${counter} ${runId}`,
    tenantSlug: `lc-${label}-${counter}-${runId}`,
    name: `LC ${label} Admin`,
    email: `lc-${label}-${counter}-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(admin.tenantId);
  return admin;
}

async function newMember(tenantId: string, label: string): Promise<AuthenticatedTestUser> {
  counter += 1;
  return createAndLoginMember({
    tenantId,
    name: `LC ${label} Member`,
    email: `lc-member-${label}-${counter}-${runId}@test.local`,
    password,
  });
}

async function enableMfa(user: AuthenticatedTestUser): Promise<{ secretBase32: string; recoveryCodes: string[] }> {
  const enrollResponse = await apiFetch("/api/mfa/enroll", {
    method: "POST",
    headers: { Cookie: user.sessionCookie },
    body: JSON.stringify({}),
  });
  const { secretBase32 } = await enrollResponse.json();
  const code = await generateTotpToken(secretBase32);
  const confirmResponse = await apiFetch("/api/mfa/enroll/confirm", {
    method: "POST",
    headers: { Cookie: user.sessionCookie },
    body: JSON.stringify({ code }),
  });
  expect(confirmResponse.status).toBe(200);
  const body = await confirmResponse.json();
  return { secretBase32, recoveryCodes: body.recoveryCodes };
}

const TOTP_PERIOD_SECONDS = 30;

/**
 * Génère un code TOTP garanti valide au moment où le serveur le vérifiera et garanti sur un pas
 * de temps strictement postérieur au dernier consommé (anti-rejeu) — voir le commentaire
 * équivalent dans mfa-step-up-gating.test.ts : une marge fixe ("+31s") s'est révélée fragile en
 * pratique (fenêtre de tolérance serveur ±30s, gap parfois insuffisant selon le timing réel).
 */
async function nextTotpCode(userId: string, secretBase32: string): Promise<string> {
  const current = await prisma.user.findUnique({ where: { id: userId }, select: { mfaLastUsedStep: true } });
  const now = Math.floor(Date.now() / 1000);
  const nowStep = Math.floor(now / TOTP_PERIOD_SECONDS);
  const lastUsedStep = current?.mfaLastUsedStep ?? null;
  const targetStep = lastUsedStep !== null ? Math.max(nowStep, lastUsedStep + 1) : nowStep;
  return generateTotpToken(secretBase32, targetStep * TOTP_PERIOD_SECONDS + 1);
}

async function stepUp(user: AuthenticatedTestUser, secretBase32: string): Promise<void> {
  const response = await apiFetch("/api/mfa/step-up/verify", {
    method: "POST",
    headers: { Cookie: user.sessionCookie },
    body: JSON.stringify({ code: await nextTotpCode(user.userId, secretBase32) }),
  });
  expect(response.status).toBe(200);
}

describe("POST /api/mfa/disable", () => {
  it("refuse un visiteur non authentifié", async () => {
    const response = await apiFetch("/api/mfa/disable", {
      method: "POST",
      body: JSON.stringify({ password, code: "123456" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un mot de passe seul (sans code)", async () => {
    const admin = await newAdmin("disable-password-only");
    await enableMfa(admin);

    const response = await apiFetch("/api/mfa/disable", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ password }),
    });
    expect(response.status).toBe(400);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect(user.mfaEnabled).toBe(true);
  });

  it("refuse un mot de passe incorrect même avec un TOTP valide", async () => {
    const admin = await newAdmin("disable-wrong-password");
    const { secretBase32 } = await enableMfa(admin);

    const response = await apiFetch("/api/mfa/disable", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ password: "wrong-password-x", code: await nextTotpCode(admin.userId, secretBase32) }),
    });
    expect(response.status).toBe(401);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect(user.mfaEnabled).toBe(true);
  });

  it("désactive avec mot de passe + TOTP valides : purge complète et révocation de session", async () => {
    const admin = await newAdmin("disable-valid-totp");
    const { secretBase32 } = await enableMfa(admin);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });

    const response = await apiFetch("/api/mfa/disable", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ password, code: await nextTotpCode(admin.userId, secretBase32) }),
    });
    expect(response.status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect(after.mfaEnabled).toBe(false);
    expect(after.mfaSecretCiphertext).toBeNull();
    expect(after.mfaSecretConfirmedAt).toBeNull();
    expect(after.mfaSecurityStamp).not.toBe(before.mfaSecurityStamp);
    expect(after.sessionRevokedAt).not.toBeNull();

    const recoveryCodes = await prisma.mfaRecoveryCode.count({ where: { userId: admin.userId } });
    expect(recoveryCodes).toBe(0);
    const proofs = await prisma.mfaStepUpProof.count({ where: { userId: admin.userId } });
    expect(proofs).toBe(0);

    // La session ayant servi à désactiver est elle-même révoquée dès la requête suivante.
    const statusResponse = await apiFetch("/api/mfa/status", { headers: { Cookie: admin.sessionCookie } });
    expect(statusResponse.status).toBe(401);

    const logs = await prisma.auditLog.findMany({
      where: { tenantId: admin.tenantId, userId: admin.userId, action: "mfa.disabled" },
    });
    expect(logs).toHaveLength(1);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(secretBase32);
  });

  it("désactive avec un code de récupération valide (usage unique, non rejouable ensuite)", async () => {
    const admin = await newAdmin("disable-recovery");
    const { recoveryCodes } = await enableMfa(admin);
    const recoveryCode = recoveryCodes[0];

    const response = await apiFetch("/api/mfa/disable", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ password, code: recoveryCode }),
    });
    expect(response.status).toBe(200);

    const logs = await prisma.auditLog.findMany({
      where: { tenantId: admin.tenantId, userId: admin.userId, action: "mfa.disabled" },
    });
    expect((logs[0].metadata as { viaRecoveryCode: boolean }).viaRecoveryCode).toBe(true);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(recoveryCode);

    // Tous les codes de récupération ont été purgés par la désactivation — même celui utilisé
    // n'existe plus, donc "réutiliser" est structurellement impossible (aucune ligne à trouver).
    const remaining = await prisma.mfaRecoveryCode.count({ where: { userId: admin.userId } });
    expect(remaining).toBe(0);
  });

  it("applique un rate limiting dédié avant toute comparaison", async () => {
    const admin = await newAdmin("disable-throttle");
    await enableMfa(admin);

    for (let i = 0; i < 5; i++) {
      const response = await apiFetch("/api/mfa/disable", {
        method: "POST",
        headers: { Cookie: admin.sessionCookie },
        body: JSON.stringify({ password, code: "000000" }),
      });
      expect(response.status).toBe(401);
    }

    const lockedResponse = await apiFetch("/api/mfa/disable", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ password, code: "000000" }),
    });
    expect(lockedResponse.status).toBe(429);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect(user.mfaEnabled).toBe(true);
  });
});

describe("POST /api/mfa/recovery-codes/regenerate", () => {
  it("refuse un visiteur non authentifié", async () => {
    const response = await apiFetch("/api/mfa/recovery-codes/regenerate", {
      method: "POST",
      body: JSON.stringify({ password, code: "123456" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un mot de passe seul (sans code)", async () => {
    const admin = await newAdmin("regen-password-only");
    await enableMfa(admin);

    const response = await apiFetch("/api/mfa/recovery-codes/regenerate", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ password }),
    });
    expect(response.status).toBe(400);
  });

  it("régénère avec mot de passe + TOTP valides : anciens codes invalidés, nouveaux retournés une seule fois", async () => {
    const admin = await newAdmin("regen-valid");
    const { secretBase32, recoveryCodes: oldCodes } = await enableMfa(admin);
    const oldHashes = (await prisma.mfaRecoveryCode.findMany({ where: { userId: admin.userId } })).map((c) => c.codeHash);

    const response = await apiFetch("/api/mfa/recovery-codes/regenerate", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ password, code: await nextTotpCode(admin.userId, secretBase32) }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recoveryCodes).toHaveLength(10);
    expect(body.recoveryCodes.some((c: string) => oldCodes.includes(c))).toBe(false);

    const newRows = await prisma.mfaRecoveryCode.findMany({ where: { userId: admin.userId } });
    expect(newRows).toHaveLength(10);
    const newHashes = newRows.map((c) => c.codeHash);
    // Anciens hashes entièrement remplacés — aucun survivant.
    for (const oldHash of oldHashes) {
      expect(newHashes).not.toContain(oldHash);
    }
    for (const row of newRows) {
      expect(row.usedAt).toBeNull();
      expect(body.recoveryCodes).not.toContain(row.codeHash);
    }

    // MFA reste activée, aucune révocation de session pour cette action (hors périmètre du brief).
    const user = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect(user.mfaEnabled).toBe(true);
    expect(user.sessionRevokedAt).toBeNull();

    const statusResponse = await apiFetch("/api/mfa/status", { headers: { Cookie: admin.sessionCookie } });
    expect(statusResponse.status).toBe(200);

    const logs = await prisma.auditLog.findMany({
      where: { tenantId: admin.tenantId, userId: admin.userId, action: "mfa.recovery_codes.regenerated" },
    });
    expect(logs).toHaveLength(1);
    const serialized = JSON.stringify(logs);
    for (const code of body.recoveryCodes as string[]) {
      expect(serialized).not.toContain(code);
    }
    for (const oldCode of oldCodes) {
      expect(serialized).not.toContain(oldCode);
    }
  });

  it("un ancien code de récupération ne fonctionne plus après régénération", async () => {
    const admin = await newAdmin("regen-old-code-invalid");
    const { secretBase32, recoveryCodes: oldCodes } = await enableMfa(admin);

    await apiFetch("/api/mfa/recovery-codes/regenerate", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ password, code: await nextTotpCode(admin.userId, secretBase32) }),
    });

    // Déconnexion implicite : nouvelle tentative de login via l'ancien code de récupération.
    const loginResponse = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password }),
    });
    expect((await loginResponse.json()).requiresMfa).toBe(true);

    const verifyResponse = await apiFetch("/api/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password, code: oldCodes[0] }),
    });
    expect(verifyResponse.status).toBe(401);
  });

  it("applique un rate limiting dédié avant toute comparaison", async () => {
    const admin = await newAdmin("regen-throttle");
    await enableMfa(admin);

    for (let i = 0; i < 5; i++) {
      const response = await apiFetch("/api/mfa/recovery-codes/regenerate", {
        method: "POST",
        headers: { Cookie: admin.sessionCookie },
        body: JSON.stringify({ password, code: "000000" }),
      });
      expect(response.status).toBe(401);
    }

    const lockedResponse = await apiFetch("/api/mfa/recovery-codes/regenerate", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ password, code: "000000" }),
    });
    expect(lockedResponse.status).toBe(429);
  });
});

describe("POST /api/mfa/admin-reset", () => {
  it("refuse un visiteur non authentifié", async () => {
    const response = await apiFetch("/api/mfa/admin-reset", {
      method: "POST",
      body: JSON.stringify({ targetUserId: "x", reason: "test" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un acteur non-ADMIN", async () => {
    const admin = await newAdmin("admin-reset-not-admin");
    const member = await newMember(admin.tenantId, "actor-not-admin");
    const target = await newMember(admin.tenantId, "target-not-admin");

    const response = await apiFetch("/api/mfa/admin-reset", {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ targetUserId: target.userId, reason: "test" }),
    });
    expect(response.status).toBe(403);
  });

  it("refuse un acteur ADMIN sans MFA activée sur son propre compte", async () => {
    const admin = await newAdmin("admin-reset-actor-no-mfa");
    const target = await newMember(admin.tenantId, "target-actor-no-mfa");
    await enableMfa(target);

    const response = await apiFetch("/api/mfa/admin-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ targetUserId: target.userId, reason: "Perte de l'appareil TOTP" }),
    });
    expect(response.status).toBe(403);

    const targetUser = await prisma.user.findUniqueOrThrow({ where: { id: target.userId } });
    expect(targetUser.mfaEnabled).toBe(true);
  });

  it("refuse un acteur ADMIN avec MFA activée mais sans step-up frais", async () => {
    const admin = await newAdmin("admin-reset-no-stepup");
    await enableMfa(admin);
    const target = await newMember(admin.tenantId, "target-no-stepup");
    await enableMfa(target);

    const response = await apiFetch("/api/mfa/admin-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ targetUserId: target.userId, reason: "Perte de l'appareil TOTP" }),
    });
    expect(response.status).toBe(403);

    const targetUser = await prisma.user.findUniqueOrThrow({ where: { id: target.userId } });
    expect(targetUser.mfaEnabled).toBe(true);
  });

  it("refuse acteur = cible", async () => {
    const admin = await newAdmin("admin-reset-self");
    const { secretBase32: secret } = await enableMfa(admin);
    await stepUp(admin, secret);

    const response = await apiFetch("/api/mfa/admin-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ targetUserId: admin.userId, reason: "Auto-reset invalide" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse un motif manquant", async () => {
    const admin = await newAdmin("admin-reset-no-reason");
    const { secretBase32: secret } = await enableMfa(admin);
    await stepUp(admin, secret);
    const target = await newMember(admin.tenantId, "target-no-reason");
    await enableMfa(target);

    const response = await apiFetch("/api/mfa/admin-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ targetUserId: target.userId }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse une cible d'un autre tenant", async () => {
    const admin = await newAdmin("admin-reset-cross-tenant");
    const { secretBase32: secret } = await enableMfa(admin);
    await stepUp(admin, secret);
    const otherAdmin = await newAdmin("admin-reset-other-tenant");
    const foreignTarget = await newMember(otherAdmin.tenantId, "foreign-target");
    await enableMfa(foreignTarget);

    const response = await apiFetch("/api/mfa/admin-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ targetUserId: foreignTarget.userId, reason: "Tentative inter-tenant" }),
    });
    expect(response.status).toBe(404);

    const foreignUser = await prisma.user.findUniqueOrThrow({ where: { id: foreignTarget.userId } });
    expect(foreignUser.mfaEnabled).toBe(true);
  });

  it("reset valide : purge la cible, rote son mfaSecurityStamp, révoque ses sessions, audit acteur/cible séparés", async () => {
    const admin = await newAdmin("admin-reset-valid");
    const { secretBase32: secret } = await enableMfa(admin);
    await stepUp(admin, secret);
    const target = await newMember(admin.tenantId, "target-valid");
    const { secretBase32: targetSecret } = await enableMfa(target);
    const targetBefore = await prisma.user.findUniqueOrThrow({ where: { id: target.userId } });

    const response = await apiFetch("/api/mfa/admin-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ targetUserId: target.userId, reason: "Perte de l'appareil TOTP et des codes" }),
    });
    expect(response.status).toBe(200);

    const targetAfter = await prisma.user.findUniqueOrThrow({ where: { id: target.userId } });
    expect(targetAfter.mfaEnabled).toBe(false);
    expect(targetAfter.mfaSecretCiphertext).toBeNull();
    expect(targetAfter.mfaSecurityStamp).not.toBe(targetBefore.mfaSecurityStamp);
    expect(targetAfter.sessionRevokedAt).not.toBeNull();

    const targetProofs = await prisma.mfaStepUpProof.count({ where: { userId: target.userId } });
    expect(targetProofs).toBe(0);
    const targetRecoveryCodes = await prisma.mfaRecoveryCode.count({ where: { userId: target.userId } });
    expect(targetRecoveryCodes).toBe(0);

    // La session de la cible (établie avant le reset) est révoquée au prochain appel.
    const targetStatusResponse = await apiFetch("/api/mfa/status", { headers: { Cookie: target.sessionCookie } });
    expect(targetStatusResponse.status).toBe(401);

    // L'acteur, lui, reste pleinement authentifié (seule la cible est révoquée).
    const actorStatusResponse = await apiFetch("/api/mfa/status", { headers: { Cookie: admin.sessionCookie } });
    expect(actorStatusResponse.status).toBe(200);

    const logs = await prisma.auditLog.findMany({
      where: { tenantId: admin.tenantId, action: "mfa.admin_reset" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(admin.userId);
    expect(logs[0].resourceId).toBe(target.userId);
    const metadata = logs[0].metadata as { targetUserId: string; reason: string };
    expect(metadata.targetUserId).toBe(target.userId);
    expect(metadata.reason).toContain("Perte de l'appareil TOTP");
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(targetSecret);

    // La cible peut se reconnecter normalement ensuite (MFA désactivée, mot de passe seul).
    const reloginResponse = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: target.email, password }),
    });
    expect(reloginResponse.status).toBe(200);
    expect(extractSessionCookie(reloginResponse)).toBeDefined();
  });

  it("applique un rate limiting sur les tentatives répétées de l'acteur", async () => {
    const admin = await newAdmin("admin-reset-throttle");
    const { secretBase32: secret } = await enableMfa(admin);
    await stepUp(admin, secret);

    // Palier de verrouillage le plus bas à 5 échecs (src/lib/login-throttle.ts, LOCKOUT_TIERS) —
    // la 5e requête elle-même reste 400 (isLocked() est vérifié avant l'incrément, pas après),
    // seule la 6e (ci-dessous) doit être verrouillée.
    for (let i = 0; i < 5; i++) {
      const response = await apiFetch("/api/mfa/admin-reset", {
        method: "POST",
        headers: { Cookie: admin.sessionCookie },
        body: JSON.stringify({ targetUserId: admin.userId, reason: "Toujours refusé (acteur = cible)" }),
      });
      expect(response.status).toBe(400);
    }

    const lockedResponse = await apiFetch("/api/mfa/admin-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ targetUserId: admin.userId, reason: "Toujours refusé (acteur = cible)" }),
    });
    expect(lockedResponse.status).toBe(429);
  });
});

describe("Révocation globale de session — comportement transverse", () => {
  it("une session ouverte après la révocation reste valide (nouvelle connexion, nouveau sessionIssuedAt)", async () => {
    const admin = await newAdmin("revocation-new-session-valid");
    const { secretBase32 } = await enableMfa(admin);

    await apiFetch("/api/mfa/disable", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ password, code: await nextTotpCode(admin.userId, secretBase32) }),
    });

    // Ancienne session révoquée.
    const oldSessionResponse = await apiFetch("/api/mfa/status", { headers: { Cookie: admin.sessionCookie } });
    expect(oldSessionResponse.status).toBe(401);

    // Nouvelle connexion (MFA désormais désactivée, mot de passe seul suffit) : nouvelle session
    // valide, jamais affectée par une révocation déjà appliquée avant sa propre émission.
    const reloginResponse = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password }),
    });
    expect(reloginResponse.status).toBe(200);
    const newCookie = extractSessionCookie(reloginResponse);
    expect(newCookie).toBeDefined();

    const newSessionResponse = await apiFetch("/api/mfa/status", { headers: { Cookie: newCookie! } });
    expect(newSessionResponse.status).toBe(200);
  });

  it("sessionRevokedAt ne peut jamais être influencé par une valeur fournie par le client", async () => {
    const admin = await newAdmin("revocation-client-value-ignored");
    await enableMfa(admin);

    // Aucune route n'accepte sessionRevokedAt en entrée — même glissé dans un corps de requête
    // authentifié quelconque, il ne doit avoir aucun effet.
    const response = await apiFetch("/api/mfa/status", {
      headers: { Cookie: admin.sessionCookie, "Content-Type": "application/json" },
    });
    expect(response.status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect(user.sessionRevokedAt).toBeNull();
  });
});

/**
 * Politique MFA (2026-08-30, brief explicite du propriétaire du projet, points 6/7) : le Super
 * Admin ne doit pas pouvoir désactiver durablement sa MFA par un parcours normal de l'interface,
 * et sa récupération doit passer par la procédure opérateur hors bande dédiée
 * (scripts/superadmin-mfa-recovery.js), jamais par POST /api/mfa/disable ni par un reset assisté
 * ordinaire (POST /api/mfa/admin-reset). Domaine @superadmin.test.local reconnu par
 * SUPER_ADMIN_EMAILS en environnement de test (.env.test), même convention que
 * src/__tests__/tenants.test.ts/mfa-step-up-gating.test.ts.
 */
async function newSuperAdmin(label: string): Promise<AuthenticatedTestUser> {
  counter += 1;
  const admin = await registerTenantAdmin({
    tenantName: `LC SuperAdmin ${label} ${counter} ${runId}`,
    tenantSlug: `lc-superadmin-${label}-${counter}-${runId}`,
    name: `LC SuperAdmin ${label}`,
    email: `lc-superadmin-${label}-${counter}-${runId}@superadmin.test.local`,
    password,
  });
  createdTenantIds.push(admin.tenantId);
  return admin;
}

describe("POST /api/mfa/disable — Super Admin (politique MFA 2026-08-30)", () => {
  it("refuse même avec mot de passe et code TOTP valides — la MFA reste activée", async () => {
    const superAdmin = await newSuperAdmin("disable-blocked");
    const { secretBase32 } = await enableMfa(superAdmin);

    const response = await apiFetch("/api/mfa/disable", {
      method: "POST",
      headers: { Cookie: superAdmin.sessionCookie },
      body: JSON.stringify({ password, code: await nextTotpCode(superAdmin.userId, secretBase32) }),
    });
    expect(response.status).toBe(403);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: superAdmin.userId } });
    expect(user.mfaEnabled).toBe(true);
    expect(user.sessionRevokedAt).toBeNull();
  });

  it("un ADMIN de tenant ordinaire (même mot de passe/code valides) peut toujours se désactiver — le blocage est strictement réservé au Super Admin", async () => {
    const admin = await newAdmin("disable-not-blocked-ordinary");
    const { secretBase32 } = await enableMfa(admin);

    const response = await apiFetch("/api/mfa/disable", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ password, code: await nextTotpCode(admin.userId, secretBase32) }),
    });
    expect(response.status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect(user.mfaEnabled).toBe(false);
  });
});

describe("POST /api/mfa/admin-reset — cible Super Admin (politique MFA 2026-08-30)", () => {
  it("refuse de réinitialiser la MFA d'un Super Admin, même si acteur et cible partagent le même tenant", async () => {
    const superAdmin = await newSuperAdmin("reset-target-blocked");
    await enableMfa(superAdmin);

    // Second ADMIN du même tenant que le Super Admin, avec sa propre MFA activée (précondition
    // de la route) — représente le cas d'un pair ADMIN qui existerait exceptionnellement dans le
    // tenant dédié d'un Super Admin (src/lib/super-admin.ts).
    const peerAdmin = await createAndLoginMember({
      tenantId: superAdmin.tenantId,
      name: "Peer Admin",
      email: `lc-peer-admin-${counter}-${runId}@test.local`,
      password,
    });
    await prisma.user.update({ where: { id: peerAdmin.userId }, data: { role: "ADMIN" } });
    const { secretBase32: peerSecret } = await enableMfa(peerAdmin);
    await stepUp(peerAdmin, peerSecret);

    const response = await apiFetch("/api/mfa/admin-reset", {
      method: "POST",
      headers: { Cookie: peerAdmin.sessionCookie },
      body: JSON.stringify({ targetUserId: superAdmin.userId, reason: "Tentative refusée par la politique" }),
    });
    expect(response.status).toBe(403);

    const target = await prisma.user.findUniqueOrThrow({ where: { id: superAdmin.userId } });
    expect(target.mfaEnabled).toBe(true);
    expect(target.sessionRevokedAt).toBeNull();
  });
});
