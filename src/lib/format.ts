/** pricePerDay/totalPrice sont stockés en entiers (plus petite unité monétaire, ex. centimes). */
export function formatMoney(amountInSmallestUnit: number, currency: string): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(
    amountInSmallestUnit / 100
  );
}

/**
 * Combine une date (typiquement minuit UTC) et une heure "HH:mm" en un DateTime unique, en
 * UTC. Sans heure fournie ou heure non reconnue, la date est renvoyée telle quelle. Fonction
 * pure (pas d'import Prisma) pour rester utilisable depuis un composant client (Sprint 13B) —
 * réexportée par src/lib/reservations.ts pour les appelants serveur existants.
 */
export function combineDateAndTime(date: Date, time?: string | null): Date {
  if (!time) {
    return date;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) {
    return date;
  }
  const combined = new Date(date);
  combined.setUTCHours(Number(match[1]), Number(match[2]), 0, 0);
  return combined;
}

/** Nombre de jours arrondi au jour supérieur, minimum 1 jour — même règle que
 * calculateTotalPrice (src/lib/locations.ts) : tout dépassement, même d'une minute, compte
 * comme un jour supplémentaire. Unique implémentation (source canonique) — réutilisée par
 * réservations/locations/contrats/factures/prolongations/import Excel, jamais réimplémentée
 * localement (revue durée de réservation, 2026-09-01). */
export function calculateDaysCount(start: Date, end: Date): number {
  return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Vérifie strictement qu'une valeur est une heure "HH:mm" valide (00:00 à 23:59) — plus
 * strict que combineDateAndTime ci-dessus, qui reste volontairement permissif (usage
 * historique en affichage : une heure absente/non reconnue renvoie la date inchangée plutôt
 * que d'échouer). À utiliser à l'écriture (création/modification de réservation, import
 * Excel) pour rejeter explicitement une heure absente ou mal formée plutôt que de la laisser
 * silencieusement ignorée (revue durée de réservation, 2026-09-01). */
export function isValidTimeString(value: unknown): value is string {
  return typeof value === "string" && TIME_PATTERN.test(value.trim());
}
