import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { getUserById } from "@/lib/users";
import { hasValidStepUp, purgeMfaAndRevokeSessions, STEP_UP_REQUIRED_MESSAGE } from "@/lib/mfa-session";
import { mfaAdminResetThrottleKey, isLocked, recordFailedAttempt, resetThrottle } from "@/lib/login-throttle";
import { logAction } from "@/lib/audit";

interface AdminResetBody {
  targetUserId?: string;
  reason?: string;
}

const RATE_LIMITED_MESSAGE = "Trop de tentatives. Réessayez plus tard.";

/**
 * Phase 3C MFA (2026-08-29, brief explicite du propriétaire du projet) : reset MFA
 * administrateur assisté — jamais un endpoint public, jamais un self-service. Contraintes,
 * toutes vérifiées côté serveur, jamais depuis une valeur fournie par le client :
 * - acteur authentifié, ADMIN (role === "ADMIN" strict, même convention que
 *   users/invitations/permission-groups/tenants/audit/data-reset — SECURITY.md section 4) ;
 * - acteur avec sa propre MFA activée (sinon 403) — une action de cette gravité sur le compte
 *   d'un tiers exige que l'acteur lui-même ait un second facteur, même si MFA reste opt-in pour
 *   les actions courantes (voir stepUpRequiredAndMissing, qui ne s'applique qu'aux comptes déjà
 *   MFA — ici la MFA de l'acteur est une précondition explicite de la route, pas un simple gate) ;
 * - preuve de step-up fraîche de l'acteur (hasValidStepUp, jamais un code fourni directement dans
 *   cette requête — l'acteur doit avoir appelé POST /api/mfa/step-up/verify au préalable) ;
 * - cible résolue côté serveur via getUserById(actor.tenantId, targetUserId) — jamais un tenant
 *   différent, jamais l'acteur lui-même ;
 * - motif obligatoire, conservé dans l'audit (pas un secret, comparable au motif d'annulation
 *   d'une facture de dégâts, src/app/api/damage-invoices/[id]/cancel/route.ts).
 * Purge entièrement la MFA de la cible (purgeMfaAndRevokeSessions, partagé avec la désactivation
 * personnelle) : secret/codes/preuves de step-up purgés, mfaSecurityStamp roté,
 * sessionRevokedAt renseigné — toutes les sessions de la cible sont invalidées au prochain appel.
 */
export async function POST(request: Request) {
  const actor = await getSessionUser();
  if (!actor) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  const throttleKey = mfaAdminResetThrottleKey(actor.id);
  if (await isLocked([throttleKey])) {
    return NextResponse.json({ error: RATE_LIMITED_MESSAGE }, { status: 429 });
  }

  let body: AdminResetBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const targetUserId = typeof body.targetUserId === "string" ? body.targetUserId : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  if (!targetUserId || !reason) {
    await recordFailedAttempt(throttleKey);
    return NextResponse.json({ error: "targetUserId et reason sont requis." }, { status: 400 });
  }

  if (targetUserId === actor.id) {
    await recordFailedAttempt(throttleKey);
    return NextResponse.json(
      { error: "Impossible de réinitialiser sa propre MFA via cette procédure." },
      { status: 400 }
    );
  }

  // Acteur : la MFA doit être activée sur son propre compte pour déclencher cette action —
  // précondition explicite de la route, distincte du gate opt-in habituel (voir le commentaire
  // d'en-tête). `getSessionUser()` relit déjà mfaEnabled frais.
  if (!actor.mfaEnabled) {
    await recordFailedAttempt(throttleKey);
    return NextResponse.json(
      { error: "Cette action nécessite que votre propre compte administrateur ait activé la MFA." },
      { status: 403 }
    );
  }

  if (!actor.sessionId || !(await hasValidStepUp(actor.id, actor.sessionId))) {
    await recordFailedAttempt(throttleKey);
    return NextResponse.json({ error: STEP_UP_REQUIRED_MESSAGE }, { status: 403 });
  }

  // Cible résolue côté serveur, strictement scopée au tenant de l'acteur (IDOR) — jamais un
  // tenant/role/permission accepté depuis le client au-delà de l'identifiant lui-même.
  const target = await getUserById(actor.tenantId, targetUserId);
  if (!target) {
    await recordFailedAttempt(throttleKey);
    return NextResponse.json({ error: "Utilisateur introuvable." }, { status: 404 });
  }

  await prisma.$transaction(async (tx) => {
    await purgeMfaAndRevokeSessions(target.id, tx);
    await logAction(
      {
        tenantId: actor.tenantId,
        userId: actor.id,
        action: "mfa.admin_reset",
        resource: "User",
        resourceId: target.id,
        metadata: { targetUserId: target.id, reason },
      },
      tx
    );
  });

  await resetThrottle([throttleKey]);

  return NextResponse.json({ success: true });
}
