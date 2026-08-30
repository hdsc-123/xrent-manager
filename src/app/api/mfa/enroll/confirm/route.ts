import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { verifyTotpToken, generateRecoveryCodes, hashRecoveryCode } from "@/lib/mfa";
import { decryptMfaSecret, MfaDecryptionError } from "@/lib/mfa-encryption";
import { generateMfaSecurityStamp } from "@/lib/mfa-session";
import { mfaEnrollConfirmThrottleKey, isLocked, recordFailedAttempt, resetThrottle } from "@/lib/login-throttle";
import { logAction } from "@/lib/audit";
import { createSecurityNotification } from "@/lib/security-notifications";

interface ConfirmBody {
  code?: string;
}

const RATE_LIMITED_MESSAGE = "Trop de tentatives. Réessayez plus tard.";

/**
 * Phase 3B MFA (2026-08-29, AGENTS.md brief) : confirme l'enrôlement en attente (créé par
 * POST /api/mfa/enroll) — exige un code TOTP valide avant d'activer quoi que ce soit. Rate
 * limité par utilisateur (clé dédiée, distincte du login) *avant* toute comparaison de code,
 * jamais après (même principe que POST /api/auth/login, SECURITY.md section 33).
 */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const throttleKey = mfaEnrollConfirmThrottleKey(user.id);
  if (await isLocked([throttleKey])) {
    return NextResponse.json({ error: RATE_LIMITED_MESSAGE }, { status: 429 });
  }

  let body: ConfirmBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return NextResponse.json({ error: "code est requis." }, { status: 400 });
  }

  const current = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      tenantId: true,
      mfaEnabled: true,
      mfaSecretCiphertext: true,
      mfaLastUsedStep: true,
    },
  });
  if (!current) {
    return NextResponse.json({ error: "Utilisateur introuvable." }, { status: 404 });
  }

  if (current.mfaEnabled) {
    return NextResponse.json({ error: "MFA déjà activée sur ce compte." }, { status: 409 });
  }

  if (!current.mfaSecretCiphertext) {
    return NextResponse.json({ error: "Aucun enrôlement MFA en attente." }, { status: 400 });
  }

  let secretBase32: string;
  try {
    secretBase32 = decryptMfaSecret(current.mfaSecretCiphertext);
  } catch (error) {
    if (error instanceof MfaDecryptionError) {
      return NextResponse.json({ error: "Enrôlement MFA invalide, recommencez-le." }, { status: 400 });
    }
    throw error;
  }

  const result = await verifyTotpToken({
    secretBase32,
    token: code,
    afterTimeStep: current.mfaLastUsedStep ?? undefined,
  });

  if (!result.valid) {
    await recordFailedAttempt(throttleKey);
    if (await isLocked([throttleKey])) {
      await logAction({
        tenantId: current.tenantId,
        userId: user.id,
        action: "mfa.lockout",
        resource: "User",
        resourceId: user.id,
        metadata: { context: "enroll_confirm" },
      });
    }
    await logAction({
      tenantId: current.tenantId,
      userId: user.id,
      action: "mfa.enroll.failed",
      resource: "User",
      resourceId: user.id,
    });
    return NextResponse.json({ error: "Code invalide." }, { status: 400 });
  }

  const recoveryCodes = generateRecoveryCodes();
  const newStamp = generateMfaSecurityStamp();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: true,
        mfaSecretConfirmedAt: new Date(),
        mfaSecurityStamp: newStamp,
        mfaLastUsedStep: result.timeStep,
      },
    });

    await tx.mfaRecoveryCode.createMany({
      data: recoveryCodes.map((recoveryCode) => ({
        userId: user.id,
        codeHash: hashRecoveryCode(recoveryCode),
      })),
    });

    // Aucune preuve de step-up ne devrait exister à ce stade (compte qui vient d'activer MFA
    // pour la première fois) — purge défensive, même garantie que pour un reset futur.
    await tx.mfaStepUpProof.deleteMany({ where: { userId: user.id } });

    // Politique MFA (2026-08-30) : notification de sécurité, même transaction que l'activation.
    await createSecurityNotification({ tenantId: current.tenantId, userId: user.id, type: "MFA_ENABLED" }, tx);
  });

  await resetThrottle([throttleKey]);

  await logAction({
    tenantId: current.tenantId,
    userId: user.id,
    action: "mfa.enroll.confirmed",
    resource: "User",
    resourceId: user.id,
  });

  // Les codes de récupération en clair ne sont retournés qu'une seule fois, à cet instant
  // précis — jamais journalisés (logAction ci-dessus ne les reçoit pas), jamais relisibles
  // ensuite (seuls leurs hashes sont persistés, voir MfaRecoveryCode.codeHash).
  return NextResponse.json({ recoveryCodes });
}
