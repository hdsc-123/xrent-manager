import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { verifyTotpToken, generateRecoveryCodes, hashRecoveryCode } from "@/lib/mfa";
import { decryptMfaSecret, MfaDecryptionError } from "@/lib/mfa-encryption";
import {
  getClientIp,
  ipThrottleKey,
  mfaRecoveryRegenThrottleKey,
  isLocked,
  recordFailedAttempt,
  resetThrottle,
} from "@/lib/login-throttle";
import { logAction } from "@/lib/audit";
import { createSecurityNotification } from "@/lib/security-notifications";

interface RegenerateBody {
  password?: string;
  code?: string;
}

const RATE_LIMITED_MESSAGE = "Trop de tentatives. Réessayez plus tard.";
const INVALID_MESSAGE = "Mot de passe ou code invalide.";
const TOTP_CODE_RE = /^\d{6}$/;

/**
 * Phase 3C MFA (2026-08-29, brief explicite du propriétaire du projet) : régénération contrôlée
 * des codes de récupération — utilisateur de la session uniquement. Exige mot de passe **et** un
 * code TOTP valide dans la même requête (jamais un code de récupération ici : contrairement à
 * POST /api/mfa/disable, cette route ne sert que si l'appareil TOTP est toujours accessible —
 * brief explicite, pas d'alternative par code de récupération pour cette action). Invalide tous
 * les anciens codes avant d'en créer de nouveaux, retournés en clair une seule fois — jamais
 * relisibles ensuite (seuls leurs hashes sont persistés). Ne rote pas `mfaSecurityStamp` et ne
 * révoque aucune session : contrairement à la désactivation/au reset (qui invalident un second
 * facteur entier), cette action ne fait que remplacer un moyen de secours, le TOTP actif reste
 * inchangé — hors périmètre explicite du brief pour cette route précise.
 */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const current = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      tenantId: true,
      mfaEnabled: true,
      passwordHash: true,
      mfaSecretCiphertext: true,
      mfaLastUsedStep: true,
    },
  });
  if (!current) {
    return NextResponse.json({ error: "Utilisateur introuvable." }, { status: 404 });
  }

  if (!current.mfaEnabled || !current.mfaSecretCiphertext) {
    return NextResponse.json({ error: "MFA non activée sur ce compte." }, { status: 400 });
  }

  const ipKey = ipThrottleKey(getClientIp(request));
  const userKey = mfaRecoveryRegenThrottleKey(user.id);
  if (await isLocked([ipKey, userKey])) {
    return NextResponse.json({ error: RATE_LIMITED_MESSAGE }, { status: 429 });
  }

  let body: RegenerateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const password = typeof body.password === "string" ? body.password : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!password || !code) {
    return NextResponse.json({ error: "password et code sont requis." }, { status: 400 });
  }

  async function onFailure(context: "password" | "totp"): Promise<void> {
    await recordFailedAttempt(ipKey);
    await recordFailedAttempt(userKey);
    if (await isLocked([userKey])) {
      await logAction({
        tenantId: current!.tenantId,
        userId: user!.id,
        action: "mfa.lockout",
        resource: "User",
        resourceId: user!.id,
        metadata: { context: `recovery_codes_regenerate_${context}` },
      });
    }
  }

  if (!current.passwordHash || !(await bcrypt.compare(password, current.passwordHash))) {
    await onFailure("password");
    return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
  }

  if (!TOTP_CODE_RE.test(code)) {
    await onFailure("totp");
    return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
  }

  let secretBase32: string;
  try {
    secretBase32 = decryptMfaSecret(current.mfaSecretCiphertext);
  } catch (error) {
    if (error instanceof MfaDecryptionError) {
      return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
    }
    throw error;
  }

  const result = await verifyTotpToken({
    secretBase32,
    token: code,
    afterTimeStep: current.mfaLastUsedStep ?? undefined,
  });
  if (!result.valid) {
    await onFailure("totp");
    return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
  }

  const recoveryCodes = generateRecoveryCodes();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { mfaLastUsedStep: result.timeStep } });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.mfaRecoveryCode.createMany({
      data: recoveryCodes.map((recoveryCode) => ({
        userId: user.id,
        codeHash: hashRecoveryCode(recoveryCode),
      })),
    });
    await createSecurityNotification(
      { tenantId: current.tenantId, userId: user.id, type: "MFA_RECOVERY_CODES_REGENERATED" },
      tx
    );
  });

  await resetThrottle([ipKey, userKey]);

  await logAction({
    tenantId: current.tenantId,
    userId: user.id,
    action: "mfa.recovery_codes.regenerated",
    resource: "User",
    resourceId: user.id,
  });

  // Retournés en clair une seule fois, jamais journalisés (logAction ci-dessus ne les reçoit
  // pas) — seuls les hashes sont persistés (voir hashRecoveryCode, src/lib/mfa.ts).
  return NextResponse.json({ recoveryCodes });
}
