import type { Vehicle, VehicleStatus, TransmissionType, FuelType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Statuts d'une Location qui occupent effectivement le véhicule sur sa période. */
const BLOCKING_LOCATION_STATUSES = ["PENDING", "CONFIRMED", "ACTIVE"] as const;

export class VehicleHasLocationsError extends Error {
  constructor() {
    super("Impossible de supprimer un véhicule ayant des locations.");
    this.name = "VehicleHasLocationsError";
  }
}

export interface VehicleFilters {
  agencyId?: string;
  status?: VehicleStatus;
  category?: string;
  search?: string;
}

export async function getVehicles(tenantId: string, filters: VehicleFilters = {}): Promise<Vehicle[]> {
  return prisma.vehicle.findMany({
    where: {
      tenantId,
      ...(filters.agencyId ? { agencyId: filters.agencyId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: "insensitive" } },
              { licensePlate: { contains: filters.search, mode: "insensitive" } },
              { make: { contains: filters.search, mode: "insensitive" } },
              { model: { contains: filters.search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getVehicleById(tenantId: string, vehicleId: string): Promise<Vehicle | null> {
  return prisma.vehicle.findFirst({ where: { id: vehicleId, tenantId } });
}

export interface CreateVehicleInput {
  tenantId: string;
  agencyId: string;
  name: string;
  licensePlate: string;
  make: string;
  model: string;
  year: number;
  category: string;
  status?: VehicleStatus;
  pricePerDay: number;
  currency?: string;
  ww?: string;
  chassisNumber?: string;
  color?: string;
  doors?: number;
  seats?: number;
  transmission?: TransmissionType;
  fuel?: FuelType;
  horsepower?: number;
  powerKW?: number;
  engineSize?: number;
  ac?: boolean;
  gps?: boolean;
  imageUrl?: string;
}

export async function createVehicle(data: CreateVehicleInput): Promise<Vehicle> {
  return prisma.vehicle.create({ data });
}

export interface UpdateVehicleInput {
  agencyId?: string;
  name?: string;
  licensePlate?: string;
  make?: string;
  model?: string;
  year?: number;
  category?: string;
  status?: VehicleStatus;
  pricePerDay?: number;
  currency?: string;
  ww?: string | null;
  chassisNumber?: string | null;
  color?: string | null;
  doors?: number | null;
  seats?: number | null;
  transmission?: TransmissionType;
  fuel?: FuelType;
  horsepower?: number | null;
  powerKW?: number | null;
  engineSize?: number | null;
  ac?: boolean;
  gps?: boolean;
  imageUrl?: string | null;
}

export async function updateVehicle(
  tenantId: string,
  vehicleId: string,
  data: UpdateVehicleInput
): Promise<Vehicle | null> {
  const existing = await getVehicleById(tenantId, vehicleId);
  if (!existing) {
    return null;
  }

  return prisma.vehicle.update({ where: { id: vehicleId }, data });
}

export async function deleteVehicle(tenantId: string, vehicleId: string): Promise<boolean> {
  const existing = await getVehicleById(tenantId, vehicleId);
  if (!existing) {
    return false;
  }

  const locationCount = await prisma.location.count({ where: { vehicleId } });
  if (locationCount > 0) {
    throw new VehicleHasLocationsError();
  }

  await prisma.vehicle.delete({ where: { id: vehicleId } });
  return true;
}

export interface AvailabilityResult {
  available: boolean;
  conflictingLocations: Awaited<ReturnType<typeof findConflictingLocations>>;
}

function findConflictingLocations(
  vehicleId: string,
  start: Date,
  end: Date,
  excludeLocationId?: string
) {
  return prisma.location.findMany({
    where: {
      vehicleId,
      status: { in: [...BLOCKING_LOCATION_STATUSES] },
      startDate: { lt: end },
      endDate: { gt: start },
      ...(excludeLocationId ? { id: { not: excludeLocationId } } : {}),
    },
    orderBy: { startDate: "asc" },
  });
}

/**
 * Deux périodes se chevauchent si newStart < existingEnd && newEnd > existingStart
 * (chevauchement strict — une reprise le jour même de la restitution d'une autre
 * location n'est pas considérée comme un conflit). Seules les locations aux statuts
 * PENDING/CONFIRMED/ACTIVE bloquent la disponibilité (CANCELLED/COMPLETED ne comptent pas).
 */
export async function checkAvailability(
  tenantId: string,
  vehicleId: string,
  start: Date,
  end: Date,
  excludeLocationId?: string
): Promise<AvailabilityResult | null> {
  const vehicle = await getVehicleById(tenantId, vehicleId);
  if (!vehicle) {
    return null;
  }

  const conflictingLocations = await findConflictingLocations(vehicleId, start, end, excludeLocationId);

  return { available: conflictingLocations.length === 0, conflictingLocations };
}
