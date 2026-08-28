import type { LocationUpgrade, LocationUpgradeType, Prisma, Vehicle } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { calculateDaysCount } from "@/lib/locations";
import { checkAvailability } from "@/lib/vehicles";

/**
 * Surclassement (campagne QA, 2026-08-27, passe de correction obligatoire) — voir
 * DOMAINRULES.md section 70 pour le modèle métier complet. Le serveur ne fait jamais confiance
 * aux valeurs critiques envoyées par le navigateur : `reservedCategory`/`assignedCategory` sont
 * toujours dérivées de la réservation et du véhicule réellement chargés en base
 * (`Reservation.vehicleCategory`/`Vehicle.category`), jamais acceptées telles quelles depuis le
 * corps de la requête ; `dailySupplement`/`totalSupplement` sont recalculés ici, jamais copiés
 * depuis une valeur cliente.
 *
 * **Limite documentée, assumée explicitement** : aucune notion de hiérarchie/rang entre
 * catégories de véhicule n'existe nulle part dans le produit (`Vehicle.category` et
 * `Reservation.vehicleCategory` sont du texte libre, DOMAINRULES.md section 6 — aucun modèle de
 * référence, aucun champ de rang). Il est donc impossible de distinguer mécaniquement une
 * catégorie "supérieure" d'une catégorie "inférieure" sans inventer une taxonomie non validée
 * par le propriétaire du projet (CLAUDE.md règle 8). Ce module applique donc la règle
 * mécaniquement vérifiable la plus proche : toute catégorie **différente** de la catégorie
 * réservée doit être déclarée explicitement comme un surclassement (avec motif, type, et accord/
 * justification selon le type) — un vrai contrôle de rang reste **à décider** si une hiérarchie
 * de catégories est un jour formalisée.
 */

const UPGRADE_TYPES: LocationUpgradeType[] = ["CUSTOMER_REQUEST", "UNAVAILABILITY", "COMMERCIAL_GESTURE"];

/** Même liste que VEHICLE_STATUSES_BLOCKING_LOCATION (src/lib/locations.ts) — dupliquée
 * plutôt qu'importée pour éviter un couplage superflu entre ces deux modules (même principe
 * déjà appliqué à InvalidFuelLevelError/locationAgencyScopeWhere, DOMAINRULES.md section 25).
 * INACTIVE retiré (sprint "statut opérationnel automatique", 2026-08-28) : n'est plus une
 * valeur possible de VehicleStatus (remplacé par l'état administratif séparé
 * Vehicle.deactivatedAt, vérifié indépendamment dans isCategoryReallyAvailable ci-dessous) —
 * corrigé ici après avoir été omis de la première passe de ce sprint (cette copie dupliquée
 * n'avait pas été repérée avant relecture). */
const VEHICLE_STATUSES_UNAVAILABLE = ["MAINTENANCE", "TRANSFERRING", "ON_TRIP"] as const;

export class InvalidUpgradeTypeError extends Error {
  constructor() {
    super("type de surclassement invalide.");
    this.name = "InvalidUpgradeTypeError";
  }
}

export class UpgradeNotNeededError extends Error {
  constructor() {
    super(
      "Aucun surclassement nécessaire : la catégorie du véhicule choisi correspond à la catégorie réservée."
    );
    this.name = "UpgradeNotNeededError";
  }
}

export class UpgradeDeclarationRequiredError extends Error {
  constructor(reservedCategory: string, assignedCategory: string) {
    super(
      `Le véhicule choisi (catégorie "${assignedCategory}") ne correspond pas à la catégorie réservée ("${reservedCategory}") : un surclassement doit être déclaré explicitement (type, motif, et accord ou justification selon le type).`
    );
    this.name = "UpgradeDeclarationRequiredError";
  }
}

export class UpgradeReasonRequiredError extends Error {
  constructor() {
    super("Le motif du surclassement est obligatoire.");
    this.name = "UpgradeReasonRequiredError";
  }
}

export class UpgradeConsentRequiredError extends Error {
  constructor() {
    super("L'accord explicite du client est obligatoire pour un surclassement de type CUSTOMER_REQUEST.");
    this.name = "UpgradeConsentRequiredError";
  }
}

