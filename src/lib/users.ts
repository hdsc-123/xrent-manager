import type { User } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

/**
 * Gestion des utilisateurs d'un tenant (Sprint 9) : changement de rôle, suppression,
 * réinitialisation de mot de passe par un ADMIN. Voir HANDOFF.md points 2/19.
 */

export class LastAdminError extends Error {
  constructor() {
    super("Impossible de retirer le dernier administrateur du tenant.");
    this.name = "LastAdminError";
  }
}

export async function getUserById(tenantId: string, userId: string): Promise<User | null> {
  return prisma.user.findFirst({ where: { id: userId, tenantId } });
}

async function assertNotLastAdmin(tenantId: string, targetUserId: string): Promise<void> {
  const target = await prisma.user.findFirst({ where: { id: targetUserId, tenantId } });
  if (!target || target.role !== "ADMIN") {
    return;
  }

  const otherAdminCount = await prisma.user.count({
    where: { tenantId, role: "ADMIN", id: { not: targetUserId } },
  });

  if (otherAdminCount === 0) {
    throw new LastAdminError();
  }
}

export async function updateUserRole(
  tenantId: string,
  targetUserId: string,
  role: "ADMIN" | "MEMBER"
): Promise<User | null> {
  const existing = await getUserById(tenantId, targetUserId);
  if (!existing) {
    return null;
  }

  if (existing.role === "ADMIN" && role !== "ADMIN") {
    await assertNotLastAdmin(tenantId, targetUserId);
  }

  return prisma.user.update({ where: { id: targetUserId }, data: { role } });
}

export async function resetUserPassword(
  tenantId: string,
  targetUserId: string,
  password: string
): Promise<User | null> {
  const existing = await getUserById(tenantId, targetUserId);
  if (!existing) {
    return null;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  return prisma.user.update({ where: { id: targetUserId }, data: { passwordHash } });
}

/**
 * Nettoie les relations sans onDelete: Cascade avant de supprimer le user
 * (UserAgency, Alert.userId) — Account/Session ont déjà onDelete: Cascade.
 */
export async function deleteUser(tenantId: string, targetUserId: string): Promise<boolean> {
  const existing = await getUserById(tenantId, targetUserId);
  if (!existing) {
    return false;
  }

  await assertNotLastAdmin(tenantId, targetUserId);

  await prisma.$transaction([
    prisma.userAgency.deleteMany({ where: { userId: targetUserId } }),
    prisma.alert.updateMany({ where: { userId: targetUserId }, data: { userId: null } }),
    prisma.user.delete({ where: { id: targetUserId } }),
  ]);

  return true;
}
