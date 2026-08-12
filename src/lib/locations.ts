import type { Location, LocationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getVehicleById, checkAvailability } from "@/lib/vehicles";
import { getClientById } from "@/lib/clients";

export class InvalidDateRangeError extends Error {
  constructor() {
    super("endDate doit être postérieure à startDate.");
    this.name = "InvalidDateRangeError";
  }
}

export class VehicleNotFoundError extends Error {
  constructor() {
    super("Véhicule introuvable.");
    this.name = "VehicleNotFoundError";
  }
}

export class ClientNotFoundError extends Error {
  constructor() {
    super("Client introuvable.");
    this.name = "ClientNotFoundError";
  }
}

export class VehicleNotAvailableError extends Error {
  conflictingLocations: Location[];

  constructor(conflictingLocations: Location[]) {
    super("Le véhicule n'est pas disponible sur cette période.");
    this.name = "VehicleNotAvailableError";
    this.conflictingLocations = conflictingLocations;
  }
}

export class InvalidStatusTransitionError extends Error {
  constructor(from: LocationStatus, to: LocationStatus) {
    super(`Transition de statut invalide : ${from} → ${to}.`);
    this.name = "InvalidStatusTransitionError";
  }
}

export class LocationNotDeletableError extends Error {
  constructor() {
    super("Seule une location PENDING ou CANCELLED peut être supprimée ; sinon, annulez-la (status).");
    this.name = "LocationNotDeletableError";
  }
}

export class LocationHasInvoiceError extends Error {
  constructor() {
    super(
      "Cette location a une facture SENT/PARTIALLY_PAID/PAID ou avec un paiement enregistré ; " +
        "annulez ou supprimez la facture (voir DELETE /api/invoices/[id]) avant de supprimer la location."
    );
    this.name = "LocationHasInvoiceError";
  }
}

/**
 * Machine à états explicite (ARCHITECTURE.md section 12) : aucune transition non listée
 * n'est autorisée. COMPLETED et CANCELLED sont des états terminaux.
 */
const ALLOWED_TRANSITIONS: Record<LocationStatus, LocationStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: LocationStatus, to: LocationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Nombre de jours arrondi au jour supérieur, minimum 1 jour. */
export function calculateTotalPrice(pricePerDay: number, start: Date, end: Date): number {
  const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
  return pricePerDay * days;
}

export interface LocationFilters {
  vehicleId?: string;
  clientId?: string;
  agencyId?: string;
  status?: LocationStatus;
  from?: Date;
  to?: Date;
}

export async function getLocations(tenantId: string, filters: LocationFilters = {}): Promise<Location[]> {
  return prisma.location.findMany({
    where: {
      tenantId,
      ...(filters.vehicleId ? { vehicleId: filters.vehicleId } : {}),
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.agencyId ? { agencyId: filters.agencyId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.from ? { endDate: { gte: filters.from } } : {}),
      ...(filters.to ? { startDate: { lte: filters.to } } : {}),
    },
    orderBy: { startDate: "desc" },
  });
}

export async function getLocationById(tenantId: string, locationId: string): Promise<Location | null> {
  return prisma.location.findFirst({ where: { id: locationId, tenantId } });
}

export interface CreateLocationInput {
  tenantId: string;
  agencyId: string;
  vehicleId: string;
  clientId: string;
  startDate: Date;
  endDate: Date;
  status?: LocationStatus;
  notes?: string;
  startOdometer?: number;
  endOdometer?: number;
  deposit?: number;
}

/**
 * Vérifie la disponibilité du véhicule et calcule totalPrice à partir du pricePerDay
 * du véhicule au moment de la création (snapshot immuable : un changement ultérieur
 * du tarif du véhicule ne doit pas modifier rétroactivement une location existante).
 */
