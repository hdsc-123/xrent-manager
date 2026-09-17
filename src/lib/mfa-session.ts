import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * Phase 3B MFA (2026-08-29, AGENTS.md brief) : gestion Postgres de la preuve de step-up
 * (`MfaStepUpProof`, prisma/schema.prisma) — séparé de src/lib/mfa.ts (module pur, sans accès
 * Prisma/session, voir son commentaire d'en-tête) et de src/lib/auth.ts (NextAuth). La preuve
 * est liée à `(userId, sessionId)` — `sessionId` provient du claim JWT ajouté cette phase (voir
 * src/lib/auth.ts) — jamais à un simple claim JWT non révocable : une ligne supprimée ici
 * invalide immédiatement le step-up, indépendamment de la durée de vie restante du JWT.
 */

const STEP_UP_VALIDITY_MS = 10 * 60 * 1000; // 10 minutes — fraîcheur exacte, voir le commentaire du modèle.

/** Crée ou rafraîchit la preuve de step-up pour cette session précise (upsert sur
 * @@unique([userId, sessionId]) — une seule preuve active par session, jamais accumulée). */
export async function createOrRefreshStepUpProof(userId: string, sessionId: string): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + STEP_UP_VALIDITY_MS);

  await prisma.mfaStepUpProof.upsert({
    where: { userId_sessionId: { userId, sessionId } },
    update: { verifiedAt: now, expiresAt },
    create: { userId, sessionId, expiresAt },
  });
}

/** Vérifie côté serveur qu'une preuve de step-up valide et non expirée existe pour cette
 * session précise — ne fait jamais confiance à un timestamp fourni par le client, seule la
 * ligne Postgres (et son `expiresAt`) fait foi. `sessionId` absent (JWT émis avant cette phase,
 * voir src/lib/auth.ts) ⇒ toujours refusé, jamais de repli permissif. */
export async function hasValidStepUp(userId: string, sessionId: string | undefined | null): Promise<boolean> {
  if (!sessionId) {
    return false;
  }

  const proof = await prisma.mfaStepUpProof.findUnique({
    where: { userId_sessionId: { userId, sessionId } },
  });

  return proof !== null && proof.expiresAt.getTime() > Date.now();
}

/**
 * Purge toutes les preuves de step-up d'un utilisateur — à appeler à chaque rotation de
 * `User.mfaSecurityStamp` (activation/désactivation/reset MFA), voir le commentaire du modèle
 * MfaStepUpProof. `tx` optionnel pour rester dans la même transaction que la rotation du stamp
 * (même convention que logAction, src/lib/audit.ts).
 */
export async function purgeStepUpProofs(userId: string, tx?: Prisma.TransactionClient): Promise<void> {
  const client = tx ?? prisma;
  await client.mfaStepUpProof.deleteMany({ where: { userId } });
}

/** Nouvelle valeur de `User.mfaSecurityStamp` — opaque, jamais réutilisée, jamais dérivée d'une
 * donnée prévisible (email, date...). */
export function generateMfaSecurityStamp(): string {
  return crypto.randomUUID();
}

/**
 * Phase 3C MFA (2026-08-29, brief explicite du propriétaire du projet) : message générique unique
 * pour tout refus de step-up sur les routes sensibles — jamais de distinction entre preuve
 * absente, expirée, ou liée à une autre session (toutes trois indiscernables depuis
 * hasValidStepUp() ci-dessus, qui les traite déjà identiquement).
 */
export const STEP_UP_REQUIRED_MESSAGE = "Vérification de sécurité supplémentaire (MFA) requise pour cette action.";

/**
 * Code machine-lisible stable accompagnant STEP_UP_REQUIRED_MESSAGE (2026-09-17, câblage UI du
 * step-up, brief explicite du propriétaire du projet) — permet au client de distinguer ce refus
 * précis d'un 403 ordinaire sans jamais changer le message affiché ni révéler la cause exacte :
 * preuve absente, expirée, ou liée à une autre session restent indiscernables entre elles, comme
 * avant l'introduction de ce code (voir hasValidStepUp ci-dessus, qui les traite déjà
 * identiquement). Le serveur reste seul juge : ce code n'est jamais accepté en entrée nulle
 * part, uniquement renvoyé en sortie par stepUpRequiredResponse() ci-dessous.
 */
