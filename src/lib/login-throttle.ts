import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

/**
 * Rate limiting d'authentification — implémentation de la spécification validée
 * (SECURITY.md section 33, cadrage 2026-08-24). PostgreSQL, pas Redis (décision explicite).
 *
 * Une ligne `LoginThrottle` par clé (`ip:<adresse>` ou `email:<email normalisé>`). Fenêtre
 * glissante de 15 minutes : un échec en dehors de la fenêtre courante réinitialise le
 * compteur à 1 plutôt que de l'incrémenter indéfiniment. Verrouillage progressif par palier
 * (5/10/15 échecs) plutôt qu'un blocage unique — un attaquant patient reste ralenti, un
 * utilisateur légitime distrait n'est jamais bloqué durablement pour quelques fautes de frappe.
 *
 * Vérifié à la fois par IP et par identifiant (voir POST /api/auth/login) pour résister au
 * contournement par changement d'email à chaque tentative : le verrou IP s'applique quel que
 * soit l'email essayé.
 *
 * Verrou de ligne explicite (`SELECT ... FOR UPDATE`, dans une transaction) plutôt qu'un simple
 * `updateMany` conditionnel : contrairement au throttle horaire `Tenant.lastAlertCheckAt`
 * (src/lib/scheduled-tasks.ts, une seule instruction suffit à une décision binaire), un
 * compteur qui s'incrémente doit lire sa valeur courante pour décider entre "incrémenter" et
 * "réinitialiser la fenêtre" — même primitive que `lockVehicleForUpdate`/`lockInvoiceForUpdate`
 * déjà en usage dans ce projet pour les mutations concurrentes (src/lib/vehicles.ts,
 * src/lib/payments.ts).
 */

const WINDOW_MS = 15 * 60 * 1000;

interface LockoutTier {
  threshold: number;
  lockMs: number;
}

// Palier progressif : plus les échecs s'accumulent dans la fenêtre courante, plus le blocage
// s'allonge. Plafonné à 15 minutes (borne haute documentée) pour ne jamais bloquer un
// utilisateur légitime de façon disproportionnée après expiration naturelle de la fenêtre.
const LOCKOUT_TIERS: LockoutTier[] = [
  { threshold: 15, lockMs: 15 * 60 * 1000 },
  { threshold: 10, lockMs: 5 * 60 * 1000 },
  { threshold: 5, lockMs: 60 * 1000 },
];

function computeLockMs(failCount: number): number | null {
  const tier = LOCKOUT_TIERS.find((candidate) => failCount >= candidate.threshold);
  return tier ? tier.lockMs : null;
}

export function ipThrottleKey(ip: string): string {
  return `ip:${ip}`;
}

export function emailThrottleKey(email: string): string {
  return `email:${email.trim().toLowerCase()}`;
}

/**
 * Phase 3B MFA (2026-08-29, AGENTS.md brief) : clés de throttle dédiées, distinctes de
 * `emailThrottleKey`/`ipThrottleKey` ci-dessus — un contexte de connexion MFA (code TOTP après
 * mot de passe déjà validé) ne doit jamais partager son compteur avec le mot de passe seul,
 * pour ne jamais masquer/diluer l'un par l'autre. Trois catégories séparées (spec explicite) :
 * connexion par code TOTP, connexion par code de récupération, confirmation d'enrôlement.
 * Réutilisent les mêmes primitives génériques (`isLocked`/`recordFailedAttempt`/
 * `resetThrottle`, toutes scopées sur `keys: string[]`) — aucune nouvelle logique de fenêtre/
 * palier, uniquement de nouvelles clés.
 */
export function mfaLoginThrottleKey(email: string): string {
  return `mfa-login:${email.trim().toLowerCase()}`;
}

export function mfaRecoveryThrottleKey(email: string): string {
  return `mfa-recovery:${email.trim().toLowerCase()}`;
}

export function mfaEnrollConfirmThrottleKey(userId: string): string {
  return `mfa-enroll-confirm:${userId}`;
}

/**
 * Phase 3C MFA (2026-08-29, brief explicite du propriétaire du projet) : trois clés
 * supplémentaires, même principe de séparation que ci-dessus — chacune de ces actions revérifie
 * un mot de passe et/ou un code dans la même requête, jamais partagé avec un autre compteur.
 */
export function mfaDisableThrottleKey(userId: string): string {
  return `mfa-disable:${userId}`;
}

export function mfaRecoveryRegenThrottleKey(userId: string): string {
  return `mfa-recovery-regen:${userId}`;
}

/** Reset admin-assisté : ne compare aucun secret (le step-up de l'acteur est déjà vérifié via
 * MfaStepUpProof), mais reste rate-limité pour freiner un abus répété de la route elle-même
 * (tentatives de cible invalide, tenant différent, etc.), clé par acteur. */
