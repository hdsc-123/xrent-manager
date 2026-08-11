import type { Agency, Tenant, User } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Tenant is the root of the isolation hierarchy, so lookup is by id only —
 * there is no parent tenantId to scope it against.
 */
export async function getTenantById(tenantId: string): Promise<Tenant | null> {
  return prisma.tenant.findUnique({ where: { id: tenantId } });
}

export async function getAgencyById(
  tenantId: string,
  agencyId: string
): Promise<Agency | null> {
  return prisma.agency.findFirst({ where: { id: agencyId, tenantId } });
}

export async function getUserById(
  tenantId: string,
  userId: string
): Promise<User | null> {
  return prisma.user.findFirst({ where: { id: userId, tenantId } });
}