export class UpgradeSupplementInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpgradeSupplementInvalidError";
  }
}

export class UpgradeCategoryStillAvailableError extends Error {
  constructor(category: string) {
    super(
      `La catégorie réservée ("${category}") a au moins un véhicule réellement disponible sur cette période : le type UNAVAILABILITY ne peut pas être utilisé.`
    );
    this.name = "UpgradeCategoryStillAvailableError";
  }
}

export interface UpgradeInput {
  type?: string;
  dailySupplement?: number;
  customerConsent?: boolean;
  reason?: string;
}

export interface CreateLocationUpgradeInput {
  tenantId: string;
  vehicle: Vehicle;
  reservedCategory: string;
  startDate: Date;
  endDate: Date;
  validatedByUserId: string;
  upgrade?: UpgradeInput;
}

/** Champs prêts pour tx.locationUpgrade.create (forme "unchecked" — clés étrangères directes,
 * même convention que createLocationLocked, src/lib/locations.ts) — tenantId/locationId/
 * reservationId/vehicleId/currency restent à la charge de l'appelant (connus uniquement après
 * création de la Location, voir POST /api/reservations/[id]/convert). */
export interface ResolvedUpgradeData {
  type: LocationUpgradeType;
  reservedCategory: string;
  assignedCategory: string;
  dailySupplement: number;
  daysCount: number;
  totalSupplement: number;
  customerConsent: boolean;
  operationalReason: string;
  validatedByUserId: string;
}

export interface UpgradeResolution {
  /** Non nul uniquement si un surclassement doit réellement être enregistré. */
  data: ResolvedUpgradeData | null;
}

/**
 * Résout et valide un éventuel surclassement — appelée à l'intérieur de la transaction de
 * conversion, après verrouillage du véhicule (même précondition que createLocation). Ne crée
 * rien elle-même : renvoie les données prêtes pour `tx.locationUpgrade.create`, ou `null` si
 * aucun surclassement n'est nécessaire (catégories identiques ou réservation sans catégorie).
 */
export async function resolveLocationUpgrade(
  input: CreateLocationUpgradeInput,
  tx: Prisma.TransactionClient = prisma
): Promise<UpgradeResolution> {
  const assignedCategory = input.vehicle.category;
  const reservedCategory = input.reservedCategory?.trim();

  const categoriesDiffer = !!reservedCategory && reservedCategory !== assignedCategory;

  if (!categoriesDiffer) {
    if (input.upgrade) {
      throw new UpgradeNotNeededError();
    }
    return { data: null };
  }

  if (!input.upgrade) {
    throw new UpgradeDeclarationRequiredError(reservedCategory, assignedCategory);
  }

  const type = input.upgrade.type;
  if (!type || !UPGRADE_TYPES.includes(type as LocationUpgradeType)) {
    throw new InvalidUpgradeTypeError();
  }

  const reason = input.upgrade.reason?.trim();
  if (!reason) {
    throw new UpgradeReasonRequiredError();
  }

  const daysCount = calculateDaysCount(input.startDate, input.endDate);
  let dailySupplement: number;

  if (type === "CUSTOMER_REQUEST") {
    if (!input.upgrade.customerConsent) {
      throw new UpgradeConsentRequiredError();
    }
    dailySupplement = input.upgrade.dailySupplement ?? 0;
    if (!Number.isInteger(dailySupplement) || dailySupplement < 1) {
      throw new UpgradeSupplementInvalidError(
        "Un surclassement demandé par le client (CUSTOMER_REQUEST) doit avoir un supplément par jour strictement positif (entier, centimes)."
      );
    }
  } else if (type === "UNAVAILABILITY") {
    if (input.upgrade.dailySupplement !== undefined && input.upgrade.dailySupplement !== 0) {
      throw new UpgradeSupplementInvalidError(
        "Un surclassement pour indisponibilité (UNAVAILABILITY) est gratuit par défaut : aucun supplément ne peut être ajouté."
      );
    }
    dailySupplement = 0;

    const available = await isCategoryReallyAvailable(
      input.tenantId,
      input.vehicle.agencyId,
      reservedCategory,
      input.startDate,
      input.endDate,
      tx
    );
    if (available) {
      throw new UpgradeCategoryStillAvailableError(reservedCategory);
    }
  } else {
    // COMMERCIAL_GESTURE — supplément nul ou réduit, jamais négatif ; la permission dédiée
    // (locations.upgrade.commercial_gesture) est vérifiée côté route (SECURITY.md section 4 :
    // les contrôles de permission restent toujours dans la couche route/authz, jamais ici).
    dailySupplement = input.upgrade.dailySupplement ?? 0;
    if (!Number.isInteger(dailySupplement) || dailySupplement < 0) {
      throw new UpgradeSupplementInvalidError(
        "Le supplément d'un geste commercial (COMMERCIAL_GESTURE) doit être un entier positif ou nul (centimes)."
      );
    }
  }

  const totalSupplement = dailySupplement * daysCount;

  return {
    data: {
      type: type as LocationUpgradeType,
      reservedCategory,
      assignedCategory,
      dailySupplement,
      daysCount,
      totalSupplement,
      // currency est renseignée par l'appelant (devise réelle du contrat, connue seulement
      // après création de la Location — voir POST /api/reservations/[id]/convert).
      customerConsent: type === "CUSTOMER_REQUEST" ? true : false,
      operationalReason: reason,
      validatedByUserId: input.validatedByUserId,
    },
  };
}

