import type { Reservation, ReservationStatus, ReservationSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";

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
      ...(filters.search
        ? {
            OR: [
              { voucherNumber: { contains: filters.search, mode: "insensitive" } },
              { clientFirstName: { contains: filters.search, mode: "insensitive" } },
              { clientLastName: { contains: filters.search, mode: "insensitive" } },
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
 * Import Excel (Sprint 12C) : en-têtes exacts attendus = les noms de champs ci-dessous
 * (voir l'énoncé du sprint, "champs dans l'ordre Excel"). Colonnes requises minimales :
 * voucherNumber, clientFirstName, clientLastName, startDate, endDate.
 */
export const RESERVATION_IMPORT_COLUMNS = [
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

export const REQUIRED_IMPORT_COLUMNS = [
  "voucherNumber",
  "clientFirstName",
  "clientLastName",
  "startDate",
  "endDate",
] as const;

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
    return normalized === "OUI" || normalized === "TRUE" || normalized === "1" || normalized === "YES";
  }
  return false;
}

function cellToDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return value;
  }
  const str = cellToString(value);
  if (!str) {
    return undefined;
  }
  const date = new Date(str);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export type ParsedReservationRow =
  | { data: Omit<CreateReservationInput, "tenantId"> }
  | { error: string };

export function parseReservationImportRow(row: Record<string, unknown>): ParsedReservationRow {
  const voucherNumber = cellToString(row.voucherNumber);
  const clientFirstName = cellToString(row.clientFirstName);
  const clientLastName = cellToString(row.clientLastName);
  const startDate = cellToDate(row.startDate);
  const endDate = cellToDate(row.endDate);

  if (!voucherNumber || !clientFirstName || !clientLastName || !startDate || !endDate) {
    return {
      error: `Colonnes requises manquantes ou invalides (${REQUIRED_IMPORT_COLUMNS.join(", ")}).`,
    };
  }

  if (endDate < startDate) {
    return { error: "endDate doit être postérieure ou égale à startDate." };
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
      startTime: cellToString(row.startTime),
      endDate,
      endTime: cellToString(row.endTime),
      daysCount: cellToInt(row.daysCount),
      flightNumber: cellToString(row.flightNumber),
      currency: cellToString(row.currency),
      totalPrice: cellToMoney(row.totalPrice),
      pricePerDay: cellToMoney(row.pricePerDay),
      vehicleCategory: cellToString(row.vehicleCategory),
      pickupAgency: cellToString(row.pickupAgency),
      dropoffAgency: cellToString(row.dropoffAgency),
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
 * Combine une date (typiquement minuit UTC, telle qu'importée/saisie) et une heure
 * "HH:mm" en un DateTime unique, en UTC (DOMAINRULES.md section 15). Sans heure fournie
 * ou heure non reconnue, la date est renvoyée telle quelle.
 */
export function combineDateAndTime(date: Date, time?: string): Date {
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
