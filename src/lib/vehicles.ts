import type { Vehicle, VehicleStatus, TransmissionType, FuelType, Maintenance, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Statuts d'une Location qui occupent effectivement le véhicule sur sa période. */
const BLOCKING_LOCATION_STATUSES = ["PENDING", "CONFIRMED", "ACTIVE"] as const;

/** Statuts d'une Maintenance qui occupent effectivement le véhicule sur sa période (Sprint 34
 * étape 3, DOMAINRULES.md section 50) — même principe que BLOCKING_LOCATION_STATUSES : seuls
 * les statuts non terminaux bloquent, COMPLETED/CANCELLED ne comptent jamais. Exportée (sprint
 * "statut opérationnel automatique", 2026-08-28) pour être réutilisée telle quelle par
 * src/lib/vehicle-status.ts, qui doit appliquer exactement la même définition d'une
 * "maintenance immobilisante active" que le contrôle de conflit ci-dessous. */
export const BLOCKING_MAINTENANCE_STATUSES = ["SCHEDULED", "IN_PROGRESS"] as const;

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
  /** Sprint "statut opérationnel automatique" (2026-08-28) — réservé aux sélecteurs
   * opérationnels (choix d'un véhicule pour une nouvelle Location/Maintenance/VehicleTransfer/
   * VehicleTrip) : un véhicule désactivé administrativement ne doit jamais y apparaître, même
   * si son statut opérationnel calculé est AVAILABLE. La liste principale `/dashboard/vehicles`
   * ne l'utilise jamais (un véhicule désactivé doit y rester visible, badge « Désactivé »). */
  excludeDeactivated?: boolean;
}

