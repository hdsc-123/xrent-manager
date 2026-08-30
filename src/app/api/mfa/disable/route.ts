import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { verifyTotpToken, verifyRecoveryCode } from "@/lib/mfa";
import { decryptMfaSecret, MfaDecryptionError } from "@/lib/mfa-encryption";
import { purgeMfaAndRevokeSessions } from "@/lib/mfa-session";
import { isSuperAdminEmail } from "@/lib/super-admin";
import {
  getClientIp,
  ipThrottleKey,
  mfaDisableThrottleKey,
  isLocked,
  recordFailedAttempt,
  resetThrottle,
} from "@/lib/login-throttle";
import { logAction } from "@/lib/audit";
import { createSecurityNotification } from "@/lib/security-notifications";

interface DisableBody {
  password?: string;
  code?: string;
}

const RATE_LIMITED_MESSAGE = "Trop de tentatives. Réessayez plus tard.";
const INVALID_MESSAGE = "Mot de passe ou code invalide.";
const TOTP_CODE_RE = /^\d{6}$/;

/**
 * Phase 3C MFA (2026-08-29, brief explicite du propriétaire du projet) : désactivation
 * personnelle de la MFA — utilisateur de la session uniquement, jamais un autre utilisateur
 * (aucun id cible n'est accepté, même principe que POST /api/mfa/enroll). Exige mot de passe
 * **et** un code frais dans la même requête (TOTP 6 chiffres, ou un code de récupération non
 * utilisé comme alternative explicite) — jamais un mot de passe seul. Après succès, purge
 * complète (src/lib/mfa-session.ts, purgeMfaAndRevokeSessions) : MFA désactivée, secret/codes/
 * preuves de step-up purgés, `mfaSecurityStamp` roté, `sessionRevokedAt` renseigné — la session
 * courante (celle qui vient de désactiver) est elle-même révoquée dès la requête suivante,
 * comportement voulu (force une reconnexion propre après tout changement MFA sensible).
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

  if (!current.mfaEnabled) {
    return NextResponse.json({ error: "MFA non activée sur ce compte." }, { status: 400 });
  }

  // Politique MFA (2026-08-30, brief explicite du propriétaire du projet, point 6) : le Super
  // Admin ne doit pas pouvoir désactiver durablement sa MFA par un parcours normal de
  // l'interface — aucun mot de passe/code, aussi valides soient-ils, ne permet de contourner ce
  // blocage ici. Seule la procédure opérateur hors bande dédiée (scripts/superadmin-mfa-recovery.js,
  // jamais exposée en HTTP) peut réinitialiser la MFA d'un Super Admin — voir POST
  // /api/mfa/admin-reset pour le même principe côté reset assisté par un tiers.
  if (isSuperAdminEmail(user.email)) {
    return NextResponse.json(
      {
        error:
          "La MFA du Super Admin ne peut pas être désactivée depuis l'interface. Contactez un opérateur pour la procédure de récupération dédiée.",
      },
      { status: 403 }
    );
  }

  const ipKey = ipThrottleKey(getClientIp(request));
  const userKey = mfaDisableThrottleKey(user.id);
  if (await isLocked([ipKey, userKey])) {
    return NextResponse.json({ error: RATE_LIMITED_MESSAGE }, { status: 429 });
  }

  let body: DisableBody;
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

  async function onFailure(context: "password" | "totp" | "recovery"): Promise<void> {
    await recordFailedAttempt(ipKey);
    await recordFailedAttempt(userKey);
    if (await isLocked([userKey])) {
      await logAction({
        tenantId: current!.tenantId,
        userId: user!.id,
        action: "mfa.lockout",
        resource: "User",
        resourceId: user!.id,
        metadata: { context: `disable_${context}` },
      });
    }
  }

  if (!current.passwordHash || !(await bcrypt.compare(password, current.passwordHash))) {
    await onFailure("password");
    return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
  }

  const isTotpFormat = TOTP_CODE_RE.test(code);
  let viaRecoveryCode = false;

  if (isTotpFormat) {
    if (!current.mfaSecretCiphertext) {
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
  } else {
    const unusedCodes = await prisma.mfaRecoveryCode.findMany({
      where: { userId: user.id, usedAt: null },
      select: { id: true, codeHash: true },
    });
    const match = unusedCodes.find((candidate) => verifyRecoveryCode(code, candidate.codeHash));
    if (!match) {
      await onFailure("recovery");
      return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
    }
    viaRecoveryCode = true;
  }

  await prisma.$transaction(async (tx) => {
    await purgeMfaAndRevokeSessions(user.id, tx);
    await logAction(
      {
        tenantId: current.tenantId,
        userId: user.id,
        action: "mfa.disabled",
        resource: "User",
        resourceId: user.id,
        metadata: { viaRecoveryCode },
      },
      tx
    );
    await createSecurityNotification({ tenantId: current.tenantId, userId: user.id, type: "MFA_DISABLED" }, tx);
  });

  await resetThrottle([ipKey, userKey]);

  return NextResponse.json({ success: true });
}
