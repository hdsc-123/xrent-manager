import type { VehicleTrip, VehicleTripStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getVehicleById, lockVehicleForUpdate, findConflictingMaintenances } from "@/lib/vehicles";
import { assertVehicleNotDeactivated, syncVehicleStatus } from "@/lib/vehicle-status";

export class VehicleTripVehicleNotFoundError extends Error {
  constructor() {
    super("Véhicule introuvable.");
    this.name = "VehicleTripVehicleNotFoundError";
  }
}

/** Sprint 31B : `message` désormais surchargeable par une sous-classe (voir
 * VehicleReservationConflictError ci-dessous) — même principe que
 * VehicleNotAvailableForTransferError, src/lib/vehicle-transfers.ts. */
export class VehicleNotAvailableForTripError extends Error {
  constructor(message = "Ce véhicule n'est pas disponible pour un déplacement (statut actuel non AVAILABLE).") {
    super(message);
    this.name = "VehicleNotAvailableForTripError";
  }
}

/**
 * Sprint 31B (DOMAINRULES.md section 46) : conflit de concurrence sur la CRÉATION d'un
 * déplacement — distinct du refus métier ci-dessus. Même principe que
 * VehicleReservationConflictError de src/lib/vehicle-transfers.ts (dupliquée localement, même
 * convention que InvalidFuelLevelError dans ce fichier, pour éviter une dépendance croisée entre
 * modules indépendants) : sous-classe de VehicleNotAvailableForTripError, donc toujours capturée
 * par le même `instanceof` côté route (POST /api/vehicle-trips, mappé sur 409), aucune
 * modification de route nécessaire.
 */
export class VehicleReservationConflictError extends VehicleNotAvailableForTripError {
  constructor() {
    super(
      "Cette opération n'a pas été appliquée. Le véhicule a déjà été réservé par un autre utilisateur. Actualisez la page puis réessayez."
    );
    this.name = "VehicleReservationConflictError";
  }
}

/**
 * Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 7) : même raisonnement que
 * VehicleMaintenanceConflictForTransferError (src/lib/vehicle-transfers.ts) — Vehicle.status
 * (manuel) et la période d'une Maintenance sont deux informations indépendantes, un véhicule
 * AVAILABLE peut malgré tout avoir une maintenance SCHEDULED/IN_PROGRESS en cours au moment
 * précis du départ. Sous-classe de VehicleNotAvailableForTripError, capturée par le même
 * `instanceof` déjà en place côté route.
 */
export class VehicleMaintenanceConflictForTripError extends VehicleNotAvailableForTripError {
  constructor() {
    super("Ce véhicule a une maintenance planifiée/en cours à cette date — déplacement impossible.");
    this.name = "VehicleMaintenanceConflictForTripError";
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
 * Maintenance.agencyId).
 *
 * Sprint 31B (DOMAINRULES.md section 46) : le véhicule est désormais verrouillé
 * (`lockVehicleForUpdate`, `SELECT ... FOR UPDATE`, src/lib/vehicles.ts) en tout début de
 * transaction, avant toute vérification de statut — même correctif et même raison que
 * createVehicleTransfer (src/lib/vehicle-transfers.ts) : une simple lecture non verrouillante
 * sous READ COMMITTED laissait deux transactions concurrentes lire toutes deux le véhicule
 * AVAILABLE avant que l'une n'écrive, permettant un VehicleTrip + un VehicleTransfer (ou deux
 * VehicleTrip) actifs simultanément sur le même véhicule.
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
    const lockedVehicle = await lockVehicleForUpdate(data.tenantId, vehicle.id, tx);
    if (!lockedVehicle) {
      throw new VehicleTripVehicleNotFoundError();
    }
    assertVehicleNotDeactivated(lockedVehicle);
    if (lockedVehicle.status !== "AVAILABLE") {
      // Même distinction conflit/refus métier que createVehicleTransfer ci-dessus : le véhicule
      // était AVAILABLE avant l'ouverture de la transaction mais ne l'est plus une fois le
      // verrou acquis → un autre appel concurrent a gagné la course entre-temps.
      if (vehicle.status === "AVAILABLE") {
        throw new VehicleReservationConflictError();
      }
      throw new VehicleNotAvailableForTripError();
    }

