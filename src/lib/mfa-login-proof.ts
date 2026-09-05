import crypto from "crypto";
import { prisma } from "@/lib/prisma";

/**
 * Correctif audit MFA (2026-09-05, brief explicite du propriétaire du projet) : ferme le
 * contournement trouvé lors de l'audit du même jour — `authorize()` (src/lib/auth.ts) n'a jamais
 * vérifié `User.mfaEnabled`, si bien qu'un appel direct à l'endpoint natif NextAuth
 * `POST /api/auth/callback/credentials` (jamais couvert par `src/proxy.ts`, dont le matcher ne
 * porte que sur `/dashboard`/`/settings`) obtenait une session complète avec seulement email +
 * mot de passe, même sur un compte MFA activée.
 *
 * Ce module ne vérifie jamais lui-même un code TOTP/de récupération — il atteste seulement
 * qu'un tel code a déjà été validé, à l'instant, par `POST /api/auth/mfa/verify` (les seules
 * primitives de vérification restent `verifyTotpToken`/`verifyRecoveryCode`, src/lib/mfa.ts).
 * La preuve elle-même est opaque (aléa serveur, jamais dérivée d'une donnée prévisible), à usage
 * unique (consommation atomique par CAS `updateMany`, même principe que
 * src/lib/login-throttle.ts) et extrêmement courte (60s — largement suffisant pour l'appel
 * `signIn()` synchrone émis immédiatement après le mint, dans la même requête HTTP) — jamais un
 * simple champ client non authentifié : sans ligne `MfaLoginProof` correspondante, non expirée,
 * non consommée, liée à cet utilisateur précis, `authorize()` refuse (voir src/lib/auth.ts).
 *
 * Seul le hash (SHA-256) est persisté, jamais la valeur en clair — même si ce hash n'est pas un
 * secret en tant que tel (la protection réelle vient de l'aléa/l'usage unique/la fraîcheur, pas
 * d'un pepper dédié comme pour les codes de récupération, src/lib/mfa.ts) : convention uniforme
 * avec le reste du module MFA, qui ne persiste jamais de valeur brute réutilisable telle quelle.
 */

const PROOF_VALIDITY_MS = 60 * 1000;
const PROOF_BYTE_LENGTH = 32;

function hashProof(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mint une preuve de login MFA pour cet utilisateur — à appeler uniquement après validation
 * réussie d'un code TOTP/de récupération (POST /api/auth/mfa/verify), jamais avant. Retourne la
 * valeur en clair, à transmettre immédiatement à `signIn("credentials", { ..., mfaProof })` —
 * jamais journalisée, jamais renvoyée au client. */
export async function createLoginMfaProof(userId: string): Promise<string> {
  const token = crypto.randomBytes(PROOF_BYTE_LENGTH).toString("base64url");
  const tokenHash = hashProof(token);
  const expiresAt = new Date(Date.now() + PROOF_VALIDITY_MS);

  await prisma.mfaLoginProof.create({
    data: { userId, tokenHash, expiresAt },
  });

  return token;
}

/**
 * Consomme (usage unique, atomique) une preuve de login MFA — appelée uniquement par
 * `authorize()` (src/lib/auth.ts) pour un compte `mfaEnabled: true`. Ne distingue jamais, dans sa
 * valeur de retour, une preuve absente/expirée/déjà consommée/liée à un autre utilisateur — toutes
 * quatre traitées identiquement (`false`), même principe que `hasValidStepUp()`
 * (src/lib/mfa-session.ts). `updateMany` conditionné (jamais un `findUnique` suivi d'un `update`
 * séparé) : deux appels concurrents avec la même preuve ne peuvent jamais tous deux réussir.
 */
export async function consumeLoginMfaProof(userId: string, token: string | undefined): Promise<boolean> {
  if (!token) {
    return false;
  }

  const tokenHash = hashProof(token);

  const result = await prisma.mfaLoginProof.updateMany({
    where: { tokenHash, userId, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });

  return result.count === 1;
}
