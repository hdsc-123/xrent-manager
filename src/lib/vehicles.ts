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
  /** Optionnel (Sprint 14A) — purement informatif, jamais la source de vérité de la
   * facturation (voir DOMAINRULES.md section 5/7). */
  pricePerDay?: number;
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
  /** Sprint 19 (DOMAINRULES.md section 37) — alertes proactives, tous optionnels. */
  insuranceExpiryDate?: Date;
  vignetteExpiryDate?: Date;
  technicalInspectionExpiryDate?: Date;
  nextOilChangeDate?: Date;
  nextOilChangeKm?: number;
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
  pricePerDay?: number | null;
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
  /** Sprint 19 (DOMAINRULES.md section 37) — alertes proactives, tous optionnels. */
  insuranceExpiryDate?: Date | null;
  vignetteExpiryDate?: Date | null;
  technicalInspectionExpiryDate?: Date | null;
  nextOilChangeDate?: Date | null;
  nextOilChangeKm?: number | null;
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

/**
 * Sprint 16 (audit sécurité) : sélection explicite de champs non sensibles uniquement
 * (id/dates/statut) — ce résultat est renvoyé tel quel au client par VehicleNotAvailableError
 * (src/lib/locations.ts) dès qu'une création/modification de location échoue faute de
 * disponibilité, y compris à un appelant n'ayant que locations.create/edit sans
 * locations.view. Avant ce correctif, le enregistrement Location complet (prix, caution,
 * notes, clientId) fuitait dans ce cas, contournant de fait le gate locations.view.
 */
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
    select: { id: true, startDate: true, endDate: true, status: true },
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

export interface VehicleLastKnownState {
  odometer: number | null;
  fuelLevel: number | null;
}

/**
 * Sprint 19 (DOMAINRULES.md section 37) : dernier kilométrage/niveau de carburant connus d'un
 * véhicule, pour pré-remplir automatiquement le départ d'un transfert/bon de déplacement
 * (au lieu de champs toujours vides jusqu'ici) — le plus récent parmi le retour de sa dernière
 * Location, son dernier VehicleTransfer ou son dernier VehicleTrip. `null` si aucune donnée de
 * retour n'existe encore pour ce véhicule (jamais loué/transféré/déplacé) — les champs restent
 * alors vides et modifiables normalement, aucune valeur inventée.
 *
 * Sprint 23 : Location gagne startFuelLevel/endFuelLevel (voir prisma/schema.prisma) — la
 * candidate Location contribue désormais aussi un niveau de carburant réel, plus jamais
 * systématiquement `null` comme avant ce sprint.
 */
export async function getVehicleLastKnownState(
  tenantId: string,
  vehicleId: string
): Promise<VehicleLastKnownState> {
  const [lastLocation, lastTransfer, lastTrip] = await Promise.all([
    prisma.location.findFirst({
      where: { tenantId, vehicleId, endOdometer: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { endOdometer: true, endFuelLevel: true, updatedAt: true },
    }),
    prisma.vehicleTransfer.findFirst({
      where: { tenantId, vehicleId, endOdometer: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { endOdometer: true, endFuelLevel: true, updatedAt: true },
    }),
    prisma.vehicleTrip.findFirst({
      where: { tenantId, vehicleId, endOdometer: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { endOdometer: true, endFuelLevel: true, updatedAt: true },
    }),
  ]);

  const candidates: { odometer: number | null; fuelLevel: number | null; at: Date }[] = [];
  if (lastLocation)
    candidates.push({ odometer: lastLocation.endOdometer, fuelLevel: lastLocation.endFuelLevel, at: lastLocation.updatedAt });
  if (lastTransfer)
    candidates.push({ odometer: lastTransfer.endOdometer, fuelLevel: lastTransfer.endFuelLevel, at: lastTransfer.updatedAt });
  if (lastTrip) candidates.push({ odometer: lastTrip.endOdometer, fuelLevel: lastTrip.endFuelLevel, at: lastTrip.updatedAt });

  if (candidates.length === 0) {
    return { odometer: null, fuelLevel: null };
  }

  const latest = candidates.reduce((a, b) => (b.at > a.at ? b : a));
  return { odometer: latest.odometer, fuelLevel: latest.fuelLevel };
}
