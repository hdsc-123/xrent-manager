import { Prisma } from "@prisma/client";
import type { PermissionGroup, GroupPermission } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/authz";

/**
 * Système de permissions granulaires (Sprint 12C). Le catalogue des clés de permission
 * vit ici, en code — pas dans une table dédiée (voir le commentaire sur PermissionGroup
 * dans prisma/schema.prisma) — pour ne pas avoir à garder une table de référence
 * synchronisée avec le code à chaque nouvelle permission.
 *
 * Portée (voir HANDOFF.md, SECURITY.md) : seul le module Reservation applique ces
 * permissions côté serveur cette version-ci. Les autres modules (agencies, vehicles,
 * clients, locations, invoices, payments, reports, users, invitations, audit) gardent
 * leurs vérifications de rôle (`role !== "ADMIN"`) et `canAccessAgency()` actuelles,
 * inchangées — un retrofit complet aurait un risque de régression important sur les
 * décisions déjà validées (ex. DOMAINRULES.md section 4 : un MEMBER rattaché à une
 * agence peut supprimer les véhicules/locations de cette agence, ce qui contredirait le
 * groupe par défaut "MEMBER" ci-dessous si on l'appliquait aux routes existantes).
 * Le catalogue couvre néanmoins tous les modules dès maintenant, pour que la sidebar
 * (section 8 du sprint) puisse masquer ses entrées par permission dès ce sprint.
 */
export interface PermissionDefinition {
  key: string;
  label: string;
  category: string;
}

export const PERMISSIONS: PermissionDefinition[] = [
  { key: "agencies.view", label: "Voir les agences", category: "Agences" },
  { key: "agencies.create", label: "Créer des agences", category: "Agences" },
  { key: "agencies.edit", label: "Modifier des agences", category: "Agences" },
  { key: "agencies.delete", label: "Supprimer des agences", category: "Agences" },

  { key: "vehicles.view", label: "Voir les véhicules", category: "Véhicules" },
  { key: "vehicles.create", label: "Créer des véhicules", category: "Véhicules" },
  { key: "vehicles.edit", label: "Modifier des véhicules", category: "Véhicules" },
  { key: "vehicles.delete", label: "Supprimer des véhicules", category: "Véhicules" },

  { key: "clients.view", label: "Voir les clients", category: "Clients" },
  { key: "clients.create", label: "Créer des clients", category: "Clients" },
  { key: "clients.edit", label: "Modifier des clients", category: "Clients" },
  { key: "clients.delete", label: "Supprimer des clients", category: "Clients" },

  { key: "locations.view", label: "Voir les locations", category: "Locations" },
  { key: "locations.create", label: "Créer des locations", category: "Locations" },
  { key: "locations.edit", label: "Modifier des locations", category: "Locations" },
  { key: "locations.delete", label: "Supprimer des locations", category: "Locations" },

  { key: "reservations.view", label: "Voir les réservations", category: "Réservations" },
  { key: "reservations.create", label: "Créer des réservations", category: "Réservations" },
  { key: "reservations.edit", label: "Modifier des réservations", category: "Réservations" },
  { key: "reservations.delete", label: "Supprimer des réservations", category: "Réservations" },
  { key: "reservations.import", label: "Importer des réservations (Excel)", category: "Réservations" },
  { key: "reservations.convert", label: "Convertir une réservation en contrat", category: "Réservations" },

  { key: "invoices.view", label: "Voir les factures", category: "Factures" },
  { key: "invoices.create", label: "Créer des factures", category: "Factures" },
  { key: "invoices.edit", label: "Modifier des factures", category: "Factures" },
  { key: "invoices.delete", label: "Supprimer des factures", category: "Factures" },

  { key: "payments.view", label: "Voir les paiements", category: "Paiements" },
  { key: "payments.create", label: "Créer des paiements", category: "Paiements" },
  { key: "payments.delete", label: "Supprimer des paiements", category: "Paiements" },

  { key: "reports.view", label: "Voir les rapports", category: "Rapports" },

  { key: "users.view", label: "Voir les utilisateurs", category: "Utilisateurs" },
  { key: "users.create", label: "Créer des utilisateurs", category: "Utilisateurs" },
  { key: "users.edit", label: "Modifier des utilisateurs", category: "Utilisateurs" },
  { key: "users.delete", label: "Supprimer des utilisateurs", category: "Utilisateurs" },

  { key: "invitations.create", label: "Créer des invitations", category: "Invitations" },
  { key: "invitations.revoke", label: "Révoquer des invitations", category: "Invitations" },

  { key: "audit.view", label: "Voir le journal d'audit", category: "Audit" },
];

