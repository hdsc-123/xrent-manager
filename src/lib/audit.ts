import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Journal d'audit (Sprint 9), scopé tenant. Câblé uniquement sur les actions sensibles
 * introduites par ce sprint (rôle/suppression user, invitations) — pas de rétrofit sur le
 * reste du CRUD existant, voir HANDOFF.md. N'échoue jamais l'action métier appelante :
 * une erreur d'écriture d'audit est loggée en console, pas propagée.
 */
export interface LogActionInput {
  tenantId: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Sprint 13E tâche 3, sous-phase 2c2-C : `tx` optionnel — ajouté pour `refundCreditNote`
 * (`src/lib/invoices.ts`), la première action du projet exigeant explicitement que l'audit et
 * l'écriture métier (ici une `CashEntry`) soient créés dans une seule et même transaction,
 * atomiquement. Comportement strictement inchangé pour tout appelant existant (aucun ne
 * fournit `tx`) : écrit via le client global, erreur avalée et journalée en console, jamais
 * propagée à l'appelant. **Différence assumée quand `tx` est fourni** : l'erreur n'est plus
 * avalée — elle doit se propager pour faire échouer (rollback) toute la transaction appelante,
 * sans quoi l'atomicité demandée n'aurait aucun sens (un audit silencieusement manquant à côté
 * d'une CashEntry bien réelle serait pire que l'inverse pour cette action financière précise).
 */
export async function logAction(data: LogActionInput, tx?: Prisma.TransactionClient): Promise<void> {
  if (tx) {
    await tx.auditLog.create({
      data: {
        tenantId: data.tenantId,
        userId: data.userId,
        action: data.action,
        resource: data.resource,
        resourceId: data.resourceId,
        metadata: data.metadata,
      },
    });
    return;
  }
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: data.tenantId,
        userId: data.userId,
        action: data.action,
        resource: data.resource,
        resourceId: data.resourceId,
        metadata: data.metadata,
      },
    });
  } catch (error) {
    console.error("Erreur lors de l'écriture du journal d'audit :", error);
  }
}

export interface GetAuditLogsFilters {
  resource?: string;
  action?: string;
  userId?: string;
  from?: Date;
  to?: Date;
  take?: number;
  skip?: number;
}

export async function getAuditLogs(tenantId: string, filters: GetAuditLogsFilters = {}) {
  return prisma.auditLog.findMany({
    where: {
      tenantId,
      ...(filters.resource ? { resource: filters.resource } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.userId ? { userId: filters.userId } : {}),
      ...(filters.from || filters.to
        ? { createdAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: filters.take ?? 50,
    skip: filters.skip ?? 0,
  });
}

export async function getAuditLogCount(tenantId: string): Promise<number> {
  return prisma.auditLog.count({ where: { tenantId } });
}

/**
 * Sprint 24-1 : suppression du journal d'audit, brief explicite du propriétaire du projet —
 * strictement réservée ADMIN + permission dédiée audit.delete (src/lib/permissions.ts), vérifiée
 * côté route (src/app/api/audit/[id]/route.ts, .../bulk-delete, .../purge), jamais ici. Ne
 * supprime jamais que des lignes AuditLog : aucune de ces fonctions ne touche à une autre table.
 */
export class AuditLogNotFoundError extends Error {
  constructor() {
    super("Entrée du journal d'audit introuvable.");
    this.name = "AuditLogNotFoundError";
  }
}

/**
 * Suppression d'une entrée unique — tenant-scopée par un `findFirst` préalable (jamais un id
 * transmis tel quel à Prisma, même garde IDOR que le reste du CRUD, SECURITY.md section 7).
 * Auto-journalisée après coup ("audit.log_deleted", décrivant l'entrée disparue sans en
 * dupliquer tout le contenu) — cette nouvelle entrée est créée après la suppression, donc jamais
 * elle-même supprimée par cet appel.
 */
export async function deleteAuditLogEntry(tenantId: string, id: string, actorUserId: string): Promise<void> {
  const existing = await prisma.auditLog.findFirst({ where: { id, tenantId } });
  if (!existing) {
    throw new AuditLogNotFoundError();
  }

  await prisma.auditLog.delete({ where: { id } });

  await logAction({
    tenantId,
    userId: actorUserId,
    action: "audit.log_deleted",
    resource: "AuditLog",
    resourceId: id,
    metadata: {
      deletedAction: existing.action,
      deletedResource: existing.resource,
      deletedResourceId: existing.resourceId,
      deletedCreatedAt: existing.createdAt.toISOString(),
    } as unknown as Prisma.InputJsonValue,
  });
}

/**
 * Suppression en masse — mêmes garanties qu'unitaire ci-dessus, filtrée strictement par
 * tenantId : un id d'un autre tenant glissé dans la liste est silencieusement ignoré (ni
 * supprimé, ni cause d'échec pour les autres). Retourne le nombre réellement supprimé.
 */
export async function deleteAuditLogEntries(tenantId: string, ids: string[], actorUserId: string): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }

  const result = await prisma.auditLog.deleteMany({ where: { id: { in: ids }, tenantId } });

  if (result.count > 0) {
    await logAction({
      tenantId,
      userId: actorUserId,
      action: "audit.bulk_deleted",
      resource: "AuditLog",
      metadata: { count: result.count, requestedIds: ids.length } as unknown as Prisma.InputJsonValue,
    });
  }

  return result.count;
}

/**
 * Purge complète du journal d'audit du tenant courant — irréversible, jamais inter-tenant
 * (`where: { tenantId }` uniquement, jamais un tenantId arbitraire). Même convention que
 * `resetTenantData` (src/lib/data-reset.ts) : la purge et l'entrée d'audit qui la documente sont
 * écrites dans une seule transaction Prisma (`tx.auditLog.create`, pas `logAction` — qui passe
 * par le client Prisma global, hors de cette transaction) pour ne jamais purger sans laisser de
 * trace, y compris en cas d'échec partiel. Cette entrée est créée après la purge : elle n'est
 * donc jamais elle-même supprimée par cet appel.
 */
export async function purgeAuditLog(tenantId: string, actorUserId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.auditLog.deleteMany({ where: { tenantId } });

    await tx.auditLog.create({
      data: {
        tenantId,
        userId: actorUserId,
        action: "audit.purged",
        resource: "AuditLog",
        metadata: { count: result.count } as unknown as Prisma.InputJsonValue,
      },
    });

    return result.count;
  });
}
