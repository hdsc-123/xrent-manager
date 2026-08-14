import type { VehicleTransfer, VehicleTransferStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getVehicleById } from "@/lib/vehicles";

export class VehicleTransferVehicleNotFoundError extends Error {
  constructor() {
    super("Véhicule introuvable.");
    this.name = "VehicleTransferVehicleNotFoundError";
  }
}

export class VehicleTransferAgencyNotFoundError extends Error {
  constructor() {
    super("Agence d'arrivée introuvable pour ce tenant.");
    this.name = "VehicleTransferAgencyNotFoundError";
  }
}

export class SameAgencyTransferError extends Error {
  constructor() {
    super("L'agence d'arrivée doit être différente de l'agence de départ.");
    this.name = "SameAgencyTransferError";
  }
}

/** Empêche de lancer un transfert incohérent : le véhicule doit être AVAILABLE (ni loué, ni
 * déjà en transfert/déplacement, ni en maintenance/inactif) au moment du lancement. */
export class VehicleNotAvailableForTransferError extends Error {
  constructor() {
    super("Ce véhicule n'est pas disponible pour un transfert (statut actuel non AVAILABLE).");
    this.name = "VehicleNotAvailableForTransferError";
  }
}

export class InvalidVehicleTransferStatusTransitionError extends Error {
  constructor(from: VehicleTransferStatus, to: VehicleTransferStatus) {
    super(`Transition de statut invalide : ${from} → ${to}.`);
    this.name = "InvalidVehicleTransferStatusTransitionError";
  }
}

export class VehicleTransferNotEditableError extends Error {
  constructor() {
    super("Ce transfert est déjà COMPLETED ou CANCELLED, il ne peut plus être modifié.");
    this.name = "VehicleTransferNotEditableError";
  }
}

export class InvalidVehicleTransferOdometerError extends Error {
  constructor() {
    super("Le kilométrage d'arrivée doit être supérieur ou égal au kilométrage de départ.");
    this.name = "InvalidVehicleTransferOdometerError";
  }
}

export class InvalidVehicleTransferDateRangeError extends Error {
  constructor() {
    super("La date d'arrivée doit être postérieure ou égale à la date de départ.");
    this.name = "InvalidVehicleTransferDateRangeError";
  }
}

export class InvalidFuelLevelError extends Error {
  constructor() {
    super("Le niveau de carburant doit être un entier entre 0 et 100 (pourcentage).");
    this.name = "InvalidFuelLevelError";
  }
}

/**
 * Machine à états explicite (même principe que Location/Maintenance/Alert). Un transfert est
 * "lancé" dès sa création (status IN_TRANSIT par défaut, voir createVehicleTransfer) — pas
 * d'étape brouillon distincte. COMPLETED/CANCELLED sont terminaux.
 */
const ALLOWED_TRANSITIONS: Record<VehicleTransferStatus, VehicleTransferStatus[]> = {
  IN_TRANSIT: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: VehicleTransferStatus, to: VehicleTransferStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

function validateFuelLevel(value: number | null | undefined): void {
  if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 0 || value > 100)) {
    throw new InvalidFuelLevelError();
  }
}

export interface VehicleTransferFilters {
  agencyId?: string;
  vehicleId?: string;
  status?: VehicleTransferStatus;
}

/** Un transfert est visible depuis une agence s'il concerne son agence de départ OU
 * d'arrivée — un MEMBER rattaché à l'une des deux doit pouvoir le suivre. */
