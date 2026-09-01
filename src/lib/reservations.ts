import type { Reservation, ReservationStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Longueur maximale raisonnable pour `source` en texte libre (Sprint 15) — évite qu'un
 * champ mal mappé à l'import n'écrive une valeur disproportionnée, sans imposer de liste
 * fermée (voir le commentaire du modèle dans prisma/schema.prisma). */
const MAX_SOURCE_LENGTH = 40;

function normalizeSource(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, MAX_SOURCE_LENGTH);
}

export { combineDateAndTime, calculateDaysCount, isValidTimeString } from "@/lib/format";
import { combineDateAndTime, calculateDaysCount, isValidTimeString } from "@/lib/format";

/**
 * Réservation (Sprint 12C) : étape en amont d'un contrat (Location), importée en masse
 * (Excel) ou saisie manuellement. pickupAgency/dropoffAgency/vehicleCategory restent du
 * texte libre (voir le commentaire du modèle dans prisma/schema.prisma) — la sélection du
 * véhicule/agence réels se fait au moment de la conversion en contrat, jamais déduite
 * automatiquement du texte importé (voir POST /api/reservations/[id]/convert).
 */

export class ReservationNotFoundError extends Error {
  constructor() {
    super("Réservation introuvable.");
    this.name = "ReservationNotFoundError";
  }
}

/** Revue durée de réservation (2026-09-01) : comparaison désormais sur l'instant complet
 * (date + heure combinées via combineDateAndTime, jamais la date seule) — un retour le même
 * jour calendaire à une heure antérieure ou égale au départ est refusé, ce que l'ancienne
 * comparaison sur la seule date ne détectait jamais. */
export class InvalidReservationDateRangeError extends Error {
  constructor() {
    super(
      "La date et l'heure de retour doivent être strictement postérieures à la date et l'heure de départ."
    );
    this.name = "InvalidReservationDateRangeError";
  }
}

/** Revue durée de réservation (2026-09-01) : startTime/endTime deviennent obligatoires pour
 * toute création ou modification manuelle, ainsi que pour l'import Excel — jusqu'ici tous deux
 * optionnels (`String?` en base), une heure absente/invalide était silencieusement ignorée par
 * combineDateAndTime (qui renvoie alors la date seule, minuit). */
export class MissingReservationTimeError extends Error {
  readonly field: "startTime" | "endTime";
  constructor(field: "startTime" | "endTime") {
    super(
      field === "startTime"
        ? "L'heure de départ est obligatoire et doit être au format HH:mm."
        : "L'heure de retour est obligatoire et doit être au format HH:mm."
    );
    this.name = "MissingReservationTimeError";
    this.field = field;
  }
}

export class InvalidReservationStatusTransitionError extends Error {
  /** Statut réellement observé au moment du refus (voir claimReservationConversion/
   * markReservationConverted, phase 3 INC-30) — pour un échec de CAS concurrent, c'est le
   * statut RELU après coup, jamais le statut potentiellement obsolète lu avant l'écriture
   * conditionnée, pour que tout appelant puisse construire un message exact. */
  from: ReservationStatus;
  to: ReservationStatus;
  constructor(from: ReservationStatus, to: ReservationStatus) {
    super(`Transition de statut invalide : ${from} → ${to}.`);
    this.name = "InvalidReservationStatusTransitionError";
    this.from = from;
    this.to = to;
  }
}

export class ReservationNotDeletableError extends Error {
  constructor() {
    super(
      "Seule une réservation PENDING ou CANCELLED peut être supprimée ; sinon, annulez-la (status)."
    );
    this.name = "ReservationNotDeletableError";
  }
}

export class ReservationLockedError extends Error {
  constructor() {
    super(
      "Cette réservation est terminale (CONVERTED/CANCELLED/NO_SHOW) : seules les notes restent " +
        "modifiables. Le contrat déjà généré à la conversion n'est jamais mis à jour rétroactivement."
    );
    this.name = "ReservationLockedError";
  }
}

/** Sprint 23 (DOMAINRULES.md section 39) — reset à zéro réservé à un ADMIN
 * (resetReservationToPending ci-dessous, jamais atteignable via updateReservation). */
export class ReservationNotResettableError extends Error {
  constructor() {
    super("Seule une réservation CONVERTED, CANCELLED ou NO_SHOW peut être réinitialisée.");
    this.name = "ReservationNotResettableError";
  }
}

/** Sprint 23 : une réservation CONVERTED ne peut être réinitialisée que si le contrat qu'elle
 * a généré a déjà été annulé par un ADMIN (voir adminCancelValidatedLocation,
 * src/lib/locations.ts) — jamais un reset laissant un contrat actif orphelin de sa réservation
 * d'origine. */
export class ReservationResetRequiresCancelledContractError extends Error {
  constructor() {
    super(
      "Le contrat généré par cette réservation doit d'abord être annulé par un administrateur " +
        "avant de pouvoir réinitialiser la réservation."
    );
    this.name = "ReservationResetRequiresCancelledContractError";
  }
}

/**
 * Machine à états explicite, même principe que Location (src/lib/locations.ts).
 * PENDING → CONVERTED directement est autorisé (une petite agence peut confirmer et
 * convertir en une seule étape) — même flexibilité que Maintenance SCHEDULED → COMPLETED
 * (src/lib/maintenances.ts). CONVERTED/CANCELLED sont terminaux.
 */
const ALLOWED_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  PENDING: ["CONFIRMED", "CONVERTED", "CANCELLED", "NO_SHOW"],
  CONFIRMED: ["CONVERTED", "CANCELLED", "NO_SHOW"],
  CONVERTED: [],
  CANCELLED: [],
  // Sprint 23 (DOMAINRULES.md section 39) : le client ne s'est jamais présenté — terminal,
  // distinct de CANCELLED (client venu mais véhicule refusé/conditions non respectées). Seul
  // un ADMIN peut en sortir (resetReservationToPending ci-dessous, hors de cette machine à
  // états normale, jamais via canTransition).
  NO_SHOW: [],
};

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface ReservationFilters {
  status?: ReservationStatus;
  source?: string;
  from?: Date;
  to?: Date;
  search?: string;
  /** Sprint 14A : filtres dédiés aux colonnes Ville de départ/retour/Catégorie, absents
   * jusqu'ici alors qu'elles sont affichées (voir ReservationsTable.tsx). Correspondance
   * exacte, insensible à la casse. */
  pickupAgency?: string;
  dropoffAgency?: string;
  vehicleCategory?: string;
  /** Sprint 19 : agences accessibles à l'appelant (getAccessibleAgencyIds, src/lib/authz.ts)
   * — `null` = ADMIN, aucune restriction. Un MEMBER ne voit que les réservations dont
   * pickupAgencyId OU dropoffAgencyId est dans cette liste, ou dont les deux sont non résolus
   * (voir buildAgencyLookupMap ci-dessus et DOMAINRULES.md section 37). */
  accessibleAgencyIds?: string[] | null;
}