export const STEP_UP_REQUIRED_CODE = "STEP_UP_REQUIRED";

/**
 * Réponse 403 unique pour tout refus de step-up — centralise un corps JSON jusqu'ici dupliqué à
 * l'identique dans 11 fichiers de routes (12 occurrences, `cash-register/[id]` en comptant deux).
 * Toujours le même statut, le même message, le même code — aucune route ne doit reconstruire ce
 * corps à la main.
 */
export function stepUpRequiredResponse(): NextResponse {
  return NextResponse.json({ error: STEP_UP_REQUIRED_MESSAGE, code: STEP_UP_REQUIRED_CODE }, { status: 403 });
}

/**
 * Gate à appeler par chacune des routes sensibles (avant toute mutation, après les contrôles de
 * rôle/permission/tenant/agence existants — jamais en remplacement). Un compte sans MFA activée
 * n'est jamais bloqué ici : MFA reste opt-in (SECURITY.md), aucune exigence artificielle. Un
 * compte avec MFA activée doit avoir une preuve de step-up fraîche pour *cette session précise*
 * (`user.sessionId`, jamais un identifiant fourni par le client).
 */
export async function stepUpRequiredAndMissing(user: {
  id: string;
  sessionId?: string;
  mfaEnabled: boolean;
}): Promise<boolean> {
  if (!user.mfaEnabled) {
    return false;
  }
  return !(await hasValidStepUp(user.id, user.sessionId));
}

/**
 * Purge complète de la MFA d'un compte + révocation globale de ses sessions — logique partagée
 * entre la désactivation personnelle (POST /api/mfa/disable) et le reset administrateur assisté
 * (POST /api/mfa/admin-reset), volontairement identique dans les deux cas (même brief : "purger
 * entièrement la MFA", "faire tourner mfaSecurityStamp", "renseigner sessionRevokedAt", "purger
 * MfaStepUpProof"). `mfaSecurityStamp` reste un marqueur de génération pour l'audit/la
 * documentation (jamais relu ailleurs pour une décision d'accès, voir prisma/schema.prisma) —
 * l'invalidation réelle vient de la suppression des lignes MfaStepUpProof (immédiate) et de
 * `sessionRevokedAt` (tue le JWT lui-même au prochain getSessionUser(), src/lib/authz.ts).
 * Exige `tx` : doit toujours faire partie de la même transaction que l'audit qui l'accompagne
 * (même convention que logAction avec tx, src/lib/audit.ts).
 */
/**
 * Politique MFA (2026-08-30, brief explicite du propriétaire du projet) : révocation globale de
 * session, sans purge MFA — distincte de purgeMfaAndRevokeSessions ci-dessous (réservée aux
 * changements de second facteur). Utilisée par un changement d'email/mot de passe (self-service
 * ou réinitialisation par un ADMIN, src/lib/users.ts), où aucun champ MFA n'est concerné. `tx`
 * optionnel : à fournir pour rester dans la même transaction que la mutation appelante quand une
 * transaction existe déjà, sinon écrit via le client global.
 */
export async function revokeAllSessions(userId: string, tx?: Prisma.TransactionClient): Promise<void> {
  const client = tx ?? prisma;
  await client.user.update({ where: { id: userId }, data: { sessionRevokedAt: new Date() } });
}

export async function purgeMfaAndRevokeSessions(userId: string, tx: Prisma.TransactionClient): Promise<void> {
  const now = new Date();
  await tx.user.update({
    where: { id: userId },
    data: {
      mfaEnabled: false,
      mfaSecretCiphertext: null,
      mfaSecretConfirmedAt: null,
      mfaLastUsedStep: null,
      mfaSecurityStamp: generateMfaSecurityStamp(),
      sessionRevokedAt: now,
    },
  });
  await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
  await tx.mfaStepUpProof.deleteMany({ where: { userId } });
}
