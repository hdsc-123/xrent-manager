import type { Alert } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createAlert } from "@/lib/alerts";
import { formatMoney } from "@/lib/format";

/**
 * Nombre de jours par défaut pour anticiper une maintenance à venir (checkDueMaintenances).
 * Pas encore configurable par tenant — voir HANDOFF.md section 8 (À DÉCIDER).
 */
const DEFAULT_MAINTENANCE_LOOKAHEAD_DAYS = 7;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function endOfDay(date: Date): Date {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end;
}

/**
 * Évite de recréer une alerte à chaque exécution pour la même ressource : une alerte
 * non résolue (PENDING/ACKNOWLEDGED) déjà ouverte pour ce couple entityType/entityId
 * suffit, tant qu'elle n'a pas été résolue.
 */
async function hasUnresolvedAlert(tenantId: string, entityType: string, entityId: string): Promise<boolean> {
  const existing = await prisma.alert.findFirst({
    where: { tenantId, entityType, entityId, status: { in: ["PENDING", "ACKNOWLEDGED"] } },
  });
  return existing !== null;
}

/**
 * Crée une alerte MAINTENANCE_DUE pour chaque maintenance SCHEDULED dont la date prévue
 * tombe dans les `daysAhead` prochains jours (ou est déjà dépassée), scopé à un tenant —
 * aucun rôle "superadmin" transverse n'existe (HANDOFF.md section 8 point 16), donc ce
 * scan reste par tenant plutôt qu'un cron global multi-tenant.
 */
export async function checkDueMaintenances(
  tenantId: string,
  daysAhead: number = DEFAULT_MAINTENANCE_LOOKAHEAD_DAYS
): Promise<Alert[]> {
  const now = new Date();
  const threshold = new Date(now.getTime() + daysAhead * ONE_DAY_MS);

  const dueMaintenances = await prisma.maintenance.findMany({
    where: { tenantId, status: "SCHEDULED", scheduledDate: { lte: threshold } },
    include: { vehicle: { select: { name: true, licensePlate: true } } },
    orderBy: { scheduledDate: "asc" },
  });

  const created: Alert[] = [];
  for (const maintenance of dueMaintenances) {
    if (await hasUnresolvedAlert(tenantId, "Maintenance", maintenance.id)) {
      continue;
    }

    const overdue = maintenance.scheduledDate.getTime() <= now.getTime();
    const priority = overdue
      ? "URGENT"
      : maintenance.scheduledDate.getTime() - now.getTime() <= 2 * ONE_DAY_MS
        ? "HIGH"
        : "MEDIUM";

    const alert = await createAlert({
      tenantId,
      agencyId: maintenance.agencyId,
      type: "MAINTENANCE_DUE",
      priority,
      message: `Maintenance ${overdue ? "en retard" : "à venir"} pour ${maintenance.vehicle.name} (${maintenance.vehicle.licensePlate}) — prévue le ${maintenance.scheduledDate.toLocaleDateString("fr-FR")}.`,
      entityType: "Maintenance",
      entityId: maintenance.id,
    });
    created.push(alert);
  }

  return created;
}

/** Crée une alerte RETURN_TODAY pour chaque location ACTIVE dont la fin est aujourd'hui. */
export async function checkReturnsToday(tenantId: string): Promise<Alert[]> {
  const now = new Date();

  const locationsToday = await prisma.location.findMany({
    where: { tenantId, status: "ACTIVE", endDate: { gte: startOfDay(now), lte: endOfDay(now) } },
    include: {
      vehicle: { select: { name: true, licensePlate: true } },
      client: { select: { name: true } },
    },
  });

  const created: Alert[] = [];
  for (const location of locationsToday) {
    if (await hasUnresolvedAlert(tenantId, "Location", location.id)) {
      continue;
    }

    const alert = await createAlert({
      tenantId,
      agencyId: location.agencyId,
      type: "RETURN_TODAY",
      priority: "MEDIUM",
      message: `Retour prévu aujourd'hui : ${location.vehicle.name} (${location.vehicle.licensePlate}) — client ${location.client.name}.`,
      entityType: "Location",
      entityId: location.id,
    });
    created.push(alert);
  }

  return created;
}

/** Crée une alerte INVOICE_OVERDUE pour chaque facture SENT/PARTIALLY_PAID dont l'échéance est dépassée. */
export async function checkOverdueInvoices(tenantId: string): Promise<Alert[]> {
  const overdueInvoices = await prisma.invoice.findMany({
    where: {
      tenantId,
      status: { in: ["SENT", "PARTIALLY_PAID"] },
      dueDate: { lt: new Date() },
    },
  });

  const created: Alert[] = [];
  for (const invoice of overdueInvoices) {
    if (await hasUnresolvedAlert(tenantId, "Invoice", invoice.id)) {
      continue;
    }

    const remaining = invoice.totalAmount - invoice.amountPaid;
    const alert = await createAlert({
      tenantId,
      agencyId: invoice.agencyId,
      type: "INVOICE_OVERDUE",
      priority: "HIGH",
      message: `Facture ${invoice.number} en retard de paiement — solde restant ${formatMoney(remaining, invoice.currency)}.`,
      entityType: "Invoice",
      entityId: invoice.id,
    });
    created.push(alert);
  }

  return created;
}
