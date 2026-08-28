import type { Maintenance, MaintenanceStatus, MaintenanceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lockVehicleForUpdate, findConflictingLocations, getMaintenanceEffectiveEnd } from "@/lib/vehicles";
import { assertVehicleNotDeactivated, syncVehicleStatus } from "@/lib/vehicle-status";

export class MaintenanceVehicleNotFoundError extends Error {
  constructor() {
    super("Véhicule introuvable.");
    this.name = "MaintenanceVehicleNotFoundError";
  }
}

export class InvalidMaintenanceCostError extends Error {
  constructor() {
    super("cost doit être un entier positif ou nul (plus petite unité monétaire).");
    this.name = "InvalidMaintenanceCostError";
  }
}

export class InvalidMaintenancePeriodError extends Error {
  constructor() {
    super("scheduledEndDate doit être strictement postérieure à scheduledDate.");
    this.name = "InvalidMaintenancePeriodError";
  }
}

/**
 * Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 1) : un véhicule actuellement loué (ou
 * réservé sur une période chevauchant la maintenance proposée — PENDING/CONFIRMED/ACTIVE
 * bloquent, même statuts que la disponibilité Location déjà établie, src/lib/vehicles.ts) ne
 * peut recevoir une maintenance que si celle-ci commence après la date de retour prévue.
 * Contrôle strict, sans exception ADMIN — même philosophie que VehicleUnavailableForLocationError
 * (Sprint 28, Finding E) : un conflit physique réel (un véhicule ne peut pas être à la fois chez
 * un client et à l'atelier) n'est jamais un choix éditorial.
 */
export class VehicleUnavailableForMaintenanceError extends Error {
  conflictingLocations: Pick<Awaited<ReturnType<typeof findConflictingLocations>>[number], "id" | "startDate" | "endDate" | "status">[];

  constructor(
    conflictingLocations: Pick<Awaited<ReturnType<typeof findConflictingLocations>>[number], "id" | "startDate" | "endDate" | "status">[]
  ) {
    super(
      "Ce véhicule est loué (ou réservé) sur une période qui chevauche la maintenance demandée — " +
        "elle ne peut commencer qu'après la date de retour prévue."
    );
    this.name = "VehicleUnavailableForMaintenanceError";
    this.conflictingLocations = conflictingLocations;
  }
}

export class InvalidMaintenanceStatusTransitionError extends Error {
  constructor(from: MaintenanceStatus, to: MaintenanceStatus) {
    super(`Transition de statut invalide : ${from} → ${to}.`);
    this.name = "InvalidMaintenanceStatusTransitionError";
  }
}

export class MaintenanceNotEditableError extends Error {
  constructor() {
    super("Une maintenance COMPLETED ou CANCELLED ne peut plus être modifiée (historique conservé).");
    this.name = "MaintenanceNotEditableError";
  }
}

export class MaintenanceNotDeletableError extends Error {
  constructor() {
    super("Seule une maintenance SCHEDULED peut être supprimée ; sinon, annulez-la (status).");
    this.name = "MaintenanceNotDeletableError";
  }
}

/**
 * Machine à états explicite (même principe que Location/Invoice, ARCHITECTURE.md
 * section 12). COMPLETED et CANCELLED sont terminaux — l'historique d'entretien est
 * conservé indéfiniment (contrainte explicite du sprint), jamais réouvert. IN_PROGRESS
 * est une étape intermédiaire optionnelle : SCHEDULED → COMPLETED directement est
 * autorisé (petite agence qui traite l'entretien le jour même, sans étape "en cours"
 * distincte) — seules "Terminer"/"Annuler" sont exposées dans l'UI (voir
 * MaintenancesTable.tsx), IN_PROGRESS reste accessible via l'API pour un futur workflow
 * plus fin (À DÉCIDER).
 */