    const departureDate = data.departureDate ?? new Date();
    // Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 7) : voir
    // VehicleMaintenanceConflictForTripError ci-dessus.
    const maintenanceConflicts = await findConflictingMaintenances(
      lockedVehicle.id,
      departureDate,
      new Date(departureDate.getTime() + 1),
      undefined,
      tx
    );
    if (maintenanceConflicts.length > 0) {
      throw new VehicleMaintenanceConflictForTripError();
    }

    const trip = await tx.vehicleTrip.create({
      data: {
        tenantId: data.tenantId,
        vehicleId: lockedVehicle.id,
        agencyId: lockedVehicle.agencyId,
        employeeUserId: data.employeeUserId,
        reason: data.reason,
        destination: data.destination,
        departureDate,
        startOdometer: data.startOdometer,
        startFuelLevel: data.startFuelLevel,
        remarks: data.remarks,
      },
    });

    await syncVehicleStatus(lockedVehicle.id, tx);

    return trip;
  });
}

export interface ReturnVehicleTripInput {
  returnDate?: Date;
  endOdometer: number;
  /** Sprint 19 (DOMAINRULES.md section 37) : désormais obligatoire au retour (auparavant
   * optionnel) — même logique que le transfert entre agences, voir MissingFuelLevelError. */
  endFuelLevel: number;
  remarks?: string;
}

/** Sprint 19 — carburant retour obligatoire (voir ReturnVehicleTripInput.endFuelLevel). */
export class MissingFuelLevelError extends Error {
  constructor() {
    super("Le niveau de carburant de retour est requis.");
    this.name = "MissingFuelLevelError";
  }
}

/**
 * Retour du déplacement : bloque si endOdometer <= startOdometer (contrainte explicite du
 * sprint), repasse le véhicule AVAILABLE.
 *
 * Sprint 23 (DOMAINRULES.md section 39, étend le correctif Sprint 22 — DOMAINRULES.md section
 * 38 point 3(c) — aux « flux similaires concernés », documentés comme non corrigés depuis le
 * Sprint 17, DOMAINRULES.md section 35) : la transition de statut passe désormais par un
 * `updateMany` conditionné sur `status: "IN_PROGRESS"`, atomique côté base — même correctif
 * que validateVehicleTransfer/cancelVehicleTransfer (src/lib/vehicle-transfers.ts). Un second
 * appel concurrent (ex. `returnVehicleTrip` et `cancelVehicleTrip` sur le même déplacement)
 * obtient `count === 0` et échoue proprement plutôt que d'écraser silencieusement un état déjà
 * terminal.
 */
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
  if (data.endFuelLevel === undefined || data.endFuelLevel === null) {
    throw new MissingFuelLevelError();
  }
  validateFuelLevel(data.endFuelLevel);

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.vehicleTrip.updateMany({
      where: { id: existing.id, status: "IN_PROGRESS" },
      data: {
        status: "COMPLETED",
        returnDate: data.returnDate ?? new Date(),
        endOdometer: data.endOdometer,
        endFuelLevel: data.endFuelLevel,
        remarks: data.remarks !== undefined ? data.remarks : existing.remarks,
      },
    });
    if (count === 0) {
      throw new VehicleTripNotEditableError();
    }

    const trip = await tx.vehicleTrip.findUniqueOrThrow({ where: { id: existing.id } });

    await syncVehicleStatus(existing.vehicleId, tx);

    return trip;
  });
}

/** Sprint 23 : même correctif de race condition que returnVehicleTrip ci-dessus — updateMany
 * conditionné sur status: "IN_PROGRESS", atomique. */
export async function cancelVehicleTrip(tenantId: string, tripId: string): Promise<VehicleTrip | null> {
  const existing = await getVehicleTripById(tenantId, tripId);
  if (!existing) {
    return null;
  }

  if (!canTransition(existing.status, "CANCELLED")) {
    throw new VehicleTripNotEditableError();
  }

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.vehicleTrip.updateMany({
      where: { id: existing.id, status: "IN_PROGRESS" },
      data: { status: "CANCELLED" },
    });
    if (count === 0) {
      throw new VehicleTripNotEditableError();
    }

    const trip = await tx.vehicleTrip.findUniqueOrThrow({ where: { id: existing.id } });
    await syncVehicleStatus(existing.vehicleId, tx);
    return trip;
  });
}
