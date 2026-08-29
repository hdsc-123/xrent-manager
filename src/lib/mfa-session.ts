import crypto from "crypto";
import type { Prisma } from "@prisma/client";
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