const ALLOWED_TRANSITIONS: Record<MaintenanceStatus, MaintenanceStatus[]> = {
  SCHEDULED: ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: MaintenanceStatus, to: MaintenanceStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

function validateCost(cost: number | null | undefined): void {
  if (cost !== null && cost !== undefined && (!Number.isInteger(cost) || cost < 0)) {
    throw new InvalidMaintenanceCostError();
  }
}

export interface MaintenanceFilters {
  agencyId?: string;
  vehicleId?: string;
  status?: MaintenanceStatus;
  type?: MaintenanceType;
  from?: Date;
  to?: Date;
}

export async function getMaintenances(
  tenantId: string,
  filters: MaintenanceFilters = {}
): Promise<Maintenance[]> {
  return prisma.maintenance.findMany({
    where: {
      tenantId,
      ...(filters.agencyId ? { agencyId: filters.agencyId } : {}),
      ...(filters.vehicleId ? { vehicleId: filters.vehicleId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.from ? { scheduledDate: { gte: filters.from } } : {}),
      ...(filters.to ? { scheduledDate: { lte: filters.to } } : {}),
    },
    orderBy: { scheduledDate: "desc" },
  });
}

export async function getMaintenanceById(tenantId: string, maintenanceId: string): Promise<Maintenance | null> {
  return prisma.maintenance.findFirst({ where: { id: maintenanceId, tenantId } });
}

export interface CreateMaintenanceInput {
  tenantId: string;
  vehicleId: string;
  type: MaintenanceType;
  scheduledDate: Date;
  /** Sprint 34 étape 3 — fin de la période bloquante (voir getMaintenanceEffectiveEnd,
   * src/lib/vehicles.ts, si absente). */
  scheduledEndDate?: Date;
  cost?: number;
  notes?: string;
}

function validatePeriod(scheduledDate: Date, scheduledEndDate: Date | null | undefined): void {
  if (scheduledEndDate && scheduledEndDate <= scheduledDate) {
    throw new InvalidMaintenancePeriodError();
  }
}

/**
 * agencyId/currency sont toujours dérivés du Vehicle côté serveur, jamais fournis par
 * le client (même principe que Location.agencyId dérivé de Vehicle.agencyId).
 *
 * Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 1) : transactionnelle, verrou du véhicule
 * posé avant toute vérification de conflit — même primitive (lockVehicleForUpdate,
 * src/lib/vehicles.ts) et même raisonnement de concurrence que createLocationLocked/
 * createVehicleTransfer/createVehicleTrip (Sprint 26C/31B) : deux créations de maintenance (ou
 * une maintenance et une location) quasi simultanées sur le même véhicule ne peuvent plus toutes
 * deux lire un état "disponible" avant que l'une des deux n'écrive.
 */
export async function createMaintenance(data: CreateMaintenanceInput): Promise<Maintenance> {
  validateCost(data.cost);
  validatePeriod(data.scheduledDate, data.scheduledEndDate);

  return prisma.$transaction(async (tx) => {
    const vehicle = await lockVehicleForUpdate(data.tenantId, data.vehicleId, tx);
    if (!vehicle) {
      throw new MaintenanceVehicleNotFoundError();
    }
    assertVehicleNotDeactivated(vehicle);

    const effectiveEnd = getMaintenanceEffectiveEnd({
      scheduledDate: data.scheduledDate,
      scheduledEndDate: data.scheduledEndDate ?? null,
    });
    const conflictingLocations = await findConflictingLocations(
      data.vehicleId,
      data.scheduledDate,
      effectiveEnd,
      undefined,
      tx
    );
    if (conflictingLocations.length > 0) {
      throw new VehicleUnavailableForMaintenanceError(conflictingLocations);
    }

    const maintenance = await tx.maintenance.create({
      data: {
        tenantId: data.tenantId,
        agencyId: vehicle.agencyId,
        vehicleId: vehicle.id,
        type: data.type,
        scheduledDate: data.scheduledDate,
        scheduledEndDate: data.scheduledEndDate,
        cost: data.cost,
        currency: vehicle.currency,
        notes: data.notes,
      },
    });
    // Sprint "statut opérationnel automatique" (2026-08-28) : une maintenance dont la période
    // bloquante couvre déjà l'instant présent (scheduledDate <= maintenant) doit immédiatement
    // faire passer le véhicule à MAINTENANCE — une maintenance planifiée pour une date future ne
    // déclenche rien avant cette date (voir getVehicleOperationalStatus).
    await syncVehicleStatus(vehicle.id, tx);
    return maintenance;
  });
}

export interface UpdateMaintenanceInput {
  status?: MaintenanceStatus;
  scheduledDate?: Date;
  /** Sprint 34 étape 3 — `null` retire explicitement la fin (retombe sur la fin de journée par
   * défaut, voir getMaintenanceEffectiveEnd) ; `undefined` = inchangée. */
  scheduledEndDate?: Date | null;
  completedDate?: Date;
  cost?: number;
  notes?: string;
}

export async function updateMaintenance(
  tenantId: string,
  maintenanceId: string,
  data: UpdateMaintenanceInput
): Promise<Maintenance | null> {
  const existing = await getMaintenanceById(tenantId, maintenanceId);
  if (!existing) {
    return null;
  }

  const wantsFieldChange =
    data.scheduledDate !== undefined ||
    data.scheduledEndDate !== undefined ||
    data.cost !== undefined ||
    data.notes !== undefined;
  if (wantsFieldChange && (existing.status === "COMPLETED" || existing.status === "CANCELLED")) {
    throw new MaintenanceNotEditableError();
  }

  if (data.status && data.status !== existing.status && !canTransition(existing.status, data.status)) {
    throw new InvalidMaintenanceStatusTransitionError(existing.status, data.status);
  }

  if (data.cost !== undefined) {
    validateCost(data.cost);
  }

  const nextScheduledDate = data.scheduledDate ?? existing.scheduledDate;
  const nextScheduledEndDate = data.scheduledEndDate !== undefined ? data.scheduledEndDate : existing.scheduledEndDate;
  const periodChanging = data.scheduledDate !== undefined || data.scheduledEndDate !== undefined;
  if (periodChanging) {
    validatePeriod(nextScheduledDate, nextScheduledEndDate);
  }

  // Passage à COMPLETED : completedDate par défaut à maintenant si non fournie.
  const completedDate =
    data.status === "COMPLETED" ? (data.completedDate ?? new Date()) : data.completedDate;

  const updateData = {
    ...(data.status ? { status: data.status } : {}),
    ...(data.scheduledDate ? { scheduledDate: data.scheduledDate } : {}),
    ...(data.scheduledEndDate !== undefined ? { scheduledEndDate: data.scheduledEndDate } : {}),
    ...(completedDate !== undefined ? { completedDate } : {}),
    ...(data.cost !== undefined ? { cost: data.cost } : {}),
    ...(data.notes !== undefined ? { notes: data.notes } : {}),
  };

  if (!periodChanging) {
    // Sprint "statut opérationnel automatique" (2026-08-28) : même sans changement de période,
    // un changement de `status` (ex. COMPLETED/CANCELLED, ou SCHEDULED → IN_PROGRESS) peut faire
    // varier le statut opérationnel du véhicule — transactionnel pour recalculer sous le même
    // verrou que l'écriture, jamais une réécriture aveugle à AVAILABLE (une autre opération
    // bloquante peut être active en parallèle).
    return prisma.$transaction(async (tx) => {
      const maintenance = await tx.maintenance.update({ where: { id: maintenanceId }, data: updateData });
      if (data.status && data.status !== existing.status) {
        await syncVehicleStatus(existing.vehicleId, tx);
      }
      return maintenance;
    });
  }

  // Sprint 34 étape 3 : re-vérification transactionnelle, même primitive de verrouillage que
  // createMaintenance ci-dessus — un déplacement de la période d'une maintenance déjà planifiée
  // ne doit pas plus pouvoir chevaucher une location active qu'à la création.
  return prisma.$transaction(async (tx) => {
    const vehicle = await lockVehicleForUpdate(tenantId, existing.vehicleId, tx);
    if (!vehicle) {
      throw new MaintenanceVehicleNotFoundError();
    }

    const effectiveEnd = getMaintenanceEffectiveEnd({
      scheduledDate: nextScheduledDate,
      scheduledEndDate: nextScheduledEndDate,
    });
    const conflictingLocations = await findConflictingLocations(
      existing.vehicleId,
      nextScheduledDate,
      effectiveEnd,
      undefined,
      tx
    );
    if (conflictingLocations.length > 0) {
      throw new VehicleUnavailableForMaintenanceError(conflictingLocations);
    }

    const maintenance = await tx.maintenance.update({ where: { id: maintenanceId }, data: updateData });
    // Sprint "statut opérationnel automatique" (2026-08-28) : un déplacement de période peut
    // faire entrer ou sortir la maintenance de la fenêtre "active maintenant".
    await syncVehicleStatus(vehicle.id, tx);
    return maintenance;
  });
}

export async function deleteMaintenance(tenantId: string, maintenanceId: string): Promise<boolean> {
  const existing = await getMaintenanceById(tenantId, maintenanceId);
  if (!existing) {
    return false;
  }

  if (existing.status !== "SCHEDULED") {
    throw new MaintenanceNotDeletableError();
  }

  await prisma.maintenance.delete({ where: { id: maintenanceId } });
  return true;
}

/**
 * Maintenances SCHEDULED dont la date prévue tombe avant `daysAhead` jours à partir de
 * maintenant (inclut les maintenances déjà en retard). Utilisé par
 * src/lib/scheduled-tasks.ts (checkDueMaintenances) et le widget dashboard.
 */
export async function getDueMaintenances(tenantId: string, daysAhead: number): Promise<Maintenance[]> {
  const threshold = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);

  return prisma.maintenance.findMany({
    where: {
      tenantId,
      status: "SCHEDULED",
      scheduledDate: { lte: threshold },
    },
    orderBy: { scheduledDate: "asc" },
  });
}

/**
 * Planifie une maintenance à partir d'un échéancier (ex. prochain entretien récurrent).
 * tenantId est requis en premier paramètre (déviation par rapport à l'énoncé initial du
 * sprint, qui omettait tenantId) : toute requête doit rester scopée tenant côté serveur,
 * conformément à CLAUDE.md section 5 — voir HANDOFF.md pour cette déviation documentée.
 * Aucun moteur de récurrence n'appelle encore cette fonction automatiquement (À DÉCIDER).
 */
export async function createMaintenanceFromSchedule(
  tenantId: string,
  vehicleId: string,
  type: MaintenanceType,
  scheduledDate: Date
): Promise<Maintenance> {
  return createMaintenance({ tenantId, vehicleId, type, scheduledDate });
}
