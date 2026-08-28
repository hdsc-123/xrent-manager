import type { VehicleTransfer, VehicleTransferStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getVehicleById, lockVehicleForUpdate, findConflictingMaintenances } from "@/lib/vehicles";
import { assertVehicleNotDeactivated, syncVehicleStatus } from "@/lib/vehicle-status";

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
 * déjà en transfert/déplacement, ni en maintenance/inactif) au moment du lancement.
 *
 * Sprint 31B : `message` désormais surchargeable par une sous-classe (voir
 * VehicleReservationConflictError ci-dessous) — le refus métier générique reste le message par
 * défaut, inchangé, pour tout appelant qui construit l'erreur sans argument. */
export class VehicleNotAvailableForTransferError extends Error {
  constructor(message = "Ce véhicule n'est pas disponible pour un transfert (statut actuel non AVAILABLE).") {
    super(message);
    this.name = "VehicleNotAvailableForTransferError";
  }
}

/**
 * Sprint 31B (DOMAINRULES.md section 46) : conflit de concurrence sur la CRÉATION d'un
 * transfert — distinct du refus métier ci-dessus. Le véhicule était AVAILABLE à la lecture
 * initiale (avant l'ouverture de la transaction) mais ne l'est plus une fois le verrou de ligne
 * acquis (lockVehicleForUpdate) : un autre appel concurrent a gagné la course pour ce véhicule
 * entre les deux lectures. Sous-classe de VehicleNotAvailableForTransferError : reste capturée
 * par le même `instanceof` déjà en place côté route (POST /api/vehicle-transfers, mappé sur 409),
 * aucune modification de route nécessaire — seul le message diffère pour rester distinct d'un
 * refus métier (véhicule déjà RENTED/MAINTENANCE/INACTIVE/TRANSFERRING/ON_TRIP avant même cette
 * requête, message générique ci-dessus conservé dans ce cas).
 */
export class VehicleReservationConflictError extends VehicleNotAvailableForTransferError {
  constructor() {
    super(
      "Cette opération n'a pas été appliquée. Le véhicule a déjà été réservé par un autre utilisateur. Actualisez la page puis réessayez."
    );
    this.name = "VehicleReservationConflictError";
  }
}

export class InvalidVehicleTransferStatusTransitionError extends Error {
  constructor(from: VehicleTransferStatus, to: VehicleTransferStatus) {
    super(`Transition de statut invalide : ${from} → ${to}.`);
    this.name = "InvalidVehicleTransferStatusTransitionError";
  }
}

/**
 * Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 7) : un véhicule reste AVAILABLE en
 * pratique (`Vehicle.status`, champ manuel — DOMAINRULES.md section 5) même s'il a une
 * maintenance SCHEDULED/IN_PROGRESS en cours au moment précis du lancement — le statut du
 * véhicule et la période de maintenance sont deux informations indépendantes. Sous-classe de
 * VehicleNotAvailableForTransferError (même raisonnement que VehicleReservationConflictError
 * ci-dessus) pour rester capturée par le `instanceof` déjà en place côté route, message distinct.
 */