export async function getReservations(
  tenantId: string,
  filters: ReservationFilters = {}
): Promise<Reservation[]> {
  return prisma.reservation.findMany({
    where: {
      tenantId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.source ? { source: { equals: filters.source, mode: "insensitive" } } : {}),
      ...(filters.from ? { endDate: { gte: filters.from } } : {}),
      ...(filters.to ? { startDate: { lte: filters.to } } : {}),
      ...(filters.pickupAgency ? { pickupAgency: { equals: filters.pickupAgency, mode: "insensitive" } } : {}),
      ...(filters.dropoffAgency ? { dropoffAgency: { equals: filters.dropoffAgency, mode: "insensitive" } } : {}),
      ...(filters.vehicleCategory
        ? { vehicleCategory: { equals: filters.vehicleCategory, mode: "insensitive" } }
        : {}),
      ...(filters.accessibleAgencyIds
        ? {
            OR: [
              { pickupAgencyId: { in: filters.accessibleAgencyIds } },
              { dropoffAgencyId: { in: filters.accessibleAgencyIds } },
              { pickupAgencyId: null, dropoffAgencyId: null },
            ],
          }
        : {}),
      ...(filters.search
        ? {
            OR: [
              { voucherNumber: { contains: filters.search, mode: "insensitive" } },
              // Phase 6.1 : recherche également par le numéro interne (RES-{année}-{6 chiffres}).
              // `contains` sur un champ nullable ne retourne jamais les lignes NULL (sémantique
              // Prisma standard) — aucune régression pour les réservations pré-existantes qui
              // n'en ont pas encore.
              { reservationNumber: { contains: filters.search, mode: "insensitive" } },
              { clientFirstName: { contains: filters.search, mode: "insensitive" } },
              { clientLastName: { contains: filters.search, mode: "insensitive" } },
              { flightNumber: { contains: filters.search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { startDate: "desc" },
  });
}

/**
 * `tx` optionnel (Sprint 26A, Finding A) — défaut au client Prisma global, comportement
 * inchangé pour tout appelant existant. Un appelant à l'intérieur d'une transaction Prisma
 * partagée (voir POST /api/reservations/[id]/convert) doit le fournir explicitement pour
 * voir les écritures déjà faites dans cette même transaction, non encore commitées.
 */
export async function getReservationById(
  tenantId: string,
  reservationId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<Reservation | null> {
  return tx.reservation.findFirst({ where: { id: reservationId, tenantId } });
}

export interface ReservationInputFields {
  voucherNumber: string;
  confirmationNumber?: string;
  receivedAt?: Date;
  source?: string;
  clientFirstName: string;
  clientLastName: string;
  startDate: Date;
  startTime?: string;
  endDate: Date;
  endTime?: string;
  daysCount?: number;
  flightNumber?: string;
  currency?: string;
  totalPrice?: number;
  pricePerDay?: number;
  vehicleCategory?: string;
  pickupAgency?: string;
  dropoffAgency?: string;
  hasGps?: boolean;
  gpsPrice?: number;
  hasBabySeat?: boolean;
  babySeatPrice?: number;
  hasExtraDriver?: boolean;
  extraDriverPrice?: number;
  optionsCurrency?: string;
  mileage?: number;
  includedKm?: number;
  clientPhone?: string;
  notes?: string;
  status?: ReservationStatus;
}

export interface CreateReservationInput extends ReservationInputFields {
  tenantId: string;
}

/**
 * Génère un numéro de voucher pour une réservation source DIRECT (Sprint 13C), au format
 * Dir-{4 chiffres} (Dir-0001, Dir-0002...) — compteur basé sur le nombre de réservations
 * DIRECT déjà créées pour ce tenant, même principe que generateInvoiceNumber
 * (src/lib/invoices.ts). Pas de contrainte unique en base sur voucherNumber (CLAUDE.md
 * section 7 : aucun changement de schéma pour ce sprint) : la boucle ci-dessous vérifie
 * explicitement l'absence de collision plutôt que de s'appuyer sur un P2002.
 */
/**
 * Phase 6.1 (2026-08-31) : numéro interne unique par tenant, format `RES-{année}-{6 chiffres}`
 * — distinct de `voucherNumber` (référence externe/broker, non unique par conception, voir le
 * commentaire du modèle `Reservation` dans `prisma/schema.prisma`). Incrémenté par une seule
 * instruction SQL atomique (`INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING`) sur
 * `ReservationNumberCounter`, clé composite `(tenantId, année)` — jamais un `SELECT MAX(...)+1`
 * ni un `COUNT()` (contrairement à `generateInvoiceNumber`) : Postgres verrouille la ligne
 * concernée pendant la durée de cette unique instruction, donc deux créations concurrentes pour
 * le même tenant/année ne peuvent structurellement jamais recevoir le même numéro — aucun
 * réessai sur collision n'est nécessaire ni possible.
 *
 * Doit toujours être appelée à l'intérieur de la même transaction que l'écriture qui l'utilise
 * (voir `createReservation` ci-dessous) : si cette écriture échoue ensuite, la transaction
 * entière (compteur inclus) est annulée — le prochain appel réussi obtient alors le même numéro
 * que celui de la tentative annulée (un « trou » dans la séquence est possible et sans
 * conséquence, comme pour tout compteur de ce type dans ce projet, ex. `Agency.lastContractNumber`),
 * jamais une collision.
 */
async function generateReservationNumber(tenantId: string, tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const rows = await tx.$queryRaw<{ lastNumber: number }[]>`
    INSERT INTO "ReservationNumberCounter" ("tenantId", "year", "lastNumber")
    VALUES (${tenantId}, ${year}, 1)
    ON CONFLICT ("tenantId", "year")
    DO UPDATE SET "lastNumber" = "ReservationNumberCounter"."lastNumber" + 1
    RETURNING "lastNumber"
  `;
  const lastNumber = rows[0].lastNumber;
  return `RES-${year}-${String(lastNumber).padStart(6, "0")}`;
}

export async function generateDirectVoucherNumber(tenantId: string): Promise<string> {
  const count = await prisma.reservation.count({ where: { tenantId, source: "DIRECT" } });

  let next = count + 1;
  let candidate = `Dir-${String(next).padStart(4, "0")}`;
  while (await prisma.reservation.findFirst({ where: { tenantId, voucherNumber: candidate } })) {
    next += 1;
    candidate = `Dir-${String(next).padStart(4, "0")}`;
  }
  return candidate;
}

/**
 * Combine et valide startDate/startTime/endDate/endTime, et calcule la durée réelle (règle du
 * jour entamé) — unique source de vérité (revue durée de réservation, 2026-09-01) réutilisée
 * par la création/modification manuelle ET par l'import Excel (aperçu et écriture), pour ne
 * jamais dupliquer cette logique : heure absente/mal formée → MissingReservationTimeError ;
 * instant de retour non strictement postérieur à l'instant de départ →
 * InvalidReservationDateRangeError. `realDaysCount` est la durée réelle recalculée : jamais la
 * valeur brute `daysCount` éventuellement fournie par l'appelant (voir Sprint 13B, préservée
 * telle quelle pour l'import — cette fonction ne fait que la comparer, jamais l'écraser).
 */
export function resolveReservationDuration(
  startDate: Date,
  startTime: unknown,
  endDate: Date,
  endTime: unknown
): { startInstant: Date; endInstant: Date; realDaysCount: number } {
  if (!isValidTimeString(startTime)) {
    throw new MissingReservationTimeError("startTime");
  }
  if (!isValidTimeString(endTime)) {
    throw new MissingReservationTimeError("endTime");
  }
  const startInstant = combineDateAndTime(startDate, startTime);
  const endInstant = combineDateAndTime(endDate, endTime);
  if (endInstant <= startInstant) {
    throw new InvalidReservationDateRangeError();
  }
  return { startInstant, endInstant, realDaysCount: calculateDaysCount(startInstant, endInstant) };
}

/**
 * `agencyLookup` (Sprint 19) : optionnel — permet à l'appelant (import Excel en boucle,
 * voir POST /api/reservations/import) de résoudre la carte ville/agence une seule fois pour
 * tout le fichier plutôt qu'à chaque ligne ; une création manuelle isolée (POST
 * /api/reservations) la laisse se reconstruire ici, coût négligeable pour un seul appel.
 *
 * Revue durée de réservation (2026-09-01) : `daysCount` stocké est désormais toujours calculé
 * côté serveur à partir de la durée réelle (resolveReservationDuration) pour une création
 * manuelle (qui n'en fournit jamais, voir NewReservationForm.tsx) — SAUF si l'appelant fournit
 * explicitement une valeur (import Excel, Sprint 13B : la valeur brute du fichier broker est
 * préservée telle quelle, jamais recalculée/écrasée ici ; parseReservationImportRow signale déjà
 * toute divergence avec la durée réelle dans le rapport d'import, sans jamais la corriger
 * silencieusement).
 */
export async function createReservation(
  data: CreateReservationInput,
  agencyLookup?: AgencyLookupMap
): Promise<Reservation> {
  const { realDaysCount } = resolveReservationDuration(
    data.startDate,
    data.startTime,
    data.endDate,
    data.endTime
  );

  const lookup = agencyLookup ?? (await buildAgencyLookupMap(data.tenantId));

  // Phase 6.1 : reservationNumber n'est jamais accepté depuis `data` (absent de
  // CreateReservationInput/ReservationInputFields par construction — voir ces interfaces
  // ci-dessus, aucun champ de ce nom n'existe côté entrée) — généré exclusivement ici, à
  // l'intérieur de la même transaction que l'écriture, pour garantir qu'un échec de création
  // annule aussi l'incrémentation du compteur (voir generateReservationNumber ci-dessus).
  return prisma.$transaction(async (tx) => {
    const reservationNumber = await generateReservationNumber(data.tenantId, tx);
    return tx.reservation.create({
      data: {
        tenantId: data.tenantId,
        voucherNumber: data.voucherNumber,
        reservationNumber,
        confirmationNumber: data.confirmationNumber,
        receivedAt: data.receivedAt,
        source: normalizeSource(data.source),
        clientFirstName: data.clientFirstName,
        clientLastName: data.clientLastName,
        startDate: data.startDate,
        startTime: data.startTime,
        endDate: data.endDate,
        endTime: data.endTime,
        daysCount: data.daysCount ?? realDaysCount,
        flightNumber: data.flightNumber,
        currency: data.currency ?? "MAD",
        totalPrice: data.totalPrice,
        pricePerDay: data.pricePerDay,
        vehicleCategory: data.vehicleCategory,
        pickupAgency: data.pickupAgency,
        dropoffAgency: data.dropoffAgency,
        pickupAgencyId: lookupAgencyId(lookup, data.pickupAgency),
        dropoffAgencyId: lookupAgencyId(lookup, data.dropoffAgency),
        hasGps: data.hasGps ?? false,
        gpsPrice: data.gpsPrice,
        hasBabySeat: data.hasBabySeat ?? false,
        babySeatPrice: data.babySeatPrice,
        hasExtraDriver: data.hasExtraDriver ?? false,
        extraDriverPrice: data.extraDriverPrice,
        optionsCurrency: data.optionsCurrency ?? "MAD",
        mileage: data.mileage,
        includedKm: data.includedKm,
        clientPhone: data.clientPhone,
        notes: data.notes,
        status: data.status ?? "PENDING",
      },
    });
  });
}

export type UpdateReservationInput = Partial<ReservationInputFields>;

export async function updateReservation(
  tenantId: string,
  reservationId: string,
  data: UpdateReservationInput
): Promise<Reservation | null> {
  const existing = await getReservationById(tenantId, reservationId);
  if (!existing) {
    return null;
  }

  // Verrou de statut terminal (Sprint 17, même principe que LocationLockedError dans
  // src/lib/locations.ts) : CONVERTED/CANCELLED sont des états terminaux (ALLOWED_TRANSITIONS
  // ci-dessus) — jusqu'ici seule l'UI (page d'édition, bouton "Modifier") empêchait de les
  // modifier, l'API acceptait silencieusement un PATCH direct sur n'importe quel champ. Les
  // notes restent modifiables à tout statut (ReservationActions.tsx les édite indépendamment
  // du statut, y compris déjà terminal).
  const isTerminal =
    existing.status === "CONVERTED" || existing.status === "CANCELLED" || existing.status === "NO_SHOW";
  if (isTerminal) {
    const touchesNonNotesField = (Object.keys(data) as (keyof UpdateReservationInput)[]).some(
      (key) => key !== "notes" && data[key] !== undefined
    );
    if (touchesNonNotesField) {
      throw new ReservationLockedError();
    }
  }

  // Revue durée de réservation (2026-09-01) : la validation/le recalcul de durée ne s'applique
  // que si cette modification touche réellement une date ou une heure — un PATCH qui ne porte
  // que sur des champs sans rapport (ex. notes, clientPhone) ne doit jamais être bloqué par une
  // réservation existante dont l'heure serait encore absente (données antérieures à cette
  // règle, jamais backfillées). Dès que l'appelant touche l'un de ces quatre champs, le résultat
  // complet (date+heure de départ/retour, en tenant compte des valeurs déjà en base pour les
  // champs non fournis) doit être valide dans son ensemble.
  const touchesDateOrTime =
    data.startDate !== undefined ||
    data.startTime !== undefined ||
    data.endDate !== undefined ||
    data.endTime !== undefined;
  const nextStart = data.startDate ?? existing.startDate;
  const nextStartTime = data.startTime !== undefined ? data.startTime : existing.startTime;
  const nextEnd = data.endDate ?? existing.endDate;
  const nextEndTime = data.endTime !== undefined ? data.endTime : existing.endTime;

  let recalculatedDaysCount: number | undefined;
  if (touchesDateOrTime) {
    const { realDaysCount } = resolveReservationDuration(nextStart, nextStartTime, nextEnd, nextEndTime);
    recalculatedDaysCount = realDaysCount;
  }

  if (data.status && data.status !== existing.status && !canTransition(existing.status, data.status)) {
    throw new InvalidReservationStatusTransitionError(existing.status, data.status);
  }

  // Une option décochée (Sprint 17) efface son prix associé plutôt que de le laisser en base
  // — sans quoi "Prix final" (ReservationsTable.tsx, somme inconditionnelle des prix d'option)
  // continue d'inclure un montant dont le badge affiche pourtant "Non". Ignoré si l'appelant
  // fournit explicitement un nouveau prix dans la même requête (son intention prime).
  const clearGpsPrice = data.hasGps === false && data.gpsPrice === undefined;
  const clearBabySeatPrice = data.hasBabySeat === false && data.babySeatPrice === undefined;
  const clearExtraDriverPrice = data.hasExtraDriver === false && data.extraDriverPrice === undefined;

  // Sprint 19 : pickupAgencyId/dropoffAgencyId (visibilité/autorisation par agence, voir
  // src/lib/authz.ts) recalculés dès que le texte pickupAgency/dropoffAgency correspondant
  // change — jamais fournis directement par l'appelant (toujours dérivés, même principe que
  // Location.agencyId dérivé du véhicule).
  const needsAgencyLookup = data.pickupAgency !== undefined || data.dropoffAgency !== undefined;
  const agencyLookup = needsAgencyLookup ? await buildAgencyLookupMap(tenantId) : null;
  const pickupAgencyId =
    data.pickupAgency !== undefined ? lookupAgencyId(agencyLookup!, data.pickupAgency) : undefined;
  const dropoffAgencyId =
    data.dropoffAgency !== undefined ? lookupAgencyId(agencyLookup!, data.dropoffAgency) : undefined;

  const updateData = {
      ...(data.voucherNumber !== undefined ? { voucherNumber: data.voucherNumber } : {}),
      ...(data.confirmationNumber !== undefined ? { confirmationNumber: data.confirmationNumber } : {}),
      ...(data.receivedAt !== undefined ? { receivedAt: data.receivedAt } : {}),
      // `?? null` (pas juste normalizeSource(data.source)) : Prisma traite une valeur `undefined`
      // explicite dans `data` comme "champ non fourni" (ignoré, ancienne valeur conservée) —
      // normalizeSource("") retourne `undefined`, donc sans ce fallback, effacer `source` (chaîne
      // vide envoyée) ne l'aurait jamais réellement écrit à `null` en base (Sprint 19).
      ...(data.source !== undefined ? { source: normalizeSource(data.source) ?? null } : {}),
      ...(data.clientFirstName !== undefined ? { clientFirstName: data.clientFirstName } : {}),
      ...(data.clientLastName !== undefined ? { clientLastName: data.clientLastName } : {}),
      ...(data.startDate !== undefined ? { startDate: data.startDate } : {}),
      ...(data.startTime !== undefined ? { startTime: data.startTime } : {}),
      ...(data.endDate !== undefined ? { endDate: data.endDate } : {}),
      ...(data.endTime !== undefined ? { endTime: data.endTime } : {}),
      // Revue durée de réservation (2026-09-01) : une valeur explicitement fournie par
      // l'appelant prime toujours (import Excel — Sprint 13B, valeur brute préservée) ; sinon,
      // dès que la date/l'heure change, la durée recalculée remplace l'ancienne valeur
      // potentiellement périmée — jamais laissée telle quelle après un changement de dates.
      ...(data.daysCount !== undefined
        ? { daysCount: data.daysCount }
        : touchesDateOrTime
          ? { daysCount: recalculatedDaysCount }
          : {}),
      ...(data.flightNumber !== undefined ? { flightNumber: data.flightNumber } : {}),
      ...(data.currency !== undefined ? { currency: data.currency } : {}),
      ...(data.totalPrice !== undefined ? { totalPrice: data.totalPrice } : {}),
      ...(data.pricePerDay !== undefined ? { pricePerDay: data.pricePerDay } : {}),
      ...(data.vehicleCategory !== undefined ? { vehicleCategory: data.vehicleCategory } : {}),
      ...(data.pickupAgency !== undefined ? { pickupAgency: data.pickupAgency, pickupAgencyId } : {}),
      ...(data.dropoffAgency !== undefined ? { dropoffAgency: data.dropoffAgency, dropoffAgencyId } : {}),
      ...(data.hasGps !== undefined ? { hasGps: data.hasGps } : {}),
      ...(data.gpsPrice !== undefined ? { gpsPrice: data.gpsPrice } : clearGpsPrice ? { gpsPrice: null } : {}),
      ...(data.hasBabySeat !== undefined ? { hasBabySeat: data.hasBabySeat } : {}),
      ...(data.babySeatPrice !== undefined
        ? { babySeatPrice: data.babySeatPrice }
        : clearBabySeatPrice
          ? { babySeatPrice: null }
          : {}),
      ...(data.hasExtraDriver !== undefined ? { hasExtraDriver: data.hasExtraDriver } : {}),
      ...(data.extraDriverPrice !== undefined
        ? { extraDriverPrice: data.extraDriverPrice }
        : clearExtraDriverPrice
          ? { extraDriverPrice: null }
          : {}),
      ...(data.optionsCurrency !== undefined ? { optionsCurrency: data.optionsCurrency } : {}),
      ...(data.mileage !== undefined ? { mileage: data.mileage } : {}),
      ...(data.includedKm !== undefined ? { includedKm: data.includedKm } : {}),
      ...(data.clientPhone !== undefined ? { clientPhone: data.clientPhone } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
  };

  // Sprint 23 : la transition de statut passe désormais par un `updateMany` conditionné sur
  // `status: existing.status`, atomique côté base — même correctif de course que
  // validateVehicleTransfer/cancelVehicleTransfer (Sprint 22, src/lib/vehicle-transfers.ts),
  // étendu ici (DOMAINRULES.md section 39) car les nouvelles actions rapides (Annuler/No Show)
  // rendent deux clics quasi simultanés sur la même ligne plus plausibles. Une modification qui
  // ne change pas le statut n'a pas besoin de cette garde (pas de machine à états en jeu).
  if (data.status !== undefined && data.status !== existing.status) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.reservation.updateMany({
        where: { id: reservationId, status: existing.status },
        data: updateData,
      });
      if (count === 0) {
        throw new InvalidReservationStatusTransitionError(existing.status, data.status as ReservationStatus);
      }
      return tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    });
  }

  return prisma.reservation.update({
    where: { id: reservationId },
    data: updateData,
  });
}

/**
 * Sprint 23 (DOMAINRULES.md section 39) — reset à zéro d'une réservation terminale, réservé à
 * un ADMIN (dérivé côté route uniquement, jamais un champ de corps de requête — même principe
 * que Location.adminOverride, DOMAINRULES.md section 37). Hors de la machine à états normale
 * (`ALLOWED_TRANSITIONS` ci-dessus n'autorise jamais un retour à PENDING) : cette fonction
 * l'atteint directement, volontairement, pour permettre à un admin de corriger une erreur
 * d'agent (mauvais clic Annuler/No Show, ou contrat annulé qu'il faut reprendre à zéro).
 */
export async function resetReservationToPending(
  tenantId: string,
  reservationId: string
): Promise<Reservation | null> {
  const existing = await getReservationById(tenantId, reservationId);
  if (!existing) {
    return null;
  }

  if (existing.status !== "CONVERTED" && existing.status !== "CANCELLED" && existing.status !== "NO_SHOW") {
    throw new ReservationNotResettableError();
  }

  if (existing.status === "CONVERTED" && existing.convertedLocationId) {
    const location = await prisma.location.findUnique({
      where: { id: existing.convertedLocationId },
      select: { status: true },
    });
    if (location && location.status !== "CANCELLED") {
      throw new ReservationResetRequiresCancelledContractError();
    }
  }

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.reservation.updateMany({
      where: { id: reservationId, status: existing.status },
      data: { status: "PENDING", convertedLocationId: null },
    });
    if (count === 0) {
      throw new ReservationNotResettableError();
    }
    return tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  });
}

/**
 * Import Excel (Sprint 12C, en-têtes = noms de champs ; Sprint 13B, en-têtes en français) :
 * `RESERVATION_IMPORT_COLUMN_MAP` fait correspondre chaque en-tête exact attendu (ordre exact
 * de l'énoncé du sprint) au nom du champ interne correspondant sur `Reservation`.
 * `RESERVATION_IMPORT_COLUMNS` (en-têtes, dans l'ordre) reste exporté séparément pour
 * l'affichage (page d'import) et pour construire l'en-tête d'un fichier de test/exemple.
 */
export const RESERVATION_IMPORT_COLUMN_MAP = {
  "Numéro voucher": "voucherNumber",
  "Numéro de confirmation": "confirmationNumber",
  "Date de réception": "receivedAt",
  "Broker / Direct": "source",
  Nom: "clientLastName",
  Prénom: "clientFirstName",
  "Date de départ": "startDate",
  "Heure de départ": "startTime",
  "Date de retour": "endDate",
  "Heure de retour": "endTime",
  "Nombre de jours (facturés)": "daysCount",
  "Numéro de vol": "flightNumber",
  Devise: "currency",
  "Prix total": "totalPrice",
  "Prix par jour": "pricePerDay",
  "Catégorie du véhicule": "vehicleCategory",
  "Agence de départ": "pickupAgency",
  "Agence de retour": "dropoffAgency",
  GPS: "hasGps",
  "Prix GPS": "gpsPrice",
  "Siège bébé": "hasBabySeat",
  "Prix siège bébé": "babySeatPrice",
  "Conducteur supplémentaire": "hasExtraDriver",
  "Prix conducteur supplémentaire": "extraDriverPrice",
  "Devise des options": "optionsCurrency",
  Kilométrage: "mileage",
  "Km inclus": "includedKm",
  "Téléphone client": "clientPhone",
  Remarques: "notes",
} as const;

export const RESERVATION_IMPORT_COLUMNS = Object.keys(
  RESERVATION_IMPORT_COLUMN_MAP
) as (keyof typeof RESERVATION_IMPORT_COLUMN_MAP)[];

/** Champs internes requis (voucherNumber, clientFirstName, clientLastName, startDate,
 * endDate) + leur en-tête français, pour rapporter une erreur précise par ligne/colonne. */
// Revue durée de réservation (2026-09-01) : Heure de départ/retour ajoutées aux colonnes
// obligatoires — jusqu'ici seules les dates l'étaient, l'heure restait optionnelle et une
// cellule vide/invalide était silencieusement ignorée (voir cellToTime/combineDateAndTime).
export const REQUIRED_IMPORT_FIELDS: { field: string; column: string }[] = [
  { field: "voucherNumber", column: "Numéro voucher" },
  { field: "clientFirstName", column: "Prénom" },
  { field: "clientLastName", column: "Nom" },
  { field: "startDate", column: "Date de départ" },
  { field: "endDate", column: "Date de retour" },
  { field: "startTime", column: "Heure de départ" },
  { field: "endTime", column: "Heure de retour" },
];

function cellToString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "object" && "text" in (value as Record<string, unknown>)) {
    // Cellule exceljs "rich text"/hyperlien : { text, hyperlink? } ou { richText: [...] }.
    const text = (value as { text?: unknown }).text;
    const str = text !== undefined ? String(text).trim() : "";
    return str === "" ? undefined : str;
  }
  const str = String(value).trim();
  return str === "" ? undefined : str;
}

function cellToNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const num = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(num) ? num : undefined;
}

/** Montant en unité courante (ex. 500.5 MAD) → entier en centimes, même convention que les
 * formulaires dashboard existants (ex. src/app/dashboard/vehicles/new/page.tsx). */
function cellToMoney(value: unknown): number | undefined {
  const num = cellToNumber(value);
  return num === undefined ? undefined : Math.round(num * 100);
}

function cellToInt(value: unknown): number | undefined {
  const num = cellToNumber(value);
  return num === undefined ? undefined : Math.round(num);
}

function cellToBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase();
    return normalized === "OUI" || normalized === "O" || normalized === "TRUE" || normalized === "1" || normalized === "YES";
  }
  return false;
}

/** Excel compte les jours depuis 1899-12-30 (le "jour 0" historique, qui compense le bug de
 * l'année bissextile 1900 hérité de Lotus 1-2-3) — conversion standard vers un timestamp Unix
 * (ms). Nécessaire quand une cellule date perd son format Excel et arrive comme un simple
 * nombre (ex. copier-coller depuis une autre feuille) plutôt que comme un objet Date, qu'exceljs
 * ne convertit alors plus automatiquement. */
const EXCEL_EPOCH_OFFSET_DAYS = 25569;

function excelSerialToDate(serial: number): Date {
  return new Date(Math.round((serial - EXCEL_EPOCH_OFFSET_DAYS) * 86_400_000));
}

