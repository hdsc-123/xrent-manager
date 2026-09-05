import { NextResponse } from "next/server";
import { AuthError } from "next-auth";
import { signIn, verifyLoginPassword } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { verifyTotpToken, verifyRecoveryCode } from "@/lib/mfa";
import { decryptMfaSecret, MfaDecryptionError } from "@/lib/mfa-encryption";
import { createLoginMfaProof } from "@/lib/mfa-login-proof";
import {
  getClientIp,
  ipThrottleKey,
  mfaLoginThrottleKey,
  mfaRecoveryThrottleKey,
  isLocked,
  recordFailedAttempt,
  resetThrottle,
} from "@/lib/login-throttle";
import { logAction } from "@/lib/audit";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_PUBLIC_JSON_BODY_BYTES } from "@/lib/request-guards";

interface MfaVerifyBody {
  email?: string;
  password?: string;
  tenantId?: string;
  rememberMe?: boolean;
  code?: string;
}

const RATE_LIMITED_MESSAGE = "Trop de tentatives. Réessayez plus tard.";
const INVALID_MESSAGE = "Identifiants ou code invalides.";
const TOTP_CODE_RE = /^\d{6}$/;

/**
 * Phase 3B MFA (2026-08-29, AGENTS.md brief) : second temps du login pour un compte MFA
 * (voir POST /api/auth/login, `requiresMfa: true`). Revérifie mot de passe **et** code — jamais
 * l'un sans l'autre, jamais de session créée avant que les deux soient valides. Distingue un
 * code TOTP (6 chiffres) d'un code de récupération (tout autre format) pour appliquer la bonne
 * clé de throttle dédiée (spec explicite : catégories séparées) ; jamais de distinction dans le
 * message d'erreur entre "mauvais mot de passe"/"mauvais code"/"compte inexistant" (même
 * principe que le 401 générique de /api/auth/login, SECURITY.md section 3).
 */
export async function POST(request: Request) {
  if (isRequestBodyTooLarge(request, MAX_PUBLIC_JSON_BODY_BYTES)) {
    return requestBodyTooLargeResponse(MAX_PUBLIC_JSON_BODY_BYTES);
  }

  let body: MfaVerifyBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { email, password, tenantId, rememberMe = true } = body;
  const code = typeof body.code === "string" ? body.code.trim() : "";

  if (!email || !password || !code) {
    return NextResponse.json({ error: "email, password et code sont requis." }, { status: 400 });
  }

  const isTotpFormat = TOTP_CODE_RE.test(code);
  const ipKey = ipThrottleKey(getClientIp(request));
  const codeKey = isTotpFormat ? mfaLoginThrottleKey(email) : mfaRecoveryThrottleKey(email);

  if (await isLocked([ipKey, codeKey])) {
    return NextResponse.json({ error: RATE_LIMITED_MESSAGE }, { status: 429 });
  }

  const verifiedUser = await verifyLoginPassword(email, password, tenantId);
  if (!verifiedUser || !verifiedUser.mfaEnabled) {
    await recordFailedAttempt(ipKey);
    await recordFailedAttempt(codeKey);
    return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
  }

  const current = await prisma.user.findUnique({
    where: { id: verifiedUser.id },
    select: { mfaSecretCiphertext: true, mfaLastUsedStep: true },
  });
  if (!current?.mfaSecretCiphertext) {
    return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
  }

  async function onCodeInvalid(context: "totp" | "recovery"): Promise<void> {
    await recordFailedAttempt(ipKey);
    await recordFailedAttempt(codeKey);
    if (await isLocked([codeKey])) {
      await logAction({
        tenantId: verifiedUser!.tenantId,
        userId: verifiedUser!.id,
        action: "mfa.lockout",
        resource: "User",
        resourceId: verifiedUser!.id,
        metadata: { context: `login_${context}` },
      });
    }
  }

  let viaRecoveryCode = false;

  if (isTotpFormat) {
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
      await onCodeInvalid("totp");
      return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
    }

    await prisma.user.update({
      where: { id: verifiedUser.id },
      data: { mfaLastUsedStep: result.timeStep },
    });
  } else {
    const unusedCodes = await prisma.mfaRecoveryCode.findMany({
      where: { userId: verifiedUser.id, usedAt: null },
      select: { id: true, codeHash: true },
    });

    const match = unusedCodes.find((candidate) => verifyRecoveryCode(code, candidate.codeHash));
    if (!match) {
      await onCodeInvalid("recovery");
      return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
    }

    await prisma.mfaRecoveryCode.update({
      where: { id: match.id },
      data: { usedAt: new Date() },
    });
    viaRecoveryCode = true;
  }

  // Correctif audit MFA (2026-09-05) : mint une preuve de login à usage unique une fois le code
  // TOTP/de récupération ci-dessus réellement validé — c'est cette preuve, jamais le code
  // lui-même, qu'authorize() (src/lib/auth.ts) exige et consomme pour émettre le JWT (voir
  // src/lib/mfa-login-proof.ts). Sans elle, un compte mfaEnabled ne peut plus obtenir de session
  // via aucune route, y compris l'endpoint natif NextAuth appelé ci-dessous par signIn().
  const mfaProof = await createLoginMfaProof(verifiedUser.id);

  try {
    await signIn("credentials", {
      email,
      password,
      rememberMe: String(rememberMe),
      tenantId: verifiedUser.tenantId,
      mfaProof,
      redirect: false,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      await recordFailedAttempt(ipKey);
      await recordFailedAttempt(codeKey);
      return NextResponse.json({ error: INVALID_MESSAGE }, { status: 401 });
    }
    throw error;
  }

  await resetThrottle([ipKey, codeKey]);

  await logAction({
    tenantId: verifiedUser.tenantId,
    userId: verifiedUser.id,
    action: "mfa.login.succeeded",
    resource: "User",
    resourceId: verifiedUser.id,
    metadata: { viaRecoveryCode },
  });

  return NextResponse.json({
    user: {
      id: verifiedUser.id,
      tenantId: verifiedUser.tenantId,
      email: verifiedUser.email,
      name: verifiedUser.name,
      role: verifiedUser.role,
    },
  });
}