export class VehicleMaintenanceConflictForTransferError extends VehicleNotAvailableForTransferError {
  constructor() {
    super("Ce véhicule a une maintenance planifiée/en cours à cette date — transfert impossible.");
    this.name = "VehicleMaintenanceConflictForTransferError";
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
 * le client — SECURITY.md section 4).
 *
 * Sprint 31B (DOMAINRULES.md section 46) : le véhicule est désormais verrouillé
 * (`lockVehicleForUpdate`, `SELECT ... FOR UPDATE`, src/lib/vehicles.ts — même mécanisme que
 * `createLocationLocked`, Sprint 26C, Finding C) en tout début de transaction, avant toute
 * vérification de statut. Avant ce correctif, la lecture du véhicule dans la transaction
 * (`tx.vehicle.findUnique`) n'était qu'une simple lecture non verrouillante : sous l'isolation
 * READ COMMITTED de PostgreSQL (aucun `isolationLevel` custom dans ce projet), deux transactions
 * concurrentes pouvaient toutes deux lire le véhicule AVAILABLE avant que l'une des deux
 * n'écrive, produisant deux VehicleTransfer (ou un VehicleTransfer + un VehicleTrip, voir
 * src/lib/vehicle-trips.ts) actifs simultanément sur le même véhicule. Le verrou de ligne force
 * désormais une deuxième transaction concurrente à attendre le commit (ou le rollback) de la
 * première avant de relire un statut garanti à jour.
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
    const lockedVehicle = await lockVehicleForUpdate(data.tenantId, vehicle.id, tx);
    if (!lockedVehicle) {
      throw new VehicleTransferVehicleNotFoundError();
    }
    assertVehicleNotDeactivated(lockedVehicle);
    if (lockedVehicle.status !== "AVAILABLE") {
      // Le véhicule était AVAILABLE à la lecture initiale (avant la transaction) mais ne l'est
      // plus une fois le verrou acquis : un autre appel concurrent a gagné la course entre-temps
      // — conflit de concurrence, distinct d'un refus métier préexistant (voir le commentaire de
      // VehicleReservationConflictError ci-dessus).
      if (vehicle.status === "AVAILABLE") {
        throw new VehicleReservationConflictError();
      }
      throw new VehicleNotAvailableForTransferError();
    }

    const departureDate = data.departureDate ?? new Date();
    // Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 7) : voir
    // VehicleMaintenanceConflictForTransferError ci-dessus — fenêtre d'un instant (1ms) autour du
    // départ, réutilise findConflictingMaintenances (src/lib/vehicles.ts) telle quelle plutôt
    // qu'une seconde fonction dédiée au "point dans le temps".
    const maintenanceConflicts = await findConflictingMaintenances(
      lockedVehicle.id,
      departureDate,
      new Date(departureDate.getTime() + 1),
      undefined,
      tx
    );
    if (maintenanceConflicts.length > 0) {
      throw new VehicleMaintenanceConflictForTransferError();
    }

    const transfer = await tx.vehicleTransfer.create({
      data: {
        tenantId: data.tenantId,
        vehicleId: lockedVehicle.id,
        fromAgencyId: lockedVehicle.agencyId,
        toAgencyId: data.toAgencyId,
        fromCity: data.fromCity,
        toCity: data.toCity,
        departureDate,
        startOdometer: data.startOdometer,
        startFuelLevel: data.startFuelLevel,
        responsibleUserId: data.responsibleUserId,
        reason: data.reason,
        notes: data.notes,
      },
    });

    await syncVehicleStatus(lockedVehicle.id, tx);

    // Sprint 22 : alerte immédiate à l'agence d'arrivée — jusqu'ici rien ne signalait à un
    // véhicule entrant, l'agence de destination ne le découvrait qu'en consultant la liste des
    // transferts. Créée dans la même transaction que le transfert (jamais un transfert "muet").
    await tx.alert.create({
      data: {
        tenantId: data.tenantId,
        agencyId: toAgency.id,
        type: "VEHICLE_TRANSFER_INCOMING",
        priority: "MEDIUM",
        message: `Véhicule en transit vers votre agence : ${lockedVehicle.name} (${lockedVehicle.licensePlate}), en provenance de ${data.fromCity ?? "l'agence de départ"}.`,
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

    await tx.vehicle.update({ where: { id: existing.vehicleId }, data: { agencyId: existing.toAgencyId } });
    // Sprint "statut opérationnel automatique" (2026-08-28) : recalcul plutôt qu'une réécriture
    // aveugle à AVAILABLE — le véhicule reçu peut déjà avoir une autre opération bloquante
    // active (rare mais possible, ex. une maintenance planifiée le jour même de la réception).
    await syncVehicleStatus(existing.vehicleId, tx);

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
    // statut recalculé plutôt qu'une réécriture aveugle à AVAILABLE.
    await syncVehicleStatus(existing.vehicleId, tx);

    return transfer;
  });
}
