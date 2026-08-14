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
 * Portée (Sprint 15, DOMAINRULES.md section 22) : ces permissions sont désormais
 * appliquées côté serveur sur (quasiment) tous les modules métier — agencies, vehicles,
 * clients, locations, reservations, invoices, payments, reports, maintenances, alerts,
 * cash_register, vehicle_transfers, vehicle_trips — en complément, jamais en remplacement,
 * de `canAccessAgency()`/`getAccessibleAgencyIds()` là où elles existent déjà. Restent
 * volontairement en contrôle de rôle strict (ADMIN only), non convertis en `can()` :
 * users, invitations, permission-groups, tenants, data-reset, audit — DOMAINRULES.md
 * section 4 réserve explicitement la gestion des utilisateurs à ADMIN, même sur son
 * propre compte ; les clés `users.*`/`invitations.*`/`audit.view` du catalogue restent
 * donc décoratives (choix délibéré, pas un oubli). Les groupes par défaut ci-dessous ont
 * été mis à jour pour préserver le comportement effectif d'aujourd'hui (aucune régression
 * involontaire) — voir le commentaire sur chaque groupe.
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

  { key: "maintenances.view", label: "Voir les maintenances", category: "Maintenances" },
  { key: "maintenances.create", label: "Planifier des maintenances", category: "Maintenances" },
  { key: "maintenances.edit", label: "Modifier des maintenances", category: "Maintenances" },
  { key: "maintenances.delete", label: "Supprimer des maintenances", category: "Maintenances" },

  { key: "alerts.view", label: "Voir les alertes", category: "Alertes" },
  { key: "alerts.acknowledge", label: "Acquitter des alertes", category: "Alertes" },
  { key: "alerts.resolve", label: "Résoudre des alertes", category: "Alertes" },

  { key: "cash_register.view", label: "Voir la caisse", category: "Caisse" },
  { key: "cash_register.create_entry", label: "Enregistrer une entrée de caisse", category: "Caisse" },
  { key: "cash_register.create_expense", label: "Enregistrer une dépense de caisse", category: "Caisse" },
  { key: "cash_register.manage_categories", label: "Gérer les catégories de dépense", category: "Caisse" },

  { key: "vehicle_transfers.view", label: "Voir les transferts de véhicules", category: "Transferts" },
  { key: "vehicle_transfers.create", label: "Lancer un transfert de véhicule", category: "Transferts" },
  { key: "vehicle_transfers.validate", label: "Valider un transfert de véhicule", category: "Transferts" },
  { key: "vehicle_transfers.cancel", label: "Annuler un transfert de véhicule", category: "Transferts" },

  { key: "vehicle_trips.view", label: "Voir les bons de déplacement", category: "Déplacements" },
  { key: "vehicle_trips.create", label: "Créer un bon de déplacement", category: "Déplacements" },
  { key: "vehicle_trips.return", label: "Enregistrer un retour de déplacement", category: "Déplacements" },
  { key: "vehicle_trips.cancel", label: "Annuler un bon de déplacement", category: "Déplacements" },
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
    // Sprint 15 : vehicles.delete/locations.delete/clients.delete/invoices.delete/
    // payments.delete et les modules maintenances/alerts/cash_register/vehicle_transfers/
    // vehicle_trips ont été ajoutés pour préserver le comportement actuel — ces actions
    // étaient possibles sans aucune restriction avant le retrofit des routes (seul
    // canAccessAgency() s'appliquait), les retirer par défaut aurait été une régression
    // fonctionnelle silencieuse, pas un simple resserrement de sécurité.
    name: "MEMBER",
    permissions: [
      "agencies.view",
      "vehicles.view",
      "vehicles.create",
      "vehicles.edit",
      "vehicles.delete",
      "clients.view",
      "clients.create",
      "clients.edit",
      "clients.delete",
      "locations.view",
      "locations.create",
      "locations.edit",
      "locations.delete",
      "reservations.view",
      "reservations.create",
      "reservations.edit",
      "reservations.convert",
      "invoices.view",
      "invoices.create",
      "invoices.edit",
      "invoices.delete",
      "payments.view",
      "payments.create",
      "payments.delete",
      "reports.view",
      "maintenances.view",
      "maintenances.create",
      "maintenances.edit",
      "maintenances.delete",
      "alerts.view",
      "alerts.acknowledge",
      "alerts.resolve",
      "cash_register.view",
      "cash_register.create_entry",
      "cash_register.create_expense",
      "cash_register.manage_categories",
      "vehicle_transfers.view",
      "vehicle_transfers.create",
      "vehicle_transfers.validate",
      "vehicle_transfers.cancel",
      "vehicle_trips.view",
      "vehicle_trips.create",
      "vehicle_trips.return",
      "vehicle_trips.cancel",
    ],
  },
  {
    // Sprint 15 : resserrement assumé (confirmé explicitement avec le propriétaire du
    // projet) — ce groupe reste scopé finance/reporting, sans accès véhicules/locations/
    // clients/maintenances, même si ces actions étaient possibles sans restriction avant
    // le retrofit des routes (cohérent avec la description du rôle "comptabilité").
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
    // Sprint 15 : maintenances/alerts/vehicle_transfers/vehicle_trips ajoutés (modules
    // opérationnels d'agence, cohérents avec la vocation de ce groupe) ; invoices.view/
    // create/edit et payments.view/create ajoutés pour préserver la capacité de facturer/
    // encaisser un contrat de son agence, déjà possible sans restriction avant le retrofit.
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
      "invoices.view",
      "invoices.create",
      "invoices.edit",
      "payments.view",
      "payments.create",
      "maintenances.view",
      "maintenances.create",
      "maintenances.edit",
      "maintenances.delete",
      "alerts.view",
      "alerts.acknowledge",
      "alerts.resolve",
      "vehicle_transfers.view",
      "vehicle_transfers.create",
      "vehicle_transfers.validate",
      "vehicle_transfers.cancel",
      "vehicle_trips.view",
      "vehicle_trips.create",
      "vehicle_trips.return",
      "vehicle_trips.cancel",
    ],
  },
];

