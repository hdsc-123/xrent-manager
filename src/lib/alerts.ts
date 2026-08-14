import type { Alert, AlertPriority, AlertStatus, AlertType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export class AlertNotFoundError extends Error {
  constructor() {
    super("Alerte introuvable.");
    this.name = "AlertNotFoundError";
  }
}

export class InvalidAlertStatusTransitionError extends Error {
  constructor(from: AlertStatus, to: AlertStatus) {
    super(`Transition de statut invalide : ${from} → ${to}.`);
    this.name = "InvalidAlertStatusTransitionError";
  }
}

/** Sprint 22 — resolutionCost, comme tout montant financier (DOMAINRULES.md section 14). */
export class InvalidAlertResolutionCostError extends Error {
  constructor() {
    super("resolutionCost doit être un entier positif ou nul (plus petite unité monétaire).");
    this.name = "InvalidAlertResolutionCostError";
  }
}

/**
 * Machine à états explicite (même principe que Location/Invoice/Maintenance).
 * RESOLVED est terminal : une alerte résolue ne peut pas être rouverte. Une alerte ne
 * peut jamais être supprimée (contrainte explicite du sprint) — aucune fonction
 * deleteAlert n'existe, seulement acknowledge/resolve.
 */
const ALLOWED_TRANSITIONS: Record<AlertStatus, AlertStatus[]> = {
  PENDING: ["ACKNOWLEDGED", "RESOLVED"],
  ACKNOWLEDGED: ["RESOLVED"],
  RESOLVED: [],
};

export function canTransition(from: AlertStatus, to: AlertStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface AlertFilters {
  agencyId?: string;
  userId?: string;
  type?: AlertType;
  priority?: AlertPriority;
  status?: AlertStatus;
}

/** Trié par priorité (URGENT en premier) puis date de création la plus récente. */
const PRIORITY_ORDER: Record<AlertPriority, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export async function getAlerts(tenantId: string, filters: AlertFilters = {}): Promise<Alert[]> {
  const alerts = await prisma.alert.findMany({
    where: {
      tenantId,
      ...(filters.agencyId ? { agencyId: filters.agencyId } : {}),
      ...(filters.userId ? { userId: filters.userId } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.priority ? { priority: filters.priority } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  return alerts.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}

export async function getAlertById(tenantId: string, alertId: string): Promise<Alert | null> {
  return prisma.alert.findFirst({ where: { id: alertId, tenantId } });
}

export interface CreateAlertInput {
  tenantId: string;
  type: AlertType;
  priority?: AlertPriority;
  agencyId?: string;
  userId?: string;
  message: string;
  entityType?: string;
  entityId?: string;
}

export async function createAlert(data: CreateAlertInput): Promise<Alert> {
  return prisma.alert.create({
    data: {
      tenantId: data.tenantId,
      type: data.type,
      priority: data.priority ?? "MEDIUM",
      agencyId: data.agencyId,
      userId: data.userId,
      message: data.message,
      entityType: data.entityType,
      entityId: data.entityId,
    },
  });
}

export async function acknowledgeAlert(tenantId: string, alertId: string, userId: string): Promise<Alert> {
  const existing = await getAlertById(tenantId, alertId);
  if (!existing) {
    throw new AlertNotFoundError();
  }

  // Idempotent si déjà ACKNOWLEDGED (double-clic) ; refusé depuis RESOLVED (terminal).
  if (existing.status === "ACKNOWLEDGED") {
    return existing;
  }
  if (!canTransition(existing.status, "ACKNOWLEDGED")) {
    throw new InvalidAlertStatusTransitionError(existing.status, "ACKNOWLEDGED");
  }

  return prisma.alert.update({
    where: { id: alertId },
    data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedByUserId: userId },
  });
}

export interface ResolveAlertInput {
  /** Sprint 22 — formulaire de suivi (voir le commentaire du modèle Alert,
   * prisma/schema.prisma) : tous optionnels, une alerte "simple" reste résolvable sans détail. */
  resolutionAction?: string;
  resolutionDate?: Date;
  resolutionIntervenant?: string;
  resolutionCost?: number;
  resolutionCurrency?: string;
  nextDueDate?: Date;
}

export async function resolveAlert(
  tenantId: string,
  alertId: string,
  userId: string,
  followUp: ResolveAlertInput = {}
): Promise<Alert> {
  const existing = await getAlertById(tenantId, alertId);
  if (!existing) {
    throw new AlertNotFoundError();
  }

  if (!canTransition(existing.status, "RESOLVED")) {
    throw new InvalidAlertStatusTransitionError(existing.status, "RESOLVED");
  }

  if (
    followUp.resolutionCost !== undefined &&
    (!Number.isInteger(followUp.resolutionCost) || followUp.resolutionCost < 0)
  ) {
    throw new InvalidAlertResolutionCostError();
  }

  return prisma.alert.update({
    where: { id: alertId },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
      resolvedByUserId: userId,
      resolutionAction: followUp.resolutionAction,
      resolutionDate: followUp.resolutionDate,
      resolutionIntervenant: followUp.resolutionIntervenant,
      resolutionCost: followUp.resolutionCost,
      resolutionCurrency: followUp.resolutionCurrency,
      nextDueDate: followUp.nextDueDate,
    },
  });
}

/**
 * Alertes non résolues (PENDING ou ACKNOWLEDGED) — utilisé pour le badge du header et
 * le widget dashboard. Si userId est fourni, inclut les alertes assignées à ce user
 * ainsi que les alertes diffusées à tout le tenant (userId null) ; le filtrage par
 * agence accessible reste à la charge de l'appelant (voir src/lib/authz.ts,
 * getAccessibleAgencyIds), comme pour vehicles/locations.
 */
export async function getPendingAlerts(tenantId: string, userId?: string): Promise<Alert[]> {
  const alerts = await prisma.alert.findMany({
    where: {
      tenantId,
      status: { in: ["PENDING", "ACKNOWLEDGED"] },
      ...(userId ? { OR: [{ userId }, { userId: null }] } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  return alerts.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}
