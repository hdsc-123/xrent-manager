/**
 * Copie d'affichage de RESERVATION_IMPORT_COLUMNS (src/lib/reservations.ts) — ce fichier
 * est importé par une page "use client", qui ne peut pas importer src/lib/reservations.ts
 * (celui-ci importe src/lib/prisma.ts, exécuté côté serveur uniquement). À garder
 * synchronisé si la liste de colonnes change.
 */
export const RESERVATION_IMPORT_COLUMNS_CLIENT = [
  "voucherNumber",
  "confirmationNumber",
  "receivedAt",
  "source",
  "clientFirstName",
  "clientLastName",
  "startDate",
  "startTime",
  "endDate",
  "endTime",
  "daysCount",
  "flightNumber",
  "currency",
  "totalPrice",
  "pricePerDay",
  "vehicleCategory",
  "pickupAgency",
  "dropoffAgency",
  "hasGps",
  "gpsPrice",
  "hasBabySeat",
  "babySeatPrice",
  "hasExtraDriver",
  "extraDriverPrice",
  "mileage",
  "includedKm",
  "clientPhone",
  "notes",
] as const;
