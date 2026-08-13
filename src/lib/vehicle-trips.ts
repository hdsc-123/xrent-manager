import type { VehicleTrip, VehicleTripStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getVehicleById } from "@/lib/vehicles";

export class VehicleTripVehicleNotFoundError extends Error {
  constructor() {
    super("Véhicule introuvable.");
    this.name = "VehicleTripVehicleNotFoundError";
  }
}

export class VehicleNotAvailableForTripError extends Error {
  constructor() {
    super("Ce véhicule n'est pas disponible pour un déplacement (statut actuel non AVAILABLE).");
    this.name = "VehicleNotAvailableForTripError";
  }
}

export class InvalidVehicleTripStatusTransitionError extends Error {
  constructor(from: VehicleTripStatus, to: VehicleTripStatus) {
    super(`Transition de statut invalide : ${from} → ${to}.`);
    this.name = "InvalidVehicleTripStatusTransitionError";
  }
}

export class VehicleTripNotEditableError extends Error {
  constructor() {
    super("Ce bon de déplacement est déjà COMPLETED ou CANCELLED, il ne peut plus être modifié.");
    this.name = "VehicleTripNotEditableError";
  }
}

/** Contrainte explicite du sprint : le kilométrage retour doit être STRICTEMENT supérieur au
 * kilométrage départ (contrairement au transfert, où >= suffit — un déplacement implique
 * nécessairement un minimum de trajet parcouru). */
export class InvalidVehicleTripOdometerError extends Error {
  constructor() {
    super("Le kilométrage de retour doit être strictement supérieur au kilométrage de départ.");
    this.name = "InvalidVehicleTripOdometerError";
  }
}

export class InvalidFuelLevelError extends Error {
  constructor() {
    super("Le niveau de carburant doit être un entier entre 0 et 100 (pourcentage).");
    this.name = "InvalidFuelLevelError";
  }
}

export class InvalidStartOdometerError extends Error {
  constructor() {
    super("startOdometer doit être un entier positif ou nul.");
    this.name = "InvalidStartOdometerError";
  }
}

/** Machine à états explicite (même principe que VehicleTransfer). Départ automatique à la
 * création (status IN_PROGRESS par défaut, voir createVehicleTrip). */
const ALLOWED_TRANSITIONS: Record<VehicleTripStatus, VehicleTripStatus[]> = {
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: VehicleTripStatus, to: VehicleTripStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

function validateFuelLevel(value: number | null | undefined): void {
  if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 0 || value > 100)) {
    throw new InvalidFuelLevelError();
  }
}

export interface VehicleTripFilters {
  agencyId?: string;
  vehicleId?: string;
  status?: VehicleTripStatus;
}

export async function getVehicleTrips(tenantId: string, filters: VehicleTripFilters = {}): Promise<VehicleTrip[]> {
  return prisma.vehicleTrip.findMany({
    where: {
      tenantId,
      ...(filters.agencyId ? { agencyId: filters.agencyId } : {}),
      ...(filters.vehicleId ? { vehicleId: filters.vehicleId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    orderBy: { departureDate: "desc" },
  });
}

export async function getVehicleTripById(tenantId: string, tripId: string): Promise<VehicleTrip | null> {
  return prisma.vehicleTrip.findFirst({ where: { id: tripId, tenantId } });
}

export interface CreateVehicleTripInput {
  tenantId: string;
  vehicleId: string;
  employeeUserId: string;
  reason: string;
  destination: string;
  departureDate?: Date;
  startOdometer: number;
  startFuelLevel?: number;
  remarks?: string;
}

/**
 * Départ automatique : agencyId dérivé du véhicule côté serveur (même principe que
 * Maintenance.agencyId), Vehicle.status → ON_TRIP dans la même transaction que la création,
 * pour éviter une course avec un transfert/déplacement concurrent sur le même véhicule.
 */
export async function createVehicleTrip(data: CreateVehicleTripInput): Promise<VehicleTrip> {
  const vehicle = await getVehicleById(data.tenantId, data.vehicleId);
  if (!vehicle) {
    throw new VehicleTripVehicleNotFoundError();
  }

  if (!Number.isInteger(data.startOdometer) || data.startOdometer < 0) {
    throw new InvalidStartOdometerError();
  }
  validateFuelLevel(data.startFuelLevel);

  return prisma.$transaction(async (tx) => {
    const freshVehicle = await tx.vehicle.findUnique({ where: { id: vehicle.id } });
    if (!freshVehicle || freshVehicle.status !== "AVAILABLE") {
      throw new VehicleNotAvailableForTripError();
    }

    const trip = await tx.vehicleTrip.create({
      data: {
        tenantId: data.tenantId,
        vehicleId: vehicle.id,
        agencyId: vehicle.agencyId,
        employeeUserId: data.employeeUserId,
        reason: data.reason,
        destination: data.destination,
        departureDate: data.departureDate ?? new Date(),
        startOdometer: data.startOdometer,
        startFuelLevel: data.startFuelLevel,
        remarks: data.remarks,
      },
    });

    await tx.vehicle.update({ where: { id: vehicle.id }, data: { status: "ON_TRIP" } });

    return trip;
  });
}

export interface ReturnVehicleTripInput {
  returnDate?: Date;
  endOdometer: number;
  endFuelLevel?: number;
  remarks?: string;
}

/** Retour du déplacement : bloque si endOdometer <= startOdometer (contrainte explicite du
 * sprint), repasse le véhicule AVAILABLE. */
export async function returnVehicleTrip(
  tenantId: string,
  tripId: string,
  data: ReturnVehicleTripInput
): Promise<VehicleTrip | null> {
  const existing = await getVehicleTripById(tenantId, tripId);
  if (!existing) {
    return null;
  }

  if (!canTransition(existing.status, "COMPLETED")) {
    throw new VehicleTripNotEditableError();
  }

  if (!Number.isInteger(data.endOdometer) || data.endOdometer <= existing.startOdometer) {
    throw new InvalidVehicleTripOdometerError();
  }
  validateFuelLevel(data.endFuelLevel);

  return prisma.$transaction(async (tx) => {
    const trip = await tx.vehicleTrip.update({
      where: { id: existing.id },
      data: {
        status: "COMPLETED",
        returnDate: data.returnDate ?? new Date(),
        endOdometer: data.endOdometer,
        endFuelLevel: data.endFuelLevel,
        remarks: data.remarks !== undefined ? data.remarks : existing.remarks,
      },
    });

    await tx.vehicle.update({ where: { id: existing.vehicleId }, data: { status: "AVAILABLE" } });

    return trip;
  });
}

export async function cancelVehicleTrip(tenantId: string, tripId: string): Promise<VehicleTrip | null> {
  const existing = await getVehicleTripById(tenantId, tripId);
  if (!existing) {
    return null;
  }

  if (!canTransition(existing.status, "CANCELLED")) {
    throw new VehicleTripNotEditableError();
  }

  return prisma.$transaction(async (tx) => {
    const trip = await tx.vehicleTrip.update({ where: { id: existing.id }, data: { status: "CANCELLED" } });
    await tx.vehicle.update({ where: { id: existing.vehicleId }, data: { status: "AVAILABLE" } });
    return trip;
  });
}