export async function getVehicleTransfers(
  tenantId: string,
  filters: VehicleTransferFilters = {}
): Promise<VehicleTransfer[]> {
  return prisma.vehicleTransfer.findMany({
    where: {
      tenantId,
      ...(filters.agencyId
        ? { OR: [{ fromAgencyId: filters.agencyId }, { toAgencyId: filters.agencyId }] }
        : {}),
      ...(filters.vehicleId ? { vehicleId: filters.vehicleId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getVehicleTransferById(
  tenantId: string,
  transferId: string
): Promise<VehicleTransfer | null> {
  return prisma.vehicleTransfer.findFirst({ where: { id: transferId, tenantId } });
}

export interface CreateVehicleTransferInput {
  tenantId: string;
  vehicleId: string;
  toAgencyId: string;
  fromCity?: string;
  toCity?: string;
  departureDate?: Date;
  startOdometer?: number;
  startFuelLevel?: number;
  responsibleUserId: string;
  reason?: string;
  notes?: string;
}

/**
 * Lance un transfert (fromAgencyId toujours dérivé du véhicule côté serveur, jamais fourni par
 * le client — SECURITY.md section 4). Transaction : le véhicule doit être AVAILABLE au moment
 * exact de l'écriture (relu dans la transaction, pas seulement avant) pour éviter une course
 * entre deux transferts/déplacements concurrents sur le même véhicule.
 */
export async function createVehicleTransfer(data: CreateVehicleTransferInput): Promise<VehicleTransfer> {
  const vehicle = await getVehicleById(data.tenantId, data.vehicleId);
  if (!vehicle) {
    throw new VehicleTransferVehicleNotFoundError();
  }

  const toAgency = await prisma.agency.findFirst({ where: { id: data.toAgencyId, tenantId: data.tenantId } });
  if (!toAgency) {
    throw new VehicleTransferAgencyNotFoundError();
  }

  if (toAgency.id === vehicle.agencyId) {
    throw new SameAgencyTransferError();
  }

  validateFuelLevel(data.startFuelLevel);

  return prisma.$transaction(async (tx) => {
    const freshVehicle = await tx.vehicle.findUnique({ where: { id: vehicle.id } });
    if (!freshVehicle || freshVehicle.status !== "AVAILABLE") {
      throw new VehicleNotAvailableForTransferError();
    }

    const transfer = await tx.vehicleTransfer.create({
      data: {
        tenantId: data.tenantId,
        vehicleId: vehicle.id,
        fromAgencyId: vehicle.agencyId,
        toAgencyId: data.toAgencyId,
        fromCity: data.fromCity,
        toCity: data.toCity,
        departureDate: data.departureDate ?? new Date(),
        startOdometer: data.startOdometer,
        startFuelLevel: data.startFuelLevel,
        responsibleUserId: data.responsibleUserId,
        reason: data.reason,
        notes: data.notes,
      },
    });

    await tx.vehicle.update({ where: { id: vehicle.id }, data: { status: "TRANSFERRING" } });

    // Sprint 22 : alerte immédiate à l'agence d'arrivée — jusqu'ici rien ne signalait à un
    // véhicule entrant, l'agence de destination ne le découvrait qu'en consultant la liste des
    // transferts. Créée dans la même transaction que le transfert (jamais un transfert "muet").
    await tx.alert.create({
      data: {
        tenantId: data.tenantId,
        agencyId: toAgency.id,
        type: "VEHICLE_TRANSFER_INCOMING",
        priority: "MEDIUM",
        message: `Véhicule en transit vers votre agence : ${vehicle.name} (${vehicle.licensePlate}), en provenance de ${data.fromCity ?? "l'agence de départ"}.`,
        entityType: "VehicleTransferIncoming",
        entityId: transfer.id,
      },
    });

    return transfer;
  });
}

export interface ValidateVehicleTransferInput {
  arrivalDate?: Date;
  endOdometer?: number;
  endFuelLevel?: number;
  /** Sprint 22 — chauffeur effectif à l'arrivée, texte libre (voir le commentaire du champ
   * dans prisma/schema.prisma). */
  arrivalDriverName?: string;
  notes?: string;
}

/**
 * Valide la réception du véhicule à l'agence d'arrivée : rattache le véhicule à sa nouvelle
 * agence et le repasse AVAILABLE (DOMAINRULES.md section 30).
 *
 * Sprint 22 (correctif d'une race condition documentée depuis le Sprint 17, DOMAINRULES.md
 * section 35) : la transition de statut elle-même passe désormais par un `updateMany` conditionné
 * sur `status: "IN_TRANSIT"`, une seule instruction UPDATE atomique côté base — si un autre appel
 * concurrent (ex. `cancelVehicleTransfer` sur le même transfert) a déjà fait passer le statut
 * hors de IN_TRANSIT entre la lecture ci-dessous et l'écriture, `count` vaut 0 et l'opération est
 * refusée plutôt que d'écraser silencieusement un état déjà terminal. La lecture initiale
 * (`existing`) ne sert plus qu'à produire un message d'erreur utile et à valider les champs
 * fournis (kilométrage/dates) avant d'entrer en transaction.
 */
export async function validateVehicleTransfer(
  tenantId: string,
  transferId: string,
  data: ValidateVehicleTransferInput
): Promise<VehicleTransfer | null> {
  const existing = await getVehicleTransferById(tenantId, transferId);
  if (!existing) {
    return null;
  }

  if (!canTransition(existing.status, "COMPLETED")) {
    throw new VehicleTransferNotEditableError();
  }

  const arrivalDate = data.arrivalDate ?? new Date();
  if (arrivalDate < existing.departureDate) {
    throw new InvalidVehicleTransferDateRangeError();
  }

  const startOdometer = existing.startOdometer;
  if (
    startOdometer !== null &&
    data.endOdometer !== undefined &&
    data.endOdometer !== null &&
    data.endOdometer < startOdometer
  ) {
    throw new InvalidVehicleTransferOdometerError();
  }

  validateFuelLevel(data.endFuelLevel);

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.vehicleTransfer.updateMany({
      where: { id: existing.id, status: "IN_TRANSIT" },
      data: {
        status: "COMPLETED",
        arrivalDate,
        endOdometer: data.endOdometer,
        endFuelLevel: data.endFuelLevel,
        arrivalDriverName: data.arrivalDriverName,
        notes: data.notes !== undefined ? data.notes : existing.notes,
      },
    });
    if (count === 0) {
      throw new VehicleTransferNotEditableError();
    }

    const transfer = await tx.vehicleTransfer.findUniqueOrThrow({ where: { id: existing.id } });

    await tx.vehicle.update({
      where: { id: existing.vehicleId },
      data: { agencyId: existing.toAgencyId, status: "AVAILABLE" },
    });

    return transfer;
  });
}

/**
 * Sprint 22 : même correctif de race condition que validateVehicleTransfer ci-dessus —
 * updateMany conditionné sur status: "IN_TRANSIT", atomique.
 */
export async function cancelVehicleTransfer(
  tenantId: string,
  transferId: string
): Promise<VehicleTransfer | null> {
  const existing = await getVehicleTransferById(tenantId, transferId);
  if (!existing) {
    return null;
  }

  if (!canTransition(existing.status, "CANCELLED")) {
    throw new VehicleTransferNotEditableError();
  }

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.vehicleTransfer.updateMany({
      where: { id: existing.id, status: "IN_TRANSIT" },
      data: { status: "CANCELLED" },
    });
    if (count === 0) {
      throw new VehicleTransferNotEditableError();
    }

    const transfer = await tx.vehicleTransfer.findUniqueOrThrow({ where: { id: existing.id } });

    // Le véhicule reste à son agence de départ (jamais déplacé pour un transfert annulé) —
    // simplement repassé AVAILABLE.
    await tx.vehicle.update({ where: { id: existing.vehicleId }, data: { status: "AVAILABLE" } });

    return transfer;
  });
}
