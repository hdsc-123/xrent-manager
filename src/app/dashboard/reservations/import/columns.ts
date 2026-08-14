/**
 * Copie d'affichage des en-têtes attendus (RESERVATION_IMPORT_COLUMN_MAP,
 * src/lib/reservations.ts, Sprint 13B : en-têtes en français) — ce fichier est importé par
 * une page "use client", qui ne peut pas importer src/lib/reservations.ts (celui-ci importe
 * src/lib/prisma.ts, exécuté côté serveur uniquement). À garder synchronisé si la liste de
 * colonnes change.
 */
export const RESERVATION_IMPORT_COLUMNS_CLIENT = [
  "Numéro voucher",
  "Numéro de confirmation",
  "Date de réception",
  "Broker / Direct",
  "Nom",
  "Prénom",
  "Date de départ",
  "Heure de départ",
  "Date de retour",
  "Heure de retour",
  "Nombre de jours (facturés)",
  "Numéro de vol",
  "Devise",
  "Prix total",
  "Prix par jour",
  "Catégorie du véhicule",
  "Agence de départ",
  "Agence de retour",
  "GPS",
  "Prix GPS",
  "Siège bébé",
  "Prix siège bébé",
  "Conducteur supplémentaire",
  "Prix conducteur supplémentaire",
  "Devise des options",
  "Kilométrage",
  "Km inclus",
  "Téléphone client",
  "Remarques",
] as const;

/** Colonnes obligatoires (l'import échoue ligne par ligne, pas globalement, si absentes). */
export const REQUIRED_IMPORT_COLUMNS_CLIENT = [
  "Numéro voucher",
  "Prénom",
  "Nom",
  "Date de départ",
  "Date de retour",
] as const;