export async function getVehicles(tenantId: string, filters: VehicleFilters = {}): Promise<Vehicle[]> {
  return prisma.vehicle.findMany({
    where: {
      tenantId,
      ...(filters.agencyId ? { agencyId: filters.agencyId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.excludeDeactivated ? { deactivatedAt: null } : {}),
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
  // `status` retiré (sprint "statut opérationnel automatique", 2026-08-28) : plus jamais
  // saisi, ni par le client ni par cette fonction — toute nouvelle Vehicle reçoit le défaut
  // du schéma (AVAILABLE, cohérent avec l'absence de toute opération active à la création).
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
  /** Sprint 24 — kilométrage/carburant actuels à la création (voir prisma/schema.prisma). */
  currentOdometer?: number;
  currentFuelLevel?: number;
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
  // `status` retiré (sprint "statut opérationnel automatique", 2026-08-28) : plus jamais
  // modifiable via cette fonction générique — seules les transitions automatiques
  // (src/lib/vehicle-status.ts, syncVehicleStatus) écrivent Vehicle.status. La désactivation
  // administrative (deactivatedAt/deactivatedReason/deactivatedById) passe exclusivement par
  // deactivateVehicle/reactivateVehicle ci-dessous, jamais par updateVehicle.
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
  /** Sprint 24 — kilométrage/carburant actuels (voir prisma/schema.prisma). */
  currentOdometer?: number | null;
  currentFuelLevel?: number | null;
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

/**
 * Désactivation/réactivation administrative (sprint "statut opérationnel automatique",
 * 2026-08-28) — remplace l'ancien `VehicleStatus.INACTIVE`. Décision réservée ADMIN (contrôle
 * de rôle strict côté route, même principe que `adminCancelInvoice`/
 * `adminCancelValidatedLocation`, DOMAINRULES.md section 43 — pas une permission granulaire),
 * orthogonale au statut opérationnel calculé (`src/lib/vehicle-status.ts`). Ces deux fonctions
 * sont les seules à écrire `deactivatedAt`/`deactivatedReason`/`deactivatedById` — jamais
 * `updateVehicle` ci-dessus.
 */
export class VehicleAlreadyDeactivatedError extends Error {
  constructor() {
    super("Ce véhicule est déjà désactivé.");
    this.name = "VehicleAlreadyDeactivatedError";
  }
}

export class VehicleNotDeactivatedError extends Error {
  constructor() {
    super("Ce véhicule n'est pas désactivé.");
    this.name = "VehicleNotDeactivatedError";
  }
}

export class DeactivationReasonRequiredError extends Error {
  constructor() {
    super("Un motif est obligatoire pour désactiver un véhicule.");
    this.name = "DeactivationReasonRequiredError";
  }
}

export async function deactivateVehicle(
  tenantId: string,
  vehicleId: string,
  reason: string,
  performedByUserId: string
): Promise<Vehicle | null> {
  if (!reason || reason.trim() === "") {
    throw new DeactivationReasonRequiredError();
  }

  const existing = await getVehicleById(tenantId, vehicleId);
  if (!existing) {
    return null;
  }
  if (existing.deactivatedAt) {
    throw new VehicleAlreadyDeactivatedError();
  }

  return prisma.vehicle.update({
    where: { id: vehicleId },
    data: { deactivatedAt: new Date(), deactivatedReason: reason.trim(), deactivatedById: performedByUserId },
  });
}

export async function reactivateVehicle(tenantId: string, vehicleId: string): Promise<Vehicle | null> {
  const existing = await getVehicleById(tenantId, vehicleId);
  if (!existing) {
    return null;
  }
  if (!existing.deactivatedAt) {
    throw new VehicleNotDeactivatedError();
  }

  return prisma.vehicle.update({
    where: { id: vehicleId },
    data: { deactivatedAt: null, deactivatedReason: null, deactivatedById: null },
  });
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
 *
 * `tx` optionnel (Sprint 26C, Finding C) — défaut au client Prisma global, comportement
 * inchangé pour tout appel sans transaction partagée (ex. GET /api/vehicles/[id]/availability,
 * simple lecture d'affichage, jamais suivie d'une écriture). Un appelant à l'intérieur d'une
 * transaction Prisma partagée (createLocation/updateLocation, src/lib/locations.ts) doit le
 * fournir explicitement pour lire l'état réellement à jour une fois le verrou Vehicle acquis
 * (voir lockVehicleForUpdate ci-dessous).
 */
export function findConflictingLocations(
  vehicleId: string,
  start: Date,
  end: Date,
  excludeLocationId?: string,
  tx: Prisma.TransactionClient = prisma
) {
  return tx.location.findMany({
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
 * Sprint 34 étape 3 (DOMAINRULES.md section 50) : chevauchement strict entre deux périodes
 * ([aStart, aEnd) vs [bStart, bEnd)) — définition unique, réutilisée par findConflictingLocations
 * (formule dupliquée en ligne jusqu'ici, non touchée pour ne pas modifier une requête Prisma déjà
 * en production sans besoin réel), findConflictingMaintenances ci-dessous, et par l'affichage de
 * disponibilité du véhicule (/dashboard/vehicles/[id]) pour ne jamais recalculer un chevauchement
 * différemment entre la validation serveur et son affichage.
 */
export function periodsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * Sprint 34 étape 3 (DOMAINRULES.md section 50) : fin effective de la période bloquante d'une
 * maintenance — `scheduledEndDate` si renseignée, sinon `scheduledDate` + 24h (une maintenance
 * créée sans fin explicite bloque au moins toute sa journée prévue, jamais un instant zéro qui ne
 * bloquerait jamais rien). Factorisée ici pour être réutilisée à l'identique partout où une
 * période de maintenance doit être comparée à une autre période (Location, VehicleTransfer,
 * VehicleTrip) — jamais recalculée différemment d'un appelant à l'autre.
 *
 * INC-21 (2026-08-29) : l'ancien calcul (« fin du jour calendaire de `scheduledDate` », via
 * `setHours(23,59,59,999)`) ne garantissait pas réellement « au moins toute sa journée prévue »
 * dès que `scheduledDate` tombait dans la dernière heure avant minuit — une maintenance planifiée
 * à 23h26 se voyait alors une fin effective à 23h59 le même jour, soit ~33 minutes de blocage
 * réel au lieu d'une journée, dès que l'heure courante franchissait minuit. Un décalage fixe de
 * 24h à partir de `scheduledDate` respecte la garantie documentée quelle que soit l'heure de
 * planification, sans dépendre d'aucun fuseau horaire local.
 */
export function getMaintenanceEffectiveEnd(maintenance: Pick<Maintenance, "scheduledDate" | "scheduledEndDate">): Date {
  if (maintenance.scheduledEndDate) {
    return maintenance.scheduledEndDate;
  }
  return new Date(maintenance.scheduledDate.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Sprint 34 étape 3 (DOMAINRULES.md section 50) : maintenances SCHEDULED/IN_PROGRESS d'un
 * véhicule dont la période bloquante chevauche [start, end) — même formule de chevauchement
 * strict que findConflictingLocations ci-dessus (newStart < existingEnd && newEnd > existingStart),
 * réutilisée pour rester cohérente avec la définition déjà établie d'un "chevauchement". La fin
 * effective n'étant pas une colonne stockée (voir getMaintenanceEffectiveEnd), le filtre SQL ne
 * peut porter que sur un sur-ensemble (scheduledDate < end) ; le filtrage exact sur la fin
 * effective se fait ensuite en mémoire — les volumes par véhicule restent faibles (quelques
 * maintenances tout au plus), sans impact de performance réel.
 */
export async function findConflictingMaintenances(
  vehicleId: string,
  start: Date,
  end: Date,
  excludeMaintenanceId?: string,
  tx: Prisma.TransactionClient = prisma
): Promise<Pick<Maintenance, "id" | "scheduledDate" | "scheduledEndDate" | "status" | "type">[]> {
  const candidates = await tx.maintenance.findMany({
    where: {
      vehicleId,
      status: { in: [...BLOCKING_MAINTENANCE_STATUSES] },
      scheduledDate: { lt: end },
      ...(excludeMaintenanceId ? { id: { not: excludeMaintenanceId } } : {}),
    },
    select: { id: true, scheduledDate: true, scheduledEndDate: true, status: true, type: true },
    orderBy: { scheduledDate: "asc" },
  });

  return candidates.filter((maintenance) => periodsOverlap(start, end, maintenance.scheduledDate, getMaintenanceEffectiveEnd(maintenance)));
}

/**
 * Deux périodes se chevauchent si newStart < existingEnd && newEnd > existingStart
 * (chevauchement strict — une reprise le jour même de la restitution d'une autre
 * location n'est pas considérée comme un conflit). Seules les locations aux statuts
 * PENDING/CONFIRMED/ACTIVE bloquent la disponibilité (CANCELLED/COMPLETED ne comptent pas).
 *
 * `tx` optionnel (Sprint 26C, Finding C) — voir le commentaire de findConflictingLocations
 * ci-dessus. Une vérification faite via ce paramètre, à l'intérieur d'une transaction où le
 * véhicule est déjà verrouillé (lockVehicleForUpdate), lit un état garanti à jour vis-à-vis de
 * toute autre transaction concurrente visant le même véhicule (celle-ci reste bloquée sur le
 * verrou tant que la transaction courante n'a pas committé ou annulé). Sans ce verrou préalable
 * (ex. GET /api/vehicles/[id]/availability, lecture pure jamais suivie d'écriture), cette
 * fonction reste un simple instantané non garanti contre une écriture concurrente — jamais
 * utilisée seule comme fondement d'une décision d'écriture (voir createLocation/updateLocation).
 */
export async function checkAvailability(
  tenantId: string,
  vehicleId: string,
  start: Date,
  end: Date,
  excludeLocationId?: string,
  tx: Prisma.TransactionClient = prisma
): Promise<AvailabilityResult | null> {
  const vehicle = await tx.vehicle.findFirst({ where: { id: vehicleId, tenantId } });
  if (!vehicle) {
    return null;
  }

  const conflictingLocations = await findConflictingLocations(vehicleId, start, end, excludeLocationId, tx);

  return { available: conflictingLocations.length === 0, conflictingLocations };
}

/**
 * Sprint 26C, Finding C : verrou de ligne explicite (`SELECT ... FOR UPDATE`) sur le Vehicle
 * ciblé, posé avant toute vérification de disponibilité — nécessaire car il n'existe, avant
 * l'écriture, aucune ligne Location à verrouiller (le conflit ne prend forme qu'au moment de la
 * création/modification elle-même) : c'est donc le Vehicle qui sert de point de sérialisation
 * commun entre deux créations/modifications concurrentes visant le même véhicule. Une deuxième
 * transaction concurrente sur le même véhicule attend ici le commit (ou le rollback) de la
 * première avant de pouvoir lire un état de disponibilité à jour — jamais l'inverse. Requête
 * paramétrée via template tag Prisma (aucune concaténation de valeur utilisateur), tenant
 * explicitement scopé dans la clause WHERE ; ne doit être appelée que depuis une véritable
 * transaction (`Prisma.TransactionClient` issue de `prisma.$transaction`), jamais sur le client
 * global — même principe que `lockInvoiceForUpdate`, src/lib/payments.ts (Finding B).
 */
export async function lockVehicleForUpdate(
  tenantId: string,
  vehicleId: string,
  tx: Prisma.TransactionClient
): Promise<Vehicle | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Vehicle" WHERE id = ${vehicleId} AND "tenantId" = ${tenantId} FOR UPDATE
  `;
  if (locked.length === 0) {
    return null;
  }
  return tx.vehicle.findFirst({ where: { id: vehicleId, tenantId } });
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
 *
 * Sprint 24 : à défaut de tout mouvement connu (véhicule jamais loué/transféré/déplacé, cas le
 * plus fréquent juste après sa création), retombe sur Vehicle.currentOdometer/currentFuelLevel
 * (saisis à la création, voir CreateVehicleInput) plutôt que sur `null` systématique — un
 * véhicule neuf n'a plus besoin d'un premier mouvement pour avoir un état de départ connu.
 */
export async function getVehicleLastKnownState(
  tenantId: string,
  vehicleId: string
): Promise<VehicleLastKnownState> {
  const [vehicle, lastLocation, lastTransfer, lastTrip] = await Promise.all([
    prisma.vehicle.findFirst({
      where: { id: vehicleId, tenantId },
      select: { currentOdometer: true, currentFuelLevel: true },
    }),
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
    return { odometer: vehicle?.currentOdometer ?? null, fuelLevel: vehicle?.currentFuelLevel ?? null };
  }

  const latest = candidates.reduce((a, b) => (b.at > a.at ? b : a));
  return { odometer: latest.odometer, fuelLevel: latest.fuelLevel };
}