export async function createLocation(data: CreateLocationInput): Promise<Location> {
  if (data.endDate <= data.startDate) {
    throw new InvalidDateRangeError();
  }

  const vehicle = await getVehicleById(data.tenantId, data.vehicleId);
  if (!vehicle) {
    throw new VehicleNotFoundError();
  }

  const client = await getClientById(data.tenantId, data.clientId);
  if (!client) {
    throw new ClientNotFoundError();
  }

  const availability = await checkAvailability(data.tenantId, data.vehicleId, data.startDate, data.endDate);
  if (!availability?.available) {
    throw new VehicleNotAvailableError(availability?.conflictingLocations ?? []);
  }

  const totalPrice = calculateTotalPrice(vehicle.pricePerDay, data.startDate, data.endDate);

  return prisma.location.create({
    data: {
      tenantId: data.tenantId,
      agencyId: data.agencyId,
      vehicleId: data.vehicleId,
      clientId: data.clientId,
      startDate: data.startDate,
      endDate: data.endDate,
      status: data.status ?? "PENDING",
      pricePerDay: vehicle.pricePerDay,
      currency: vehicle.currency,
      totalPrice,
      notes: data.notes,
      startOdometer: data.startOdometer,
      endOdometer: data.endOdometer,
      deposit: data.deposit,
    },
  });
}

export interface UpdateLocationInput {
  startDate?: Date;
  endDate?: Date;
  status?: LocationStatus;
  notes?: string;
  startOdometer?: number | null;
  endOdometer?: number | null;
  deposit?: number | null;
}

export async function updateLocation(
  tenantId: string,
  locationId: string,
  data: UpdateLocationInput
): Promise<Location | null> {
  const existing = await getLocationById(tenantId, locationId);
  if (!existing) {
    return null;
  }

  const nextStart = data.startDate ?? existing.startDate;
  const nextEnd = data.endDate ?? existing.endDate;

  if (nextEnd <= nextStart) {
    throw new InvalidDateRangeError();
  }

  if (data.startDate || data.endDate) {
    const availability = await checkAvailability(
      tenantId,
      existing.vehicleId,
      nextStart,
      nextEnd,
      existing.id
    );
    if (!availability?.available) {
      throw new VehicleNotAvailableError(availability?.conflictingLocations ?? []);
    }
  }

  if (data.status && data.status !== existing.status && !canTransition(existing.status, data.status)) {
    throw new InvalidStatusTransitionError(existing.status, data.status);
  }

  const totalPrice =
    data.startDate || data.endDate
      ? calculateTotalPrice(existing.pricePerDay, nextStart, nextEnd)
      : existing.totalPrice;

  return prisma.location.update({
    where: { id: locationId },
    data: {
      startDate: nextStart,
      endDate: nextEnd,
      totalPrice,
      ...(data.status ? { status: data.status } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.startOdometer !== undefined ? { startOdometer: data.startOdometer } : {}),
      ...(data.endOdometer !== undefined ? { endOdometer: data.endOdometer } : {}),
      ...(data.deposit !== undefined ? { deposit: data.deposit } : {}),
    },
  });
}

/**
 * Une Invoice DRAFT sans paiement est un simple sous-produit de la génération automatique
 * à la création de la location (voir POST /api/locations) : elle est supprimée avec la
 * location. Toute facture allée au-delà (SENT/PARTIALLY_PAID/PAID) ou ayant reçu un
 * paiement (amountPaid > 0, y compris CANCELLED avec historique de paiement) est un vrai
 * document métier et bloque la suppression — même règle que deleteInvoice (src/lib/invoices.ts).
 */
export async function deleteLocation(tenantId: string, locationId: string): Promise<boolean> {
  const existing = await getLocationById(tenantId, locationId);
  if (!existing) {
    return false;
  }

  if (existing.status !== "PENDING" && existing.status !== "CANCELLED") {
    throw new LocationNotDeletableError();
  }

  const invoices = await prisma.invoice.findMany({ where: { locationId } });
  const hasNonDeletableInvoice = invoices.some(
    (invoice) => invoice.status !== "DRAFT" || invoice.amountPaid > 0
  );
  if (hasNonDeletableInvoice) {
    throw new LocationHasInvoiceError();
  }

  await prisma.$transaction([
    prisma.invoice.deleteMany({ where: { locationId } }),
    prisma.location.delete({ where: { id: locationId } }),
  ]);
  return true;
}