/**
 * Sprint 15 : clés nouvellement introduites par le retrofit de permissions (nouveaux
 * modules maintenances/alerts/cash_register/vehicle_transfers/vehicle_trips, plus les
 * suppressions/factures/paiements ajoutées à MEMBER/AGENCE pour préserver leur comportement
 * actuel — voir le commentaire sur DEFAULT_GROUPS ci-dessus). Un tenant déjà existant a déjà
 * ses groupes MEMBER/COMPTABILITÉ/AGENCE en base (créés par un Sprint antérieur) :
 * `ensureDefaultGroups` ci-dessous ne les recrée jamais (idempotent par nom), donc ces
 * nouvelles clés ne leur seraient jamais ajoutées sans ce backfill explicite — laissant un
 * MEMBER déjà en poste soudainement bloqué sur des actions qu'il pouvait faire sans
 * restriction avant ce sprint (aucune vérification de permission n'existait). Seules les
 * clés listées ici sont fusionnées (union, jamais de retrait) dans les groupes déjà
 * existants portant ces noms — les clés antérieures à ce sprint, potentiellement déjà
 * personnalisées par un ADMIN, ne sont jamais touchées.
 */
const SPRINT15_BACKFILL_PERMISSIONS: Record<string, string[]> = {
  MEMBER: [
    "vehicles.delete",
    "clients.delete",
    "locations.delete",
    "invoices.delete",
    "payments.delete",
    "maintenances.view",
    "maintenances.create",
    "maintenances.edit",
    "maintenances.delete",
    "alerts.view",
    "alerts.acknowledge",
    "alerts.resolve",
    "cash_register.view",
    "cash_register.create_entry",
    "cash_register.create_expense",
    "cash_register.manage_categories",
    "vehicle_transfers.view",
    "vehicle_transfers.create",
    "vehicle_transfers.validate",
    "vehicle_transfers.cancel",
    "vehicle_trips.view",
    "vehicle_trips.create",
    "vehicle_trips.return",
    "vehicle_trips.cancel",
  ],
  AGENCE: [
    "invoices.view",
    "invoices.create",
    "invoices.edit",
    "payments.view",
    "payments.create",
    "maintenances.view",
    "maintenances.create",
    "maintenances.edit",
    "maintenances.delete",
    "alerts.view",
    "alerts.acknowledge",
    "alerts.resolve",
    "vehicle_transfers.view",
    "vehicle_transfers.create",
    "vehicle_transfers.validate",
    "vehicle_transfers.cancel",
    "vehicle_trips.view",
    "vehicle_trips.create",
    "vehicle_trips.return",
    "vehicle_trips.cancel",
  ],
};

/**
 * Crée les groupes par défaut pour un tenant s'il n'en a aucun encore — idempotent,
 * appelée à l'inscription (nouveaux tenants) et paresseusement depuis les pages de
 * gestion des permissions (backfill des tenants existants, sans script de migration
 * séparé). Ignore silencieusement une violation de contrainte unique (P2002) en cas
 * d'appels concurrents. Pour un groupe par défaut déjà existant, fusionne en plus les
 * nouvelles clés Sprint 15 manquantes (voir SPRINT15_BACKFILL_PERMISSIONS ci-dessus).
 */
export async function ensureDefaultGroups(tenantId: string): Promise<void> {
  const existingGroups = await prisma.permissionGroup.findMany({
    where: { tenantId },
    select: { id: true, name: true },
  });
  const existingByName = new Map(existingGroups.map((group) => [group.name, group.id]));

  for (const def of DEFAULT_GROUPS) {
    const existingGroupId = existingByName.get(def.name);

    if (existingGroupId === undefined) {
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
      continue;
    }

    const backfill = SPRINT15_BACKFILL_PERMISSIONS[def.name];
    if (backfill && backfill.length > 0) {
      await prisma.groupPermission.createMany({
        data: backfill.map((permissionKey) => ({ groupId: existingGroupId, permissionKey })),
        skipDuplicates: true,
      });
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
  } else {
    // Sprint 15 : un MEMBER n'ayant jamais été explicitement rattaché à un groupe (aucun
    // code de l'application ne le fait automatiquement à sa création — invitation acceptée,
    // voir src/lib/invitations.ts) retombe implicitement sur le groupe par défaut "MEMBER"
    // (DEFAULT_GROUPS ci-dessus), plutôt que sur un ensemble vide. Avant le retrofit de ce
    // sprint, l'absence de permission granulaire n'avait aucun effet (seuls role/agence
    // comptaient) ; un MEMBER non assigné se retrouverait sinon totalement bloqué sur tous
    // les modules dès la création de son compte — régression réelle, pas un simple
    // resserrement, et contraire à l'objectif explicite des DEFAULT_GROUPS (préserver le
    // comportement actuel). N'affecte jamais un groupe personnalisé explicitement assigné,
    // même vide (id renseigné) : seule l'absence totale d'assignation retombe ici.
    const memberDefaults = DEFAULT_GROUPS.find((group) => group.name === "MEMBER");
    for (const permissionKey of memberDefaults?.permissions ?? []) {
      keys.add(permissionKey);
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