export const PERMISSION_KEYS = PERMISSIONS.map((permission) => permission.key);

interface DefaultGroupDefinition {
  name: string;
  permissions: string[];
}

/**
 * Groupes de base (spec Sprint 12C section 3), créés automatiquement pour chaque
 * tenant (voir ensureDefaultGroups). Le groupe "ADMIN" est créé pour référence/affichage
 * dans l'UI de gestion des groupes uniquement — un ADMIN (role === "ADMIN") n'a jamais
 * besoin d'y être rattaché, can() court-circuite déjà sur le rôle (voir plus bas).
 */
export const DEFAULT_GROUPS: DefaultGroupDefinition[] = [
  { name: "ADMIN", permissions: PERMISSION_KEYS },
  {
    name: "MEMBER",
    permissions: [
      "agencies.view",
      "vehicles.view",
      "vehicles.create",
      "vehicles.edit",
      "clients.view",
      "clients.create",
      "clients.edit",
      "locations.view",
      "locations.create",
      "locations.edit",
      "reservations.view",
      "reservations.create",
      "reservations.edit",
      "reservations.convert",
      "invoices.view",
      "invoices.create",
      "invoices.edit",
      "payments.view",
      "payments.create",
      "reports.view",
    ],
  },
  {
    name: "COMPTABILITÉ",
    permissions: [
      "invoices.view",
      "invoices.create",
      "invoices.edit",
      "invoices.delete",
      "payments.view",
      "payments.create",
      "payments.delete",
      "reports.view",
      "reservations.view",
    ],
  },
  {
    name: "AGENCE",
    permissions: [
      "vehicles.view",
      "vehicles.create",
      "vehicles.edit",
      "vehicles.delete",
      "locations.view",
      "locations.create",
      "locations.edit",
      "locations.delete",
      "clients.view",
      "clients.create",
      "clients.edit",
      "clients.delete",
      "reservations.view",
      "reservations.create",
      "reservations.edit",
      "reservations.delete",
      "reservations.convert",
    ],
  },
];

/**
 * Crée les 4 groupes par défaut pour un tenant s'il n'en a aucun encore — idempotent,
 * appelée à l'inscription (nouveaux tenants) et paresseusement depuis les pages de
 * gestion des permissions (backfill des tenants existants, sans script de migration
 * séparé). Ignore silencieusement une violation de contrainte unique (P2002) en cas
 * d'appels concurrents.
 */
