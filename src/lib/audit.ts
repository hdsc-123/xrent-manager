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

export async function logAction(data: LogActionInput): Promise<void> {
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
    },
    orderBy: { createdAt: "desc" },
    take: filters.take ?? 50,
    skip: filters.skip ?? 0,
  });
}
