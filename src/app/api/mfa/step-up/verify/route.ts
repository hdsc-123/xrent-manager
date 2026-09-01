import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { verifyTotpToken } from "@/lib/mfa";
import { decryptMfaSecret, MfaDecryptionError } from "@/lib/mfa-encryption";
import { createOrRefreshStepUpProof } from "@/lib/mfa-session";
import { getClientIp, ipThrottleKey, isLocked, recordFailedAttempt, resetThrottle } from "@/lib/login-throttle";
import { logAction } from "@/lib/audit";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_AUTHENTICATED_JSON_BODY_BYTES } from "@/lib/request-guards";

interface StepUpBody {
  code?: string;
}

const RATE_LIMITED_MESSAGE = "Trop de tentatives. Réessayez plus tard.";

/**
 * Phase 3B MFA (2026-08-29, AGENTS.md brief) : mécanisme générique de step-up MFA — re-prouver
 * la possession du TOTP pour la session courante, indépendamment de la connexion initiale.
 * Crée/rafraîchit une `MfaStepUpProof` liée à `(userId, sessionId)` (voir src/lib/mfa-session.ts)
 * — le `sessionId` provient exclusivement du JWT serveur (`getSessionUser()`), jamais d'une
 * valeur envoyée par le client. **Volontairement non câblée sur aucune route métier à ce stade**
 * (AGENTS.md, "Ne crée pas encore : ... step-up sur toutes les routes métier") — cette route
 * expose seulement la primitive, prête à être consommée par une future action critique via
 * `hasValidStepUp()`. Codes de récupération non acceptés ici (réservés à la connexion en cas de
 * perte de l'appareil TOTP, pas à un step-up de routine).
 */
export async function POST(request: Request) {
  if (isRequestBodyTooLarge(request, MAX_AUTHENTICATED_JSON_BODY_BYTES)) {
    return requestBodyTooLargeResponse(MAX_AUTHENTICATED_JSON_BODY_BYTES);
  }

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (!user.sessionId) {
    // JWT émis avant l'introduction de ce claim (voir src/lib/auth.ts) — pas de session
    // exploitable pour lier une preuve, l'utilisateur doit se reconnecter normalement.
    return NextResponse.json(
      { error: "Session invalide pour le step-up, reconnectez-vous." },
      { status: 401 }
    );
  }

  const current = await prisma.user.findUnique({
    where: { id: user.id },
    select: { tenantId: true, mfaEnabled: true, mfaSecretCiphertext: true, mfaLastUsedStep: true },
  });
  if (!current) {
    return NextResponse.json({ error: "Utilisateur introuvable." }, { status: 404 });
  }

  if (!current.mfaEnabled || !current.mfaSecretCiphertext) {
    return NextResponse.json({ error: "MFA non activée sur ce compte." }, { status: 400 });
  }

  const ipKey = ipThrottleKey(getClientIp(request));
  const userKey = `mfa-step-up:${user.id}`;
  if (await isLocked([ipKey, userKey])) {
    return NextResponse.json({ error: RATE_LIMITED_MESSAGE }, { status: 429 });
  }

  let body: StepUpBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return NextResponse.json({ error: "code est requis." }, { status: 400 });
  }

  let secretBase32: string;
  try {
    secretBase32 = decryptMfaSecret(current.mfaSecretCiphertext);
  } catch (error) {
    if (error instanceof MfaDecryptionError) {
      return NextResponse.json({ error: "Configuration MFA invalide." }, { status: 400 });
    }
    throw error;
  }

  const result = await verifyTotpToken({
    secretBase32,
    token: code,
    afterTimeStep: current.mfaLastUsedStep ?? undefined,
  });

  if (!result.valid) {
    await recordFailedAttempt(ipKey);
    await recordFailedAttempt(userKey);
    if (await isLocked([userKey])) {
      await logAction({
        tenantId: current.tenantId,
        userId: user.id,
        action: "mfa.lockout",
        resource: "User",
        resourceId: user.id,
        metadata: { context: "step_up" },
      });
    }
    return NextResponse.json({ error: "Code invalide." }, { status: 400 });
  }

  await prisma.user.update({ where: { id: user.id }, data: { mfaLastUsedStep: result.timeStep } });
  await createOrRefreshStepUpProof(user.id, user.sessionId);
  await resetThrottle([ipKey, userKey]);

  await logAction({
    tenantId: current.tenantId,
    userId: user.id,
    action: "mfa.step_up.verified",
    resource: "User",
    resourceId: user.id,
  });

  return NextResponse.json({ verified: true });
}