export async function ensureDefaultGroups(tenantId: string): Promise<void> {
  const existing = await prisma.permissionGroup.findMany({
    where: { tenantId },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((group) => group.name));

  for (const def of DEFAULT_GROUPS) {
    if (existingNames.has(def.name)) {
      continue;
    }

    try {
      await prisma.permissionGroup.create({
        data: {
          tenantId,
          name: def.name,
          groupPermissions: {
            createMany: { data: def.permissions.map((permissionKey) => ({ permissionKey })) },
          },
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
        throw error;
      }
    }
  }
}

/**
 * Permissions effectives d'un user : union des permissions de son groupe et de ses
 * UserPermission individuelles (additives, jamais de retrait — spec section 3). Un ADMIN
 * a toujours toutes les permissions, sans jamais consulter les tables de permission.
 */
export async function getEffectivePermissions(user: SessionUser): Promise<Set<string>> {
  if (user.role === "ADMIN") {
    return new Set(PERMISSION_KEYS);
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      permissionGroupId: true,
      userPermissions: { select: { permissionKey: true } },
    },
  });

  const keys = new Set<string>();
  if (!dbUser) {
    return keys;
  }

  if (dbUser.permissionGroupId) {
    const groupPermissions = await prisma.groupPermission.findMany({
      where: { groupId: dbUser.permissionGroupId },
      select: { permissionKey: true },
    });
    for (const groupPermission of groupPermissions) {
      keys.add(groupPermission.permissionKey);
    }
  }

  for (const userPermission of dbUser.userPermissions) {
    keys.add(userPermission.permissionKey);
  }

  return keys;
}

export async function can(user: SessionUser, permissionKey: string): Promise<boolean> {
  if (user.role === "ADMIN") {
    return true;
  }

  const keys = await getEffectivePermissions(user);
  return keys.has(permissionKey);
}

export class PermissionGroupNameInUseError extends Error {
  constructor() {
    super("Un groupe de permissions avec ce nom existe déjà.");
    this.name = "PermissionGroupNameInUseError";
  }
}

export class PermissionGroupHasUsersError extends Error {
  constructor() {
    super("Impossible de supprimer un groupe encore assigné à des utilisateurs.");
    this.name = "PermissionGroupHasUsersError";
  }
}

export class InvalidPermissionGroupError extends Error {
  constructor() {
    super("Groupe de permissions introuvable.");
    this.name = "InvalidPermissionGroupError";
  }
}

export interface PermissionGroupWithPermissions {
  id: string;
  tenantId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  permissions: string[];
}

function toGroupWithPermissions(
  group: PermissionGroup & { groupPermissions: GroupPermission[] }
): PermissionGroupWithPermissions {
  return {
    id: group.id,
    tenantId: group.tenantId,
    name: group.name,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    permissions: group.groupPermissions.map((groupPermission) => groupPermission.permissionKey),
  };
}

export async function getPermissionGroups(tenantId: string): Promise<PermissionGroupWithPermissions[]> {
  const groups = await prisma.permissionGroup.findMany({
    where: { tenantId },
    include: { groupPermissions: true },
    orderBy: { createdAt: "asc" },
  });
  return groups.map(toGroupWithPermissions);
}

export async function getPermissionGroupById(
  tenantId: string,
  groupId: string
): Promise<PermissionGroupWithPermissions | null> {
  const group = await prisma.permissionGroup.findFirst({
    where: { id: groupId, tenantId },
    include: { groupPermissions: true },
  });
  return group ? toGroupWithPermissions(group) : null;
}

export interface CreatePermissionGroupInput {
  tenantId: string;
  name: string;
  permissions: string[];
}

export async function createPermissionGroup(
  data: CreatePermissionGroupInput
): Promise<PermissionGroupWithPermissions> {
  const validKeys = data.permissions.filter((key) => PERMISSION_KEYS.includes(key));

  try {
    const group = await prisma.permissionGroup.create({
      data: {
        tenantId: data.tenantId,
        name: data.name,
        groupPermissions: { createMany: { data: validKeys.map((permissionKey) => ({ permissionKey })) } },
      },
      include: { groupPermissions: true },
    });
    return toGroupWithPermissions(group);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new PermissionGroupNameInUseError();
    }
    throw error;
  }
}

export interface UpdatePermissionGroupInput {
  name?: string;
  permissions?: string[];
}

export async function updatePermissionGroup(
  tenantId: string,
  groupId: string,
  data: UpdatePermissionGroupInput
): Promise<PermissionGroupWithPermissions | null> {
  const existing = await prisma.permissionGroup.findFirst({ where: { id: groupId, tenantId } });
  if (!existing) {
    return null;
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (data.name !== undefined) {
        await tx.permissionGroup.update({ where: { id: groupId }, data: { name: data.name } });
      }
      if (data.permissions !== undefined) {
        const validKeys = data.permissions.filter((key) => PERMISSION_KEYS.includes(key));
        await tx.groupPermission.deleteMany({ where: { groupId } });
        if (validKeys.length > 0) {
          await tx.groupPermission.createMany({
            data: validKeys.map((permissionKey) => ({ groupId, permissionKey })),
          });
        }
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new PermissionGroupNameInUseError();
    }
    throw error;
  }

  return getPermissionGroupById(tenantId, groupId);
}