/** Vérifie si au moins un véhicule de la catégorie réservée est réellement disponible (statut
 * hors {MAINTENANCE, TRANSFERRING, ON_TRIP}, non désactivé administrativement, et aucun conflit
 * de dates), **dans l'agence qui traite le contrat** — utilisée uniquement pour valider un motif
 * UNAVAILABILITY.
 *
 * Bug trouvé (campagne QA, partie 3, 2026-08-28) : cette vérification portait jusqu'ici sur
 * l'ensemble du tenant, toutes agences confondues (`{ tenantId, category }`, sans `agencyId`) —
 * un véhicule de la catégorie réservée réellement disponible dans une agence distante (ex.
 * Casablanca) faisait refuser à tort (409) une déclaration UNAVAILABILITY pourtant exacte pour
 * l'agence qui traite réellement le contrat (ex. Marrakech), alors qu'aucun véhicule de cette
 * catégorie n'y est disponible. Incohérent avec le reste du parcours (le sélecteur de véhicule
 * de conversion est lui-même scopé par agence, et l'agence du contrat est dérivée du véhicule
 * choisi) et avec la portée déjà agence-scopée de `checkAvailability`/`assertVehicleStatusAllowsLocation`
 * pour toute autre vérification de disponibilité de ce parcours. Corrigé en scopant la recherche
 * de véhicules candidats à `vehicle.agencyId` (l'agence réellement assignée au contrat, dérivée
 * du véhicule choisi — jamais `Reservation.pickupAgencyId`, texte libre non fiable, voir
 * DOMAINRULES.md section 21).
 *
 * Ne vérifie pas les conflits de maintenance planifiée (portée volontairement proportionnée : un
 * contrôle de bonne foi, pas une garantie exhaustive — voir le commentaire d'en-tête du fichier). */
async function isCategoryReallyAvailable(
  tenantId: string,
  agencyId: string,
  category: string,
  start: Date,
  end: Date,
  tx: Prisma.TransactionClient
): Promise<boolean> {
  const candidates = await tx.vehicle.findMany({ where: { tenantId, agencyId, category } });
  for (const candidate of candidates) {
    if (VEHICLE_STATUSES_UNAVAILABLE.includes(candidate.status as (typeof VEHICLE_STATUSES_UNAVAILABLE)[number])) {
      continue;
    }
    // Sprint "statut opérationnel automatique" (2026-08-28) : un véhicule désactivé
    // administrativement n'est jamais réellement disponible, quel que soit son statut
    // opérationnel calculé (voir src/lib/vehicle-status.ts).
    if (candidate.deactivatedAt) {
      continue;
    }
    const availability = await checkAvailability(tenantId, candidate.id, start, end, undefined, tx);
    if (availability?.available) {
      return true;
    }
  }
  return false;
}

export async function getLocationUpgradeByLocationId(
  tenantId: string,
  locationId: string
): Promise<LocationUpgrade | null> {
  return prisma.locationUpgrade.findFirst({ where: { tenantId, locationId } });
}