/** DD/MM/YYYY, DD-MM-YYYY ou DD.MM.YYYY — formats français courants qu'un fichier Excel mal
 * formaté peut produire en texte brut ; `new Date(string)` les interprète de façon peu fiable
 * (souvent comme MM/DD/YYYY ou pas du tout). Le premier groupe est **toujours** le jour et le
 * second **toujours** le mois — jamais l'inverse, jamais d'interprétation américaine MM/DD/YYYY,
 * quelle que soit la valeur numérique des deux groupes (voir `isValidFrenchDateComponents`
 * ci-dessous pour le rejet des valeurs qui en résultent invalides plutôt qu'une réinterprétation
 * dans l'autre sens). */
const FRENCH_DATE_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

/** Valide qu'un triplet jour/mois/année interprété au format français (DD/MM/YYYY) désigne une
 * date calendaire réellement existante — correctif (revue import Excel, 2026-08-29) : `Date.UTC`
 * ne rejette jamais un débordement, il le fait rouler silencieusement sur le mois/l'année suivant
 * (ex. `31/02/2030` → 2030-03-03, `15/13/2030` → 2031-01-15, `29/02/2030` (non bissextile) →
 * 2030-03-01) — un fichier broker avec une faute de frappe sur le jour/mois était donc importé
 * avec une date silencieusement fausse, sans jamais être rejeté. Le round-trip ci-dessous compare
 * les composants effectivement reconstruits par `Date.UTC` aux valeurs saisies : toute
 * divergence (mois > 12, mois < 1, jour inexistant dans ce mois, 29 février hors année
 * bissextile...) est ainsi détectée après coup, sans avoir à réimplémenter un calendrier gréorien
 * complet (jours par mois, règle bissextile) — `Date.UTC`/`getUTCFullYear`/`getUTCMonth`/
 * `getUTCDate` le font déjà correctement, il suffisait de vérifier le résultat. */
