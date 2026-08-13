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
 * comme un jour supplémentaire. */
export function calculateDaysCount(start: Date, end: Date): number {
  return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
}