/** Bloque la suppression tant que des users sont encore rattachés (même principe que
 * ClientHasLocationsError/VehicleHasLocationsError) plutôt que de les faire silencieusement
 * retomber sans permission (permissionGroupId a onDelete: SetNull, techniquement possible,
 * mais retirer silencieusement l'accès d'un user n'est pas souhaitable). */
export async function deletePermissionGroup(tenantId: string, groupId: string): Promise<boolean> {
  const existing = await prisma.permissionGroup.findFirst({ where: { id: groupId, tenantId } });
  if (!existing) {
    return false;
  }

  const userCount = await prisma.user.count({ where: { permissionGroupId: groupId } });
  if (userCount > 0) {
    throw new PermissionGroupHasUsersError();
  }

  await prisma.permissionGroup.delete({ where: { id: groupId } });
  return true;
}

export interface UserPermissionsView {
  userId: string;
  permissionGroupId: string | null;
  groupPermissions: string[];
  individualPermissions: string[];
  effectivePermissions: string[];
}

export async function getUserPermissionsView(
  tenantId: string,
  userId: string
): Promise<UserPermissionsView | null> {
  const dbUser = await prisma.user.findFirst({
    where: { id: userId, tenantId },
    select: {
      id: true,
      role: true,
      permissionGroupId: true,
      userPermissions: { select: { permissionKey: true } },
    },
  });
  if (!dbUser) {
    return null;
  }

  const groupPermissions = dbUser.permissionGroupId
    ? (
        await prisma.groupPermission.findMany({
          where: { groupId: dbUser.permissionGroupId },
          select: { permissionKey: true },
        })
      ).map((groupPermission) => groupPermission.permissionKey)
    : [];
  const individualPermissions = dbUser.userPermissions.map((userPermission) => userPermission.permissionKey);

  const effectivePermissions =
    dbUser.role === "ADMIN"
      ? PERMISSION_KEYS
      : Array.from(new Set([...groupPermissions, ...individualPermissions]));

  return {
    userId: dbUser.id,
    permissionGroupId: dbUser.permissionGroupId,
    groupPermissions,
    individualPermissions,
    effectivePermissions,
  };
}

export interface SetUserPermissionsInput {
  permissionGroupId?: string | null;
  individualPermissions?: string[];
}

export async function setUserPermissions(
  tenantId: string,
  userId: string,
  data: SetUserPermissionsInput
): Promise<UserPermissionsView | null> {
  const existing = await prisma.user.findFirst({ where: { id: userId, tenantId } });
  if (!existing) {
    return null;
  }

  if (data.permissionGroupId !== undefined && data.permissionGroupId !== null) {
    const group = await prisma.permissionGroup.findFirst({
      where: { id: data.permissionGroupId, tenantId },
    });
    if (!group) {
      throw new InvalidPermissionGroupError();
    }
  }

  await prisma.$transaction(async (tx) => {
    if (data.permissionGroupId !== undefined) {
      await tx.user.update({ where: { id: userId }, data: { permissionGroupId: data.permissionGroupId } });
    }
    if (data.individualPermissions !== undefined) {
      const validKeys = data.individualPermissions.filter((key) => PERMISSION_KEYS.includes(key));
      await tx.userPermission.deleteMany({ where: { userId } });
      if (validKeys.length > 0) {
        await tx.userPermission.createMany({
          data: validKeys.map((permissionKey) => ({ userId, permissionKey })),
        });
      }
    }
  });

  return getUserPermissionsView(tenantId, userId);
}