function isValidFrenchDateComponents(day: number, month: number, year: number, date: Date): boolean {
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Borne basse de plausibilité, même valeur que la borne déjà appliquée à `Vehicle.year`
 * (`POST`/`PATCH /api/vehicles*`, `src/app/api/vehicles/route.ts`) — réutilisée ici pour rester
 * cohérent avec la seule autre borne de date/année existante dans le projet, plutôt que
 * d'inventer une valeur arbitraire propre à l'import. Ne sert que de filet de sécurité pour les
 * chemins où une conversion en `Date` a déjà eu lieu hors de notre contrôle (cellule `Date`
 * renvoyée telle quelle par exceljs, ou texte parsé par `new Date(str)`) : ce n'est PAS le
 * mécanisme de rejet du sérial numérique `0`/négatif — voir `cellToDate` ci-dessous (correctif
 * F-2 du 2026-08-25), qui rejette ces valeurs directement sur le nombre brut, avant toute
 * conversion en date, précisément pour ne pas dépendre d'une borne d'année accidentelle. */
const MIN_PLAUSIBLE_YEAR = 1900;

function isPlausibleDate(date: Date): boolean {
  return !Number.isNaN(date.getTime()) && date.getUTCFullYear() >= MIN_PLAUSIBLE_YEAR;
}

/** Correctif (validation manuelle 2026-08-25, finding F-2) : une cellule date ayant perdu son
 * formatage Excel (copier-coller, cellule vidée puis retapée en numérique...) arrive alors comme
 * un simple nombre — `0` en particulier, le cas le plus fréquent, se convertirait fidèlement via
 * `excelSerialToDate` en 1899-12-30 ("jour 0" de l'époque Excel, voir le commentaire de
 * `excelSerialToDate` plus haut), une date syntaxiquement valide mais jamais légitime pour une
 * réservation réelle. Rejeté ici directement sur la valeur Excel brute — `0`, toute valeur
 * négative, ou non finie (`NaN`/`Infinity`) — *avant* tout appel à `excelSerialToDate` : la
 * cellule n'est jamais transformée en `Date` pour être ensuite filtrée après coup sur son année
 * (fragile, dépendant d'une borne accidentelle qui pourrait changer ailleurs). */
function isRejectedExcelSerial(value: number): boolean {
  return !Number.isFinite(value) || value <= 0;
}

function cellToDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return isPlausibleDate(value) ? value : undefined;
  }
  if (typeof value === "number") {
    if (isRejectedExcelSerial(value)) {
      return undefined;
    }
    return excelSerialToDate(value);
  }
  const str = cellToString(value);
  if (!str) {
    return undefined;
  }
  const frenchMatch = str.match(FRENCH_DATE_RE);
  if (frenchMatch) {
    const [, dayStr, monthStr, yearStr] = frenchMatch;
    const day = Number(dayStr);
    const month = Number(monthStr);
    const year = Number(yearStr);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!isPlausibleDate(date) || !isValidFrenchDateComponents(day, month, year, date)) {
      return undefined;
    }
    return date;
  }
  const date = new Date(str);
  return isPlausibleDate(date) ? date : undefined;
}

