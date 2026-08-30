import type { User } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { BCRYPT_COST } from "@/lib/bcrypt-cost";

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

export class EmailAlreadyInUseError extends Error {
  constructor() {
    super("Cet email est déjà utilisé.");
    this.name = "EmailAlreadyInUseError";
  }
}

export class InvalidCurrentPasswordError extends Error {
  constructor() {
    super("Mot de passe actuel incorrect.");
    this.name = "InvalidCurrentPasswordError";
  }
}

export class InvalidAgencyError extends Error {
  constructor() {
    super("Une ou plusieurs agences sont introuvables pour ce tenant.");
    this.name = "InvalidAgencyError";
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

/** Agences actuellement assignées à un user (pour préremplir le formulaire d'édition). */
export async function getUserAgencyIds(userId: string): Promise<string[]> {
  const links = await prisma.userAgency.findMany({ where: { userId }, select: { agencyId: true } });
  return links.map((link) => link.agencyId);
}

/**
 * Remplace l'ensemble des agences assignées à un MEMBER (SECURITY.md section 2 :
 * un MEMBER ne voit/agit que sur les agences auxquelles il est explicitement rattaché
 * via UserAgency — jusqu'ici, rien dans l'application ne créait jamais ce lien, un MEMBER
 * fraîchement invité n'avait donc accès à aucune agence). Remplacement complet (pas
 * d'ajout incrémental) : plus simple à raisonner côté UI (case à cocher = état voulu),
 * même principe que setUserPermissions (src/lib/permissions.ts). Sans effet pour un
 * ADMIN (canAccessAgency/getAccessibleAgencyIds ignorent déjà UserAgency pour ce rôle),
 * mais autorisé quand même : rien n'empêche de préparer les agences avant une éventuelle
 * rétrogradation en MEMBER.
 */
export async function setUserAgencies(
  tenantId: string,
  targetUserId: string,
  agencyIds: string[]
): Promise<void> {
  const uniqueIds = Array.from(new Set(agencyIds));
  if (uniqueIds.length > 0) {
    const validAgencies = await prisma.agency.count({
      where: { tenantId, id: { in: uniqueIds } },
    });
    if (validAgencies !== uniqueIds.length) {
      throw new InvalidAgencyError();
    }
  }

  await prisma.$transaction([
    prisma.userAgency.deleteMany({ where: { userId: targetUserId } }),
    ...(uniqueIds.length > 0
      ? [
          prisma.userAgency.createMany({
            data: uniqueIds.map((agencyId) => ({ userId: targetUserId, agencyId })),
          }),
        ]
      : []),
  ]);
}

/**
 * Politique MFA (2026-08-30, brief explicite du propriétaire du projet) : un changement de mot
 * de passe doit révoquer les sessions actives concernées, y compris quand il est déclenché par
 * un ADMIN sur le compte d'un tiers — même garantie que updateUserProfile ci-dessous. La
 * notification de sécurité et l'entrée d'audit restent à la charge de l'appelant (route), même
 * convention que le reste de ce module.
 */
export async function resetUserPassword(
  tenantId: string,
  targetUserId: string,
  password: string
): Promise<User | null> {
  const existing = await getUserById(tenantId, targetUserId);
  if (!existing) {
    return null;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  return prisma.user.update({
    where: { id: targetUserId },
    data: { passwordHash, sessionRevokedAt: new Date() },
  });
}

export interface UpdateUserProfileInput {
  name?: string;
  email?: string;
  phone?: string | null;
  avatar?: string | null;
  currentPassword?: string;
  newPassword?: string;
}

export interface UpdateUserProfileResult {
  user: User;
  /** Reflète un changement réellement appliqué (valeur différente de l'existante), pas la
   * simple présence du champ dans la requête — voir la politique MFA (2026-08-30) sur la
   * notification de sécurité/révocation de session, qui ne doit se déclencher que sur un
   * changement réel. */
  emailChanged: boolean;
  passwordChanged: boolean;
}

/**
 * Édition du profil par l'user lui-même (Sprint 10) — distinct de resetUserPassword
 * (réinitialisation par un ADMIN sur un autre user, sans vérification de l'ancien mot
 * de passe). Ici, tout changement de mot de passe exige la vérification du mot de passe
 * actuel. Le tenantId reste requis en signature pour rester cohérent avec le reste de ce
 * module, même si un userId est déjà non-ambigu à lui seul.
 *
 * Politique MFA (2026-08-30, brief explicite du propriétaire du projet) : un changement
 * d'email ou de mot de passe révoque désormais toutes les sessions actives du compte,
 * y compris celle à l'origine du changement (même comportement voulu que la désactivation
 * MFA — force une reconnexion propre, voir src/lib/mfa-session.ts).
 */
export async function updateUserProfile(
  tenantId: string,
  userId: string,
  data: UpdateUserProfileInput
): Promise<UpdateUserProfileResult | null> {
  const existing = await getUserById(tenantId, userId);
  if (!existing) {
    return null;
  }

  const updateData: {
    name?: string;
    email?: string;
    phone?: string | null;
    avatar?: string | null;
    passwordHash?: string;
    sessionRevokedAt?: Date;
  } = {};

  if (data.name !== undefined) {
    updateData.name = data.name;
  }

  if (data.phone !== undefined) {
    updateData.phone = data.phone;
  }

  if (data.avatar !== undefined) {
    updateData.avatar = data.avatar;
  }

  if (data.email !== undefined && data.email !== existing.email) {
    const conflict = await prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: data.email } },
    });
    if (conflict) {
      throw new EmailAlreadyInUseError();
    }
    updateData.email = data.email;
  }

  if (data.newPassword !== undefined) {
    const currentIsValid =
      existing.passwordHash && data.currentPassword
        ? await bcrypt.compare(data.currentPassword, existing.passwordHash)
        : false;
    if (!currentIsValid) {
      throw new InvalidCurrentPasswordError();
    }
    updateData.passwordHash = await bcrypt.hash(data.newPassword, BCRYPT_COST);
  }

  const emailChanged = updateData.email !== undefined;
  const passwordChanged = updateData.passwordHash !== undefined;
  if (emailChanged || passwordChanged) {
    updateData.sessionRevokedAt = new Date();
  }

  const user = await prisma.user.update({ where: { id: userId }, data: updateData });
  return { user, emailChanged, passwordChanged };
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