export function mfaAdminResetThrottleKey(actorUserId: string): string {
  return `mfa-admin-reset:${actorUserId}`;
}

/**
 * Adresse IP du client. `x-forwarded-for` peut contenir plusieurs adresses séparées par des
 * virgules (proxys successifs, ex. `client, proxy1, proxy2`). **Correctif revue OWASP Phase 6
 * (2026-08-31)** : la première valeur (la plus à gauche) est entièrement fournie par le client
 * lui-même — un client peut y écrire n'importe quoi, y compris une valeur différente à chaque
 * requête, ce qui rendait le verrou par IP totalement contournable (chaque tentative retombant
 * sur une clé `ip:` différente). Un proxy de confiance placé devant l'application **ajoute**
 * toujours sa propre observation en fin de liste plutôt que de réécrire les valeurs déjà
 * présentes ; c'est donc la **dernière** valeur (la plus proche du serveur, déposée par le
 * dernier saut réseau réellement traversé) qui reflète l'adresse effectivement connectée,
 * jamais falsifiable par le client (il ne peut qu'ajouter des valeurs *avant* celle-ci, jamais
 * après). Hypothèse : au plus un proxy de confiance en amont (conforme à l'hébergement PaaS
 * visé, ARCHITECTURE.md section 16 — Render/Railway placent tous deux l'application derrière un
 * unique proxy d'edge qui ajoute l'IP réelle du client). En développement/test local (aucun
 * proxy, un seul poste), l'en-tête ne contient jamais qu'une seule valeur : ce correctif n'y
 * change donc rien (dernière valeur === première valeur).
 */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const parts = forwardedFor.split(",").map((part) => part.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

/** Lecture seule — jamais utilisée pour décider d'un incrément, seulement pour bloquer une
 * tentative avant même de vérifier le mot de passe. */
export async function isLocked(keys: string[]): Promise<boolean> {
  const rows = await prisma.loginThrottle.findMany({
    where: { key: { in: keys }, lockedUntil: { gt: new Date() } },
    select: { id: true },
    take: 1,
  });
  return rows.length > 0;
}

async function lockOrCreateRow(
  tx: Prisma.TransactionClient,
  key: string
): Promise<{ id: string; failCount: number; windowStart: Date }> {
  const locked = await tx.$queryRaw<{ id: string; failCount: number; windowStart: Date }[]>`
    SELECT id, "failCount", "windowStart" FROM "LoginThrottle" WHERE key = ${key} FOR UPDATE
  `;
  if (locked.length > 0) {
    return locked[0];
  }

  // Ligne inexistante : deux requêtes concurrentes pour la même clé peuvent toutes deux
  // atteindre ce point (aucun verrou ne peut être posé sur une ligne qui n'existe pas encore).
  // La contrainte unique sur `key` tranche la course ; la perdante récupère la ligne du
  // gagnant par un nouveau SELECT ... FOR UPDATE plutôt que d'échouer (même principe que le
  // remappage P2002 déjà en usage pour acceptInvitation, src/lib/invitations.ts).
  try {
    const created = await tx.loginThrottle.create({
      data: { key, failCount: 0, windowStart: new Date() },
      select: { id: true, failCount: true, windowStart: true },
    });
    return created;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002"
    ) {
      const retried = await tx.$queryRaw<{ id: string; failCount: number; windowStart: Date }[]>`
        SELECT id, "failCount", "windowStart" FROM "LoginThrottle" WHERE key = ${key} FOR UPDATE
      `;
      if (retried.length > 0) return retried[0];
    }
    throw error;
  }
}

/** Enregistre un échec pour une clé (IP ou email) — jamais le mot de passe, jamais l'identité
 * complète, uniquement la clé de throttle déjà dérivée (SECURITY.md section 12). */
export async function recordFailedAttempt(key: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await lockOrCreateRow(tx, key);
    const now = new Date();
    const windowExpired = now.getTime() - row.windowStart.getTime() > WINDOW_MS;
    const nextFailCount = windowExpired ? 1 : row.failCount + 1;
    const nextWindowStart = windowExpired ? now : row.windowStart;
    const lockMs = computeLockMs(nextFailCount);

    await tx.loginThrottle.update({
      where: { id: row.id },
      data: {
        failCount: nextFailCount,
        windowStart: nextWindowStart,
        lockedUntil: lockMs ? new Date(now.getTime() + lockMs) : null,
      },
    });
  });
}

/** Connexion réussie (mot de passe vérifié, y compris l'étape intermédiaire de sélection de
 * tenant — voir POST /api/auth/login) : remise à zéro complète, jamais une simple réduction,
 * pour qu'un utilisateur légitime retrouve immédiatement un accès normal. */
export async function resetThrottle(keys: string[]): Promise<void> {
  await prisma.loginThrottle.updateMany({
    where: { key: { in: keys } },
    data: { failCount: 0, windowStart: new Date(), lockedUntil: null },
  });
}