/** Extrait "HH:mm" d'une cellule heure — gère les trois formes qu'exceljs peut renvoyer pour
 * une colonne heure : objet Date (cellule formatée heure, l'écueil le plus fréquent — passer
 * une telle valeur à cellToString produirait une chaîne de date complète, ex.
 * "Mon Dec 30 1899 14:30:00 GMT...", au lieu d'une heure propre), fraction de journée (nombre,
 * 0.5 = 12:00), ou chaîne déjà lisible ("14:30", "14:30:00"). */
function cellToTime(value: unknown): string | undefined {
  if (value instanceof Date) {
    const hours = String(value.getUTCHours()).padStart(2, "0");
    const minutes = String(value.getUTCMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Revue durée de réservation (2026-09-01, point 9) : une heure Excel valide est une
    // fraction de journée dans [0, 1) — une valeur ≥ 1 (ou négative) signale une cellule mal
    // formatée pour une colonne heure (ex. un numéro de série de date complet copié depuis une
    // autre colonne) plutôt qu'une heure réelle. Rejetée explicitement ici (undefined, traité
    // comme une heure manquante par l'appelant) au lieu d'être tronquée silencieusement via
    // `value % 1`, qui produirait une heure plausible mais fausse (ex. minuit pour n'importe
    // quel nombre entier).
    if (value < 0 || value >= 1) {
      return undefined;
    }
    const totalMinutes = Math.round((value % 1) * 24 * 60);
    const hours = String(Math.floor(totalMinutes / 60) % 24).padStart(2, "0");
    const minutes = String(totalMinutes % 60).padStart(2, "0");
    return `${hours}:${minutes}`;
  }
  const str = cellToString(value);
  if (!str) {
    return undefined;
  }
  const match = str.match(/^(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : str;
}

export type ParsedReservationRow =
  | {
      data: Omit<CreateReservationInput, "tenantId">;
      /** Durée réelle recalculée à partir des instants date+heure combinés (règle du jour
       * entamé, resolveReservationDuration) — jamais la valeur brute `daysCount` du fichier
       * (revue durée de réservation, 2026-09-01). Affichée à des fins de contrôle par l'aperçu
       * d'import, indépendamment de ce qui est effectivement stocké. */
      realDaysCount: number;
      /** Non vide uniquement si la colonne "Jours" du fichier était renseignée ET diverge de
       * realDaysCount — signalée dans le rapport d'import, jamais utilisée pour écraser la
       * valeur brute importée (Sprint 13B, préservée telle quelle dans `data.daysCount`). */
      daysCountWarning?: string;
    }
  | { error: string };

const REQUIRED_STRING_IMPORT_FIELDS = REQUIRED_IMPORT_FIELDS.filter(
  ({ field }) => field !== "startDate" && field !== "endDate" && field !== "startTime" && field !== "endTime"
);

function isCellEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

const REQUIRED_STRING_VALUE_GETTERS: Record<string, (row: Record<string, unknown>) => unknown> = {
  voucherNumber: (row) => cellToString(row.voucherNumber),
  clientFirstName: (row) => cellToString(row.clientFirstName),
  clientLastName: (row) => cellToString(row.clientLastName),
};

/** Valide une date obligatoire (startDate/endDate) : distingue une cellule vide (« Colonne
 * obligatoire manquante », message historique) d'une cellule renseignée mais imparsable
 * (nouveau message précis, avec la valeur brute reçue) — jusqu'ici les deux cas produisaient le
 * même message trompeur "manquante" alors que la ligne contenait bien une date, juste dans un
 * format non reconnu. */
function parseRequiredDate(
  row: Record<string, unknown>,
  field: "startDate" | "endDate",
  column: string
): { date: Date } | { error: string } {
  const raw = row[field];
  if (isCellEmpty(raw)) {
    return { error: `Colonne obligatoire manquante: ${column}` };
  }
  const date = cellToDate(raw);
  if (!date) {
    return { error: `Colonne invalide: ${column} (valeur "${cellToString(raw) ?? raw}" non reconnue comme une date)` };
  }
  return { date };
}

/** Valide une heure obligatoire (startTime/endTime) — même distinction que parseRequiredDate
 * ci-dessus (cellule vide vs cellule renseignée mais imparsable), même message précis avec la
 * valeur brute reçue (revue durée de réservation, 2026-09-01). */
function parseRequiredTime(
  row: Record<string, unknown>,
  field: "startTime" | "endTime",
  column: string
): { time: string } | { error: string } {
  const raw = row[field];
  if (isCellEmpty(raw)) {
    return { error: `Colonne obligatoire manquante: ${column}` };
  }
  const time = cellToTime(raw);
  if (!isValidTimeString(time)) {
    return {
      error: `Colonne invalide: ${column} (valeur "${cellToString(raw) ?? raw}" non reconnue comme une heure valide, format attendu HH:mm)`,
    };
  }
  return { time };
}

export function parseReservationImportRow(
  row: Record<string, unknown>,
  knownAgencyNames?: Set<string>
): ParsedReservationRow {
  for (const { field, column } of REQUIRED_STRING_IMPORT_FIELDS) {
    if (!REQUIRED_STRING_VALUE_GETTERS[field](row)) {
      return { error: `Colonne obligatoire manquante: ${column}` };
    }
  }

  const startDateResult = parseRequiredDate(row, "startDate", "Date de départ");
  if ("error" in startDateResult) {
    return startDateResult;
  }
  const endDateResult = parseRequiredDate(row, "endDate", "Date de retour");
  if ("error" in endDateResult) {
    return endDateResult;
  }
  // Revue durée de réservation (2026-09-01, point 8) : heure de départ/retour désormais
  // obligatoires à l'import, même distinction cellule vide/imparsable que les dates ci-dessus,
  // message précis avec le numéro de ligne ajouté par l'appelant (POST /api/reservations/import).
  const startTimeResult = parseRequiredTime(row, "startTime", "Heure de départ");
  if ("error" in startTimeResult) {
    return startTimeResult;
  }
  const endTimeResult = parseRequiredTime(row, "endTime", "Heure de retour");
  if ("error" in endTimeResult) {
    return endTimeResult;
  }

  const voucherNumber = cellToString(row.voucherNumber) as string;
  const clientFirstName = cellToString(row.clientFirstName) as string;
  const clientLastName = cellToString(row.clientLastName) as string;
  const startDate = startDateResult.date;
  const endDate = endDateResult.date;
  const startTime = startTimeResult.time;
  const endTime = endTimeResult.time;

  // Revue durée de réservation (2026-09-01, point 4/5) : comparaison sur l'instant complet
  // date+heure (jamais la date seule) — un retour le même jour à une heure antérieure ou égale
  // au départ est désormais rejeté ici aussi, avec le numéro de ligne. `realDaysCount` (règle du
  // jour entamé) sert uniquement au contrôle ci-dessous, jamais à écraser `daysCount` (Sprint
  // 13B, valeur brute du fichier préservée telle quelle).
  let realDaysCount: number;
  try {
    ({ realDaysCount } = resolveReservationDuration(startDate, startTime, endDate, endTime));
  } catch (error) {
    if (error instanceof InvalidReservationDateRangeError) {
      return { error: "La date/l'heure de retour doit être strictement postérieure à la date/l'heure de départ." };
    }
    throw error;
  }

  const pickupAgency = cellToString(row.pickupAgency);
  const dropoffAgency = cellToString(row.dropoffAgency);

  // Validation des villes/agences (Sprint 14A) : révise la décision Sprint 12C de texte
  // libre non validé (voir DOMAINRULES.md section 21) — la valeur doit désormais
  // correspondre à la ville ou au nom d'une agence réelle du tenant (insensible à la
  // casse). `knownAgencyNames` non vide = le tenant a au moins une agence créée ; sinon la
  // validation est ignorée (rien à valider contre, pas de régression pour un tenant qui vient
  // de s'inscrire).
  if (knownAgencyNames && knownAgencyNames.size > 0) {
    if (pickupAgency && !knownAgencyNames.has(normalizeAgencyName(pickupAgency))) {
      return { error: `Ville de départ inconnue : "${pickupAgency}" (aucune agence correspondante)` };
    }
    if (dropoffAgency && !knownAgencyNames.has(normalizeAgencyName(dropoffAgency))) {
      return { error: `Ville de retour inconnue : "${dropoffAgency}" (aucune agence correspondante)` };
    }
  }

  // Sprint 15 : source est du texte libre (voir le commentaire du modèle dans
  // prisma/schema.prisma) — accepte tout code broker réel (TJS, DCH, CT...), pas seulement
  // BROKER/DIRECT. Jusqu'ici, toute valeur hors de ces deux littéraux était silencieusement
  // ignorée (undefined), d'où le tiret affiché à tort pour ces lignes importées.
  const source = normalizeSource(cellToString(row.source));

  const daysCount = cellToInt(row.daysCount);
  const totalPrice = cellToMoney(row.totalPrice);
  const pricePerDay = cellToMoney(row.pricePerDay);
  const gpsPrice = cellToMoney(row.gpsPrice);
  const babySeatPrice = cellToMoney(row.babySeatPrice);
  const extraDriverPrice = cellToMoney(row.extraDriverPrice);
  const mileage = cellToInt(row.mileage);
  const includedKm = cellToInt(row.includedKm);

  // Correctif (revue OWASP Phase 6, 2026-08-31) : `POST /api/reservations` (création manuelle,
  // src/app/api/reservations/route.ts, MONEY_FIELDS/INT_FIELDS) rejette déjà tout montant/entier
  // négatif — cette validation n'avait jamais été reproduite ici, si bien qu'un fichier importé
  // pouvait produire une réservation avec, par exemple, un `totalPrice` négatif qu'un utilisateur
  // ne pouvait jamais créer manuellement via la même API. `NUMERIC_IMPORT_FIELDS` couvre
  // exactement les mêmes champs, avec le même seuil (`>= 0`) — également plafonné à une valeur
  // bien en-deçà de la limite `Int` PostgreSQL (2^31-1) pour rejeter proprement une faute de
  // frappe grossière côté fichier plutôt que de laisser l'écriture échouer sans contrôle.
  const MAX_PLAUSIBLE_IMPORT_VALUE = 100_000_000_00; // 100 millions (unité courante) en centimes
  const NUMERIC_IMPORT_FIELDS: [string, number | undefined][] = [
    ["Jours", daysCount],
    ["Prix total", totalPrice],
    ["Prix / jour", pricePerDay],
    ["Prix GPS", gpsPrice],
    ["Prix siège bébé", babySeatPrice],
    ["Prix chauffeur additionnel", extraDriverPrice],
    ["Kilométrage", mileage],
    ["Kilométrage inclus", includedKm],
  ];
  for (const [column, value] of NUMERIC_IMPORT_FIELDS) {
    if (value !== undefined && (value < 0 || value > MAX_PLAUSIBLE_IMPORT_VALUE)) {
      return { error: `Colonne invalide: ${column} (valeur "${value}" hors bornes acceptées)` };
    }
  }

  // Revue durée de réservation (2026-09-01) : `daysCount` brut (colonne "Jours (facturés)")
  // n'est jamais recalculé/écrasé ici (Sprint 13B) — seulement comparé à `realDaysCount` pour
  // signaler une divergence dans le rapport d'import, sans jamais bloquer la ligne pour ce seul
  // motif (un écart peut légitimement exister, ex. un forfait broker à durée fixe).
  const daysCountWarning =
    daysCount !== undefined && daysCount !== realDaysCount
      ? `Jours importés (${daysCount}) différent(s) de la durée réelle calculée à partir des dates/heures (${realDaysCount}).`
      : undefined;

  return {
    data: {
      voucherNumber,
      confirmationNumber: cellToString(row.confirmationNumber),
      receivedAt: cellToDate(row.receivedAt),
      source,
      clientFirstName,
      clientLastName,
      startDate,
      startTime,
      endDate,
      endTime,
      daysCount,
      flightNumber: cellToString(row.flightNumber),
      currency: cellToString(row.currency),
      totalPrice,
      pricePerDay,
      vehicleCategory: cellToString(row.vehicleCategory),
      pickupAgency,
      dropoffAgency,
      hasGps: cellToBoolean(row.hasGps),
      gpsPrice,
      hasBabySeat: cellToBoolean(row.hasBabySeat),
      babySeatPrice,
      hasExtraDriver: cellToBoolean(row.hasExtraDriver),
      extraDriverPrice,
      optionsCurrency: cellToString(row.optionsCurrency),
      mileage,
      includedKm,
      clientPhone: cellToString(row.clientPhone),
      notes: cellToString(row.notes),
    },
    realDaysCount,
    ...(daysCountWarning ? { daysCountWarning } : {}),
  };
}

/** Normalise une ville/nom d'agence pour comparaison : trim, normalisation Unicode NFC (une
 * même ville accentuée peut arriver en forme composée "é" (NFC) ou décomposée "é" (NFD)
 * selon l'origine du fichier Excel/l'OS qui l'a produit — visuellement identiques, mais deux
 * séquences de code points différentes, donc `===`/`Set.has` les traiteraient comme distinctes
 * sans cette normalisation), puis minuscules. Un seul point d'entrée pour cette règle, réutilisé
 * par `getKnownAgencyNames`/la validation de `parseReservationImportRow` (aucune correspondance
 * approximative : normalisation stricte de forme, jamais de recherche par proximité) et par
 * `buildAgencyLookupMap`/`lookupAgencyId` ci-dessous, pour que la résolution d'agence (visibilité/
 * autorisation, section 37 DOMAINRULES.md) reste cohérente avec la validation. */
function normalizeAgencyName(value: string): string {
  return value.trim().normalize("NFC").toLowerCase();
}

/** Ensemble normalisé (minuscules, trim, NFC) des villes/noms d'agence du tenant — utilisé pour
 * valider pickupAgency/dropoffAgency à l'import (ci-dessus) et à la création manuelle
 * (POST /api/reservations). Vide si le tenant n'a aucune agence avec une ville renseignée
 * (la validation est alors ignorée par l'appelant, voir commentaire plus haut). */
export async function getKnownAgencyNames(tenantId: string): Promise<Set<string>> {
  const agencies = await prisma.agency.findMany({
    where: { tenantId },
    select: { city: true, name: true },
  });

  const names = new Set<string>();
  for (const agency of agencies) {
    if (agency.city) names.add(normalizeAgencyName(agency.city));
    if (agency.name) names.add(normalizeAgencyName(agency.name));
  }
  return names;
}

/** Sprint 19 (DOMAINRULES.md section 37) : ville/nom d'agence normalisé → agencyId, pour
 * résoudre pickupAgency/dropoffAgency (texte libre, inchangé) vers l'Agency réelle qu'il
 * désigne — sert uniquement à la visibilité/autorisation par agence
 * (canAccessReservationAgencies/canEditReservationAgency, src/lib/authz.ts), jamais à
 * l'affichage (qui reste basé sur le texte libre pickupAgency/dropoffAgency). Une ville/nom
 * partagé par plusieurs agences du tenant est délibérément exclue de la carte (ambiguïté,
 * aucune agence ne prévaut) — la réservation retombe alors sur le comportement antérieur au
 * Sprint 19 (visible à quiconque a reservations.view), voir getReservations. */
export type AgencyLookupMap = Map<string, string>;

export async function buildAgencyLookupMap(tenantId: string): Promise<AgencyLookupMap> {
  const agencies = await prisma.agency.findMany({ where: { tenantId }, select: { id: true, city: true, name: true } });

  const counts = new Map<string, number>();
  const map: AgencyLookupMap = new Map();
  for (const agency of agencies) {
    for (const value of [agency.city, agency.name]) {
      if (!value) continue;
      const normalized = normalizeAgencyName(value);
      if (!normalized) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      map.set(normalized, agency.id);
    }
  }
  for (const [key, count] of counts) {
    if (count > 1) map.delete(key);
  }
  return map;
}

function lookupAgencyId(map: AgencyLookupMap, cityOrName: string | null | undefined): string | null {
  if (!cityOrName) return null;
  return map.get(normalizeAgencyName(cityOrName)) ?? null;
}

export async function deleteReservation(tenantId: string, reservationId: string): Promise<boolean> {
  const existing = await getReservationById(tenantId, reservationId);
  if (!existing) {
    return false;
  }

  if (existing.status !== "PENDING" && existing.status !== "CANCELLED") {
    throw new ReservationNotDeletableError();
  }

  await prisma.reservation.delete({ where: { id: reservationId } });
  return true;
}

/**
 * Sprint 26A (Finding A) : réserve atomiquement une conversion, AVANT toute création de
 * donnée dépendante (client/second conducteur/location/facture/paiement/caisse) — toujours
 * appelée en tout premier à l'intérieur de la transaction Prisma partagée de
 * POST /api/reservations/[id]/convert (voir src/app/api/reservations/[id]/convert/route.ts).
 * Passe uniquement `status` à CONVERTED via un `updateMany` conditionné sur le statut
 * courant (même motif que `updateReservation`/`markReservationConverted` ci-dessous) —
 * `convertedLocationId` n'est pas encore connu à ce stade (la Location n'existe pas encore)
 * et est rattaché séparément par `markReservationConverted` une fois créée. Une deuxième
 * conversion concurrente de la même réservation obtient `count === 0` (la première a déjà
 * commité — ou est en train de committer — son passage à CONVERTED, verrou ligne Postgres)
 * et échoue proprement avant d'avoir rien créé, avec la même erreur que la machine à états
 * normale (`InvalidReservationStatusTransitionError`, 409).
 *
 * Phase 3 (INC-30) : un échec du CAS ci-dessous (`count === 0`) relit désormais le statut
 * réellement en base à cet instant, plutôt que de réutiliser `existing.status` (la valeur lue
 * *avant* l'écriture conditionnée, donc potentiellement déjà obsolète — c'est précisément
 * pour cette raison que le CAS a échoué). Sans ce correctif, le perdant d'une course légitime
 * recevait un message trompeur du type « Transition de statut invalide : PENDING →
 * CONVERTED. », qui laisse croire que PENDING → CONVERTED est en général interdit (faux — voir
 * ALLOWED_TRANSITIONS) au lieu de refléter la vraie cause (un autre appel a déjà gagné la
 * course entre-temps). La route appelante (POST /api/reservations/[id]/convert) construit
 * désormais un message métier clair à partir de `error.from` réellement à jour.
 */
export async function claimReservationConversion(
  tenantId: string,
  reservationId: string,
  tx: Prisma.TransactionClient
): Promise<Reservation> {
  const existing = await getReservationById(tenantId, reservationId, tx);
  if (!existing) {
    throw new ReservationNotFoundError();
  }

  if (!canTransition(existing.status, "CONVERTED")) {
    throw new InvalidReservationStatusTransitionError(existing.status, "CONVERTED");
  }

  const { count } = await tx.reservation.updateMany({
    where: { id: reservationId, status: existing.status },
    data: { status: "CONVERTED" },
  });
  if (count === 0) {
    const current = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    throw new InvalidReservationStatusTransitionError(current.status, "CONVERTED");
  }
  return tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
}

/** Marque la réservation CONVERTED et l'associe à la Location créée (voir la route
 * POST /api/reservations/[id]/convert pour l'orchestration complète : résolution/création
 * du client, dérivation de l'agence depuis le véhicule choisi, création de la Location
 * puis de la facture — même répartition route/lib que POST /api/locations, Sprint 12B).
 *
 * `tx` optionnel (Sprint 26A, défaut au client Prisma global) — comportement inchangé pour
 * tout appel sans transaction partagée : transition + rattachement de `convertedLocationId`
 * en une seule écriture atomique conditionnée, comme avant ce sprint. Nouvelle branche : si
 * la réservation est déjà CONVERTED mais sans `convertedLocationId` (réservée juste avant,
 * dans la même transaction, par `claimReservationConversion` ci-dessus), la transition est
 * déjà acquise — cet appel ne fait alors que rattacher la Location, sans revalider
 * `canTransition` (qui refuserait à tort CONVERTED → CONVERTED).
 */
export async function markReservationConverted(
  tenantId: string,
  reservationId: string,
  locationId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<Reservation | null> {
  const existing = await getReservationById(tenantId, reservationId, tx);
  if (!existing) {
    return null;
  }

  const alreadyClaimedByThisConversion = existing.status === "CONVERTED" && existing.convertedLocationId === null;

  if (alreadyClaimedByThisConversion) {
    return tx.reservation.update({
      where: { id: reservationId },
      data: { convertedLocationId: locationId },
    });
  }

  if (!canTransition(existing.status, "CONVERTED")) {
    throw new InvalidReservationStatusTransitionError(existing.status, "CONVERTED");
  }

  // Sprint 23 : même garde atomique que updateReservation ci-dessus — une conversion et une
  // action rapide (Annuler/No Show) quasi simultanées sur la même réservation ne doivent
  // jamais toutes deux réussir.
  const { count } = await tx.reservation.updateMany({
    where: { id: reservationId, status: existing.status },
    data: { status: "CONVERTED", convertedLocationId: locationId },
  });
  if (count === 0) {
    // Phase 3 (INC-30) : même correctif que claimReservationConversion ci-dessus — statut relu
    // après l'échec du CAS, jamais la valeur potentiellement obsolète lue avant.
    const current = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    throw new InvalidReservationStatusTransitionError(current.status, "CONVERTED");
  }
  return tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
}
