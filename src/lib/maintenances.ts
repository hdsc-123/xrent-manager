import type { Maintenance, MaintenanceStatus, MaintenanceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getVehicleById } from "@/lib/vehicles";

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
  cost?: number;
  notes?: string;
}

/**
 * agencyId/currency sont toujours dérivés du Vehicle côté serveur, jamais fournis par
 * le client (même principe que Location.agencyId dérivé de Vehicle.agencyId).
 */
export async function createMaintenance(data: CreateMaintenanceInput): Promise<Maintenance> {
  validateCost(data.cost);

  const vehicle = await getVehicleById(data.tenantId, data.vehicleId);
  if (!vehicle) {
    throw new MaintenanceVehicleNotFoundError();
  }

  return prisma.maintenance.create({
    data: {
      tenantId: data.tenantId,
      agencyId: vehicle.agencyId,
      vehicleId: vehicle.id,
      type: data.type,
      scheduledDate: data.scheduledDate,
      cost: data.cost,
      currency: vehicle.currency,
      notes: data.notes,
    },
  });
}

export interface UpdateMaintenanceInput {
  status?: MaintenanceStatus;
  scheduledDate?: Date;
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
    data.scheduledDate !== undefined || data.cost !== undefined || data.notes !== undefined;
  if (wantsFieldChange && (existing.status === "COMPLETED" || existing.status === "CANCELLED")) {
    throw new MaintenanceNotEditableError();
  }

  if (data.status && data.status !== existing.status && !canTransition(existing.status, data.status)) {
    throw new InvalidMaintenanceStatusTransitionError(existing.status, data.status);
  }

  if (data.cost !== undefined) {
    validateCost(data.cost);
  }

  // Passage à COMPLETED : completedDate par défaut à maintenant si non fournie.
  const completedDate =
    data.status === "COMPLETED" ? (data.completedDate ?? new Date()) : data.completedDate;

  return prisma.maintenance.update({
    where: { id: maintenanceId },
    data: {
      ...(data.status ? { status: data.status } : {}),
      ...(data.scheduledDate ? { scheduledDate: data.scheduledDate } : {}),
      ...(completedDate !== undefined ? { completedDate } : {}),
      ...(data.cost !== undefined ? { cost: data.cost } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    },
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
