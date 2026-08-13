import type { Reservation, ReservationStatus, ReservationSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export { combineDateAndTime, calculateDaysCount } from "@/lib/format";

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

export class InvalidReservationDateRangeError extends Error {
  constructor() {
    super("endDate doit être postérieure ou égale à startDate.");
    this.name = "InvalidReservationDateRangeError";
  }
}

export class InvalidReservationStatusTransitionError extends Error {
  constructor(from: ReservationStatus, to: ReservationStatus) {
    super(`Transition de statut invalide : ${from} → ${to}.`);
    this.name = "InvalidReservationStatusTransitionError";
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

/**
 * Machine à états explicite, même principe que Location (src/lib/locations.ts).
 * PENDING → CONVERTED directement est autorisé (une petite agence peut confirmer et
 * convertir en une seule étape) — même flexibilité que Maintenance SCHEDULED → COMPLETED
 * (src/lib/maintenances.ts). CONVERTED/CANCELLED sont terminaux.
 */
const ALLOWED_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  PENDING: ["CONFIRMED", "CONVERTED", "CANCELLED"],
  CONFIRMED: ["CONVERTED", "CANCELLED"],
  CONVERTED: [],
  CANCELLED: [],
};

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface ReservationFilters {
  status?: ReservationStatus;
  source?: ReservationSource;
  from?: Date;
  to?: Date;
  search?: string;
  /** Sprint 14A : filtres dédiés aux colonnes Ville de départ/retour/Catégorie, absents
   * jusqu'ici alors qu'elles sont affichées (voir ReservationsTable.tsx). Correspondance
   * exacte, insensible à la casse. */
  pickupAgency?: string;
  dropoffAgency?: string;
  vehicleCategory?: string;
}

export async function getReservations(
  tenantId: string,
  filters: ReservationFilters = {}
): Promise<Reservation[]> {
  return prisma.reservation.findMany({
    where: {
      tenantId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.source ? { source: filters.source } : {}),
      ...(filters.from ? { endDate: { gte: filters.from } } : {}),
      ...(filters.to ? { startDate: { lte: filters.to } } : {}),
      ...(filters.pickupAgency ? { pickupAgency: { equals: filters.pickupAgency, mode: "insensitive" } } : {}),
      ...(filters.dropoffAgency ? { dropoffAgency: { equals: filters.dropoffAgency, mode: "insensitive" } } : {}),
      ...(filters.vehicleCategory
        ? { vehicleCategory: { equals: filters.vehicleCategory, mode: "insensitive" } }
        : {}),
      ...(filters.search
        ? {
            OR: [
              { voucherNumber: { contains: filters.search, mode: "insensitive" } },
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

export async function getReservationById(tenantId: string, reservationId: string): Promise<Reservation | null> {
  return prisma.reservation.findFirst({ where: { id: reservationId, tenantId } });
}

export interface ReservationInputFields {
  voucherNumber: string;
  confirmationNumber?: string;
  receivedAt?: Date;
  source?: ReservationSource;
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

export async function createReservation(data: CreateReservationInput): Promise<Reservation> {
  if (data.endDate < data.startDate) {
    throw new InvalidReservationDateRangeError();
  }

  return prisma.reservation.create({
    data: {
      tenantId: data.tenantId,
      voucherNumber: data.voucherNumber,
      confirmationNumber: data.confirmationNumber,
      receivedAt: data.receivedAt,
      source: data.source,
      clientFirstName: data.clientFirstName,
      clientLastName: data.clientLastName,
      startDate: data.startDate,
      startTime: data.startTime,
      endDate: data.endDate,
      endTime: data.endTime,
      daysCount: data.daysCount,
      flightNumber: data.flightNumber,
      currency: data.currency ?? "MAD",
      totalPrice: data.totalPrice,
      pricePerDay: data.pricePerDay,
      vehicleCategory: data.vehicleCategory,
      pickupAgency: data.pickupAgency,
      dropoffAgency: data.dropoffAgency,
      hasGps: data.hasGps ?? false,
      gpsPrice: data.gpsPrice,
      hasBabySeat: data.hasBabySeat ?? false,
      babySeatPrice: data.babySeatPrice,
      hasExtraDriver: data.hasExtraDriver ?? false,
      extraDriverPrice: data.extraDriverPrice,
      mileage: data.mileage,
      includedKm: data.includedKm,
      clientPhone: data.clientPhone,
      notes: data.notes,
      status: data.status ?? "PENDING",
    },
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

  const nextStart = data.startDate ?? existing.startDate;
  const nextEnd = data.endDate ?? existing.endDate;
  if (nextEnd < nextStart) {
    throw new InvalidReservationDateRangeError();
  }

  if (data.status && data.status !== existing.status && !canTransition(existing.status, data.status)) {
    throw new InvalidReservationStatusTransitionError(existing.status, data.status);
  }

  return prisma.reservation.update({
    where: { id: reservationId },
    data: {
      ...(data.voucherNumber !== undefined ? { voucherNumber: data.voucherNumber } : {}),
      ...(data.confirmationNumber !== undefined ? { confirmationNumber: data.confirmationNumber } : {}),
      ...(data.receivedAt !== undefined ? { receivedAt: data.receivedAt } : {}),
      ...(data.source !== undefined ? { source: data.source } : {}),
      ...(data.clientFirstName !== undefined ? { clientFirstName: data.clientFirstName } : {}),
      ...(data.clientLastName !== undefined ? { clientLastName: data.clientLastName } : {}),
      ...(data.startDate !== undefined ? { startDate: data.startDate } : {}),
      ...(data.startTime !== undefined ? { startTime: data.startTime } : {}),
      ...(data.endDate !== undefined ? { endDate: data.endDate } : {}),
      ...(data.endTime !== undefined ? { endTime: data.endTime } : {}),
      ...(data.daysCount !== undefined ? { daysCount: data.daysCount } : {}),
      ...(data.flightNumber !== undefined ? { flightNumber: data.flightNumber } : {}),
      ...(data.currency !== undefined ? { currency: data.currency } : {}),
      ...(data.totalPrice !== undefined ? { totalPrice: data.totalPrice } : {}),
      ...(data.pricePerDay !== undefined ? { pricePerDay: data.pricePerDay } : {}),
      ...(data.vehicleCategory !== undefined ? { vehicleCategory: data.vehicleCategory } : {}),
      ...(data.pickupAgency !== undefined ? { pickupAgency: data.pickupAgency } : {}),
      ...(data.dropoffAgency !== undefined ? { dropoffAgency: data.dropoffAgency } : {}),
      ...(data.hasGps !== undefined ? { hasGps: data.hasGps } : {}),
      ...(data.gpsPrice !== undefined ? { gpsPrice: data.gpsPrice } : {}),
      ...(data.hasBabySeat !== undefined ? { hasBabySeat: data.hasBabySeat } : {}),
      ...(data.babySeatPrice !== undefined ? { babySeatPrice: data.babySeatPrice } : {}),
      ...(data.hasExtraDriver !== undefined ? { hasExtraDriver: data.hasExtraDriver } : {}),
      ...(data.extraDriverPrice !== undefined ? { extraDriverPrice: data.extraDriverPrice } : {}),
      ...(data.mileage !== undefined ? { mileage: data.mileage } : {}),
      ...(data.includedKm !== undefined ? { includedKm: data.includedKm } : {}),
      ...(data.clientPhone !== undefined ? { clientPhone: data.clientPhone } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
    },
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
export const REQUIRED_IMPORT_FIELDS: { field: string; column: string }[] = [
  { field: "voucherNumber", column: "Numéro voucher" },
  { field: "clientFirstName", column: "Prénom" },
  { field: "clientLastName", column: "Nom" },
  { field: "startDate", column: "Date de départ" },
  { field: "endDate", column: "Date de retour" },
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
 * (souvent comme MM/DD/YYYY ou pas du tout). */
const FRENCH_DATE_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

function cellToDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = excelSerialToDate(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const str = cellToString(value);
  if (!str) {
    return undefined;
  }
  const frenchMatch = str.match(FRENCH_DATE_RE);
  if (frenchMatch) {
    const [, day, month, year] = frenchMatch;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const date = new Date(str);
  return Number.isNaN(date.getTime()) ? undefined : date;
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
  | { data: Omit<CreateReservationInput, "tenantId"> }
  | { error: string };

const REQUIRED_STRING_IMPORT_FIELDS = REQUIRED_IMPORT_FIELDS.filter(
  ({ field }) => field !== "startDate" && field !== "endDate"
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

  const voucherNumber = cellToString(row.voucherNumber) as string;
  const clientFirstName = cellToString(row.clientFirstName) as string;
  const clientLastName = cellToString(row.clientLastName) as string;
  const startDate = startDateResult.date;
  const endDate = endDateResult.date;

  if (endDate < startDate) {
    return { error: "endDate doit être postérieure ou égale à startDate." };
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
    if (pickupAgency && !knownAgencyNames.has(pickupAgency.trim().toLowerCase())) {
      return { error: `Ville de départ inconnue : "${pickupAgency}" (aucune agence correspondante)` };
    }
    if (dropoffAgency && !knownAgencyNames.has(dropoffAgency.trim().toLowerCase())) {
      return { error: `Ville de retour inconnue : "${dropoffAgency}" (aucune agence correspondante)` };
    }
  }

  const sourceRaw = cellToString(row.source)?.toUpperCase();
  const source: ReservationSource | undefined =
    sourceRaw === "BROKER" || sourceRaw === "DIRECT" ? sourceRaw : undefined;

  return {
    data: {
      voucherNumber,
      confirmationNumber: cellToString(row.confirmationNumber),
      receivedAt: cellToDate(row.receivedAt),
      source,
      clientFirstName,
      clientLastName,
      startDate,
      startTime: cellToTime(row.startTime),
      endDate,
      endTime: cellToTime(row.endTime),
      daysCount: cellToInt(row.daysCount),
      flightNumber: cellToString(row.flightNumber),
      currency: cellToString(row.currency),
      totalPrice: cellToMoney(row.totalPrice),
      pricePerDay: cellToMoney(row.pricePerDay),
      vehicleCategory: cellToString(row.vehicleCategory),
      pickupAgency,
      dropoffAgency,
      hasGps: cellToBoolean(row.hasGps),
      gpsPrice: cellToMoney(row.gpsPrice),
      hasBabySeat: cellToBoolean(row.hasBabySeat),
      babySeatPrice: cellToMoney(row.babySeatPrice),
      hasExtraDriver: cellToBoolean(row.hasExtraDriver),
      extraDriverPrice: cellToMoney(row.extraDriverPrice),
      mileage: cellToInt(row.mileage),
      includedKm: cellToInt(row.includedKm),
      clientPhone: cellToString(row.clientPhone),
      notes: cellToString(row.notes),
    },
  };
}

/** Ensemble normalisé (minuscules, trim) des villes/noms d'agence du tenant — utilisé pour
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
    if (agency.city) names.add(agency.city.trim().toLowerCase());
    if (agency.name) names.add(agency.name.trim().toLowerCase());
  }
  return names;
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

/** Marque la réservation CONVERTED et l'associe à la Location créée (voir la route
 * POST /api/reservations/[id]/convert pour l'orchestration complète : résolution/création
 * du client, dérivation de l'agence depuis le véhicule choisi, création de la Location
 * puis de la facture — même répartition route/lib que POST /api/locations, Sprint 12B). */
export async function markReservationConverted(
  tenantId: string,
  reservationId: string,
  locationId: string
): Promise<Reservation | null> {
  const existing = await getReservationById(tenantId, reservationId);
  if (!existing) {
    return null;
  }

  if (!canTransition(existing.status, "CONVERTED")) {
    throw new InvalidReservationStatusTransitionError(existing.status, "CONVERTED");
  }

  return prisma.reservation.update({
    where: { id: reservationId },
    data: { status: "CONVERTED", convertedLocationId: locationId },
  });
}
