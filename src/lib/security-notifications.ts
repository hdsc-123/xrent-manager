import type { Prisma, SecurityNotificationType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Politique MFA (2026-08-30, brief explicite du propriétaire du projet) : notifications de
 * sécurité in-app — voir le commentaire du modèle SecurityNotification (prisma/schema.prisma)
 * pour la distinction avec AuditLog. Messages toujours génériques (jamais de mot de passe, code
 * MFA, code de récupération, token ou secret) — la liste ci-dessous est la seule source de
 * contenu autorisée, jamais une chaîne construite dynamiquement à partir de données utilisateur.
 * Créées uniquement après une opération réussie, jamais après un simple échec (chaque appelant
 * est responsable de n'invoquer createSecurityNotification qu'une fois la mutation confirmée).
 */
export const SECURITY_NOTIFICATION_MESSAGES: Record<SecurityNotificationType, string> = {
  EMAIL_CHANGED: "L'adresse e-mail de votre compte a été modifiée. Si vous n'êtes pas à l'origine de ce changement, contactez un administrateur.",
  PASSWORD_CHANGED: "Le mot de passe de votre compte a été modifié. Si vous n'êtes pas à l'origine de ce changement, contactez un administrateur.",
  MFA_ENABLED: "L'authentification à deux facteurs (MFA) a été activée sur votre compte.",
  MFA_DISABLED: "L'authentification à deux facteurs (MFA) a été désactivée sur votre compte. Une reconnexion est nécessaire.",
  MFA_RECOVERY_CODES_REGENERATED: "De nouveaux codes de récupération MFA ont été générés pour votre compte ; les anciens ne fonctionnent plus.",
  MFA_RESET: "La MFA de votre compte a été réinitialisée par un administrateur. Une reconnexion est nécessaire.",
  ROLE_OR_PERMISSIONS_CHANGED: "Le rôle ou les permissions de votre compte ont été modifiés.",
};

export interface CreateSecurityNotificationInput {
  tenantId: string;
  userId: string;
  type: SecurityNotificationType;
  auditLogId?: string;
}

/** `tx` optionnel — à fournir chaque fois que la notification doit être créée dans la même
 * transaction que la mutation/l'audit qui la déclenche (même convention que logAction,
 * src/lib/audit.ts). Sans `tx`, écrit via le client global (routes non transactionnelles
 * existantes, ex. PATCH /api/users/[id]/permissions). */
export async function createSecurityNotification(
  input: CreateSecurityNotificationInput,
  tx?: Prisma.TransactionClient
): Promise<void> {
  const client = tx ?? prisma;
  await client.securityNotification.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      type: input.type,
      message: SECURITY_NOTIFICATION_MESSAGES[input.type],
      auditLogId: input.auditLogId,
    },
  });
}

const LIST_LIMIT = 50;

/** Toujours scopée à (tenantId, userId) de l'appelant — jamais un id fourni par le client au-delà
 * de ces deux valeurs, pour qu'un utilisateur ne puisse jamais lire les notifications d'un autre
 * (contrôle serveur, jamais l'interface seule). */
export async function listSecurityNotifications(tenantId: string, userId: string) {
  return prisma.securityNotification.findMany({
    where: { tenantId, userId },
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
  });
}

export async function countUnreadSecurityNotifications(tenantId: string, userId: string): Promise<number> {
  return prisma.securityNotification.count({ where: { tenantId, userId, readAt: null } });
}

/** Retourne `null` si la notification n'existe pas ou n'appartient pas à (tenantId, userId) —
 * jamais une erreur distincte (évite de révéler l'existence d'une notification appartenant à un
 * autre utilisateur). Idempotent : marquer une notification déjà lue comme lue ne change rien. */
export async function markSecurityNotificationRead(tenantId: string, userId: string, id: string) {
  const existing = await prisma.securityNotification.findFirst({ where: { id, tenantId, userId } });
  if (!existing) {
    return null;
  }
  if (existing.readAt) {
    return existing;
  }
  return prisma.securityNotification.update({ where: { id }, data: { readAt: new Date() } });
}

export async function markAllSecurityNotificationsRead(tenantId: string, userId: string): Promise<number> {
  const result = await prisma.securityNotification.updateMany({
    where: { tenantId, userId, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}
