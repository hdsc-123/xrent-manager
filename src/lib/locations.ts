import type { Client, Location, LocationStatus, Maintenance, PaymentMethod, Prisma, Vehicle, VehicleStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { checkAvailability, lockVehicleForUpdate, findConflictingMaintenances } from "@/lib/vehicles";
import { assertVehicleNotDeactivated, syncVehicleStatus, syncVehicleOdometerAndFuel } from "@/lib/vehicle-status";
import { calculateDaysCount } from "@/lib/format";
import { getClientById } from "@/lib/clients";
import { createCorrectionCashEntry, CorrectionReasonRequiredError } from "@/lib/cash-register";

/**
 * Fragment Prisma centralisé pour restreindre une requête `Location` (liste ou export) aux
 * agences accessibles à l'appelant — agence de rattachement (agencyId) OU agence de retour
 * (dropoffAgencyId), même règle que canAccessLocationAgency (src/lib/authz.ts), qui ne
 * s'appliquait jusqu'ici qu'aux routes de détail/action sur UNE location. Avant cette
 * centralisation, plusieurs listes (GET /api/locations, dashboard/locations, export CSV) ne
 * filtraient que sur agencyId et masquaient à tort les contrats dont seule l'agence de retour
 * était accessible à l'utilisateur (BUG-004, voir INCIDENTS.md) — toute nouvelle liste/export
 * doit utiliser cette fonction plutôt que reconstruire le filtre. Définie ici (et non dans
 * src/lib/authz.ts, malgré la parenté avec canAccessLocationAgency) volontairement : fragment
 * Prisma pur, sans dépendance à la session/l'auth — la placer dans authz.ts forcerait tout
 * module qui importe @/lib/locations à charger next-auth transitivement (voir le commentaire
 * dans authz.ts).
 * `accessibleAgencyIds` : `null` = aucune restriction (ADMIN) ; tableau = restriction stricte
 * (tableau vide = aucun accès, ne doit jamais être confondu avec `null`).
 */
export function locationAgencyScopeWhere(accessibleAgencyIds: string[] | null): Prisma.LocationWhereInput {
  if (accessibleAgencyIds === null) {
    return {};
  }
  return {
    OR: [{ agencyId: { in: accessibleAgencyIds } }, { dropoffAgencyId: { in: accessibleAgencyIds } }],
  };
}

export { CorrectionReasonRequiredError };

export class InvalidDateRangeError extends Error {
  constructor() {
    super("endDate doit être postérieure à startDate.");
    this.name = "InvalidDateRangeError";
  }
}

/** Risque résiduel B (HANDOFF.md, Phase 6.2) : `notes` est reproduit tel quel dans le contrat PDF
 * (ContractPdf.tsx) — une valeur disproportionnée dégraderait ce rendu sans qu'aucune limite
 * serveur n'existe jusqu'ici. Refusée explicitement (400), jamais tronquée silencieusement. */
export const MAX_LOCATION_NOTES_LENGTH = 5000;

export class InvalidLocationNotesError extends Error {
  constructor() {
    super(`Les notes ne doivent pas dépasser ${MAX_LOCATION_NOTES_LENGTH} caractères.`);
    this.name = "InvalidLocationNotesError";
  }
}

function assertValidLocationNotes(notes: string | null | undefined): void {
  if (notes != null && notes.length > MAX_LOCATION_NOTES_LENGTH) {
    throw new InvalidLocationNotesError();
  }
}

export class VehicleNotFoundError extends Error {
  constructor() {
    super("Véhicule introuvable.");
    this.name = "VehicleNotFoundError";
  }
}

export class ClientNotFoundError extends Error {
  constructor() {
    super("Client introuvable.");
    this.name = "ClientNotFoundError";
  }
}

/** Sprint 19 — second conducteur (voir Location.secondDriverId, réutilise Client). */
export class SecondDriverNotFoundError extends Error {
  constructor() {
    super("Second conducteur introuvable.");
    this.name = "SecondDriverNotFoundError";
  }
}

/**
 * Sprint 29 (DOMAINRULES.md section 44, point 16) : sans date d'expiration de permis connue
 * pour le client principal, sa validité jusqu'à la date de retour ne peut pas être démontrée —
 * refusée plutôt que silencieusement acceptée. Ne s'applique qu'au client principal
 * (data.clientId) : le second conducteur (ConvertSecondDriverInput, POST
 * /api/reservations/[id]/convert) n'a pas de champ licenseExpiryDate et n'est donc jamais
 * concerné par cette règle (décision validée explicitement avec le propriétaire du projet).
 */
export class MissingDriverLicenseExpiryError extends Error {
  constructor() {
    super(
      "La date d'expiration du permis de conduire du client n'est pas renseignée : impossible " +
        "de vérifier sa validité jusqu'à la date de retour prévue. Complétez la date d'expiration " +
        "du permis dans la fiche client avant de générer le contrat."
    );
    this.name = "MissingDriverLicenseExpiryError";
  }
}

/**
 * Sprint 29 (DOMAINRULES.md section 44, point 16) : le permis de conduire du client principal
 * doit rester valide au moins jusqu'à la date de retour du contrat — comparaison sur le jour
 * calendaire UTC uniquement (voir toUtcDateOnly ci-dessous), jamais sur l'heure locale du
 * serveur ; une expiration exactement égale à la date de retour est acceptée (décision validée
 * explicitement).
 */
export class DriverLicenseExpiredError extends Error {
  constructor() {
    super(
      "Le permis de conduire du client expire avant la date de retour prévue du contrat : " +
        "impossible de générer le contrat. Modifiez la date de retour ou mettez à jour la date " +
        "d'expiration du permis dans la fiche client."
    );
    this.name = "DriverLicenseExpiredError";
  }
}

/** Sprint 29 — normalise une date à son jour calendaire UTC (minuit UTC), pour une comparaison
 * indépendante de l'heure et du fuseau horaire local du serveur. */
function toUtcDateOnly(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Sprint 29 — appliquée uniquement à la création d'un contrat (voir createLocationLocked
 * ci-dessous), jamais à updateLocation (portée volontairement limitée, DOMAINRULES.md
 * section 44) : un contrat PENDING dont la date de retour est repoussée après création n'est
 * pas revérifié par cette règle.
 */
// Sprint technique 1 : export ajouté pour être réutilisée telle quelle par
// src/lib/location-chains.ts — une prolongation repousse la date de retour, la validité du
// permis jusqu'à cette nouvelle date doit donc être revérifiée (elle ne l'était, jusqu'ici, qu'à
// la création du contrat initial). Comportement inchangé pour tout appelant existant de ce
// fichier.
export function assertDriverLicenseCoversReturn(client: Client, endDate: Date): void {
  if (!client.licenseExpiryDate) {
    throw new MissingDriverLicenseExpiryError();
  }
  if (toUtcDateOnly(client.licenseExpiryDate) < toUtcDateOnly(endDate)) {
    throw new DriverLicenseExpiredError();
  }
}

/** Sprint 30 (DOMAINRULES.md section 45, point 7) — distingue le client principal du second
 * conducteur dans le message d'erreur, sans dupliquer les classes d'erreur. */
export type DriverRole = "client" | "secondDriver";

const MINIMUM_DRIVER_AGE = 21;

/**
 * Sprint 30 : âge réel du conducteur (Client.birthDate), distinct de l'ancienneté du permis
 * (assertDriverLicenseCoversReturn ci-dessus). S'applique au client principal ET au second
 * conducteur (Location.secondDriverId) — voir DOMAINRULES.md section 45.
 */
export class MissingDriverBirthDateError extends Error {
  role: DriverRole;
  constructor(role: DriverRole = "client") {
    super(
      role === "secondDriver"
        ? "La date de naissance du second conducteur n'est pas renseignée : impossible de vérifier " +
          `qu'il a l'âge minimum requis (${MINIMUM_DRIVER_AGE} ans). Complétez sa date de naissance avant ` +
          "de générer le contrat."
        : "La date de naissance du client n'est pas renseignée : impossible de vérifier qu'il a l'âge " +
          `minimum requis (${MINIMUM_DRIVER_AGE} ans) pour conduire. Complétez la date de naissance dans ` +
          "la fiche client avant de générer le contrat."
    );
    this.name = "MissingDriverBirthDateError";
    this.role = role;
  }
}

/** Sprint 30 — date de naissance future (postérieure à aujourd'hui) ou autrement incohérente :
 * distinct de DriverUnderMinimumAgeError ci-dessous, qui suppose une date par ailleurs valide. */
export class InvalidDriverBirthDateError extends Error {
  role: DriverRole;
  constructor(role: DriverRole = "client") {
    super(
      role === "secondDriver"
        ? "La date de naissance du second conducteur est invalide ou postérieure à la date du jour."
        : "La date de naissance du client est invalide ou postérieure à la date du jour."
    );
    this.name = "InvalidDriverBirthDateError";
    this.role = role;
  }
}

/**
 * Sprint 30 — âge réel du conducteur inférieur à 21 ans à la date de début du contrat
 * (Location.startDate, jour où il prend effectivement le volant) : un conducteur atteignant
 * exactement 21 ans ce jour-là est accepté (comparaison sur le jour calendaire UTC, voir
 * toUtcDateOnly/calculateAgeInYears).
 */
export class DriverUnderMinimumAgeError extends Error {
  role: DriverRole;
  constructor(role: DriverRole = "client") {
    super(
      role === "secondDriver"
        ? `Le second conducteur n'a pas encore ${MINIMUM_DRIVER_AGE} ans à la date de début du contrat : ` +
          "impossible de générer le contrat."
        : `Le client n'a pas encore ${MINIMUM_DRIVER_AGE} ans à la date de début du contrat : impossible ` +
          "de générer le contrat."
    );
    this.name = "DriverUnderMinimumAgeError";
    this.role = role;
  }
}

/** Sprint 30 — âge exact en années complètes à `referenceDate`, calcul calendaire (année/mois/
 * jour civils UTC) : jamais une approximation par division du nombre de jours (ex. /365.25),
 * pour rester correct autour des années bissextiles et donner un résultat exact au jour près. */
function calculateAgeInYears(birthDate: Date, referenceDate: Date): number {
  let age = referenceDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const monthDiff = referenceDate.getUTCMonth() - birthDate.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && referenceDate.getUTCDate() < birthDate.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/**
 * Sprint 30 (DOMAINRULES.md section 45, point 7) — appliquée au client principal (création
 * directe et conversion) et au second conducteur (conversion et PATCH /api/locations/[id]) :
 * voir les points d'application dans createLocationLocked/updateLocation ci-dessous. Toujours
 * comparée à `Location.startDate` (premier jour prévu de la location), jamais `endDate` ni la
 * date du jour — décision explicite, distincte de assertDriverLicenseCoversReturn (permis,
 * comparé à `endDate`).
 */
function assertClientMeetsMinimumAge(client: Client, startDate: Date, role: DriverRole): void {
  if (!client.birthDate) {
    throw new MissingDriverBirthDateError(role);
  }
  if (Number.isNaN(client.birthDate.getTime()) || toUtcDateOnly(client.birthDate) > toUtcDateOnly(new Date())) {
    throw new InvalidDriverBirthDateError(role);
  }
  if (calculateAgeInYears(client.birthDate, startDate) < MINIMUM_DRIVER_AGE) {
    throw new DriverUnderMinimumAgeError(role);
  }
}

/**
 * Sprint 28 (Finding E) : un véhicule MAINTENANCE/TRANSFERRING/ON_TRIP n'est pas disponible
 * pour une nouvelle Location, indépendamment de tout conflit de dates avec une Location
 * existante — jusqu'ici, checkAvailability (src/lib/vehicles.ts) ne vérifiait que les conflits
 * de dates entre Location, jamais Vehicle.status, laissant un véhicule en mobilité réservable
 * dès que ses dates ne chevauchaient aucune Location déjà enregistrée. Contrôle strict, sans
 * exception ADMIN (voir assertVehicleStatusAllowsLocation ci-dessous) : distinct de
 * LocationLockedError, qu'un ADMIN peut contourner via adminOverride (DOMAINRULES.md
 * section 37) — la disponibilité réelle du véhicule n'est jamais un choix éditorial.
 */
export class VehicleUnavailableForLocationError extends Error {
  vehicleStatus: VehicleStatus;

  constructor(vehicleStatus: VehicleStatus) {
    super(`Le véhicule n'est pas disponible pour une location (statut actuel : ${vehicleStatus}).`);
    this.name = "VehicleUnavailableForLocationError";
    this.vehicleStatus = vehicleStatus;
  }
}

// INACTIVE retiré (sprint "statut opérationnel automatique", 2026-08-28) : l'ancienne
// immobilisation permanente manuelle n'est plus une valeur de VehicleStatus (retirée de l'enum,
// voir prisma/schema.prisma) — remplacée par l'état administratif séparé
// Vehicle.deactivatedAt, vérifié indépendamment ci-dessous via assertVehicleNotDeactivated.
// RENTED reste délibérément absent de cette liste — un véhicule loué reste réservable pour une
// période future non chevauchante, vérifié par checkAvailability.
const VEHICLE_STATUSES_BLOCKING_LOCATION: VehicleStatus[] = ["MAINTENANCE", "TRANSFERRING", "ON_TRIP"];

/**
 * Appliqué immédiatement après lockVehicleForUpdate — création (toujours) et modification
 * (uniquement quand les dates changent, seul cas où le véhicule est aujourd'hui reverrouillé/
 * revérifié, voir updateLocation). Ne s'applique jamais rétroactivement à une Location déjà
 * créée dont le véhicule change de statut ensuite (aucune fonction ne parcourt les Location
 * existantes pour les annuler/suspendre) — comportement délibéré, DOMAINRULES.md section 30.
 * Inclut désormais aussi le contrôle de désactivation administrative (sprint "statut
 * opérationnel automatique", 2026-08-28) — même sévérité, sans exception ADMIN.
 */
// Sprint technique 1 (DOMAINRULES.md section 60) : export ajouté pour être réutilisée telle
// quelle par src/lib/location-chains.ts (changement de véhicule lors d'une prolongation) —
// aucun changement de comportement pour les appelants existants de ce fichier.
export function assertVehicleStatusAllowsLocation(vehicle: Vehicle): void {
  assertVehicleNotDeactivated(vehicle);
  if (VEHICLE_STATUSES_BLOCKING_LOCATION.includes(vehicle.status)) {
    throw new VehicleUnavailableForLocationError(vehicle.status);
  }
}

export class VehicleNotAvailableError extends Error {
  conflictingLocations: Pick<Location, "id" | "startDate" | "endDate" | "status">[];

  constructor(conflictingLocations: Pick<Location, "id" | "startDate" | "endDate" | "status">[]) {
    super("Le véhicule n'est pas disponible sur cette période.");
    this.name = "VehicleNotAvailableError";
    this.conflictingLocations = conflictingLocations;
  }
}

type ConflictingMaintenance = Pick<Maintenance, "id" | "scheduledDate" | "scheduledEndDate" | "status" | "type">;

/**
 * Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 2) : blocage strict, sans exception ADMIN
 * — même philosophie que VehicleUnavailableForLocationError (Finding E, Sprint 28) : une nouvelle
 * location (ou la modification d'un contrat encore PENDING, jamais confirmé) ne peut jamais
 * chevaucher une maintenance planifiée/en cours. Distincte de MaintenanceExtensionConflictError
 * ci-dessous, qui ne s'applique qu'à la prolongation d'un contrat déjà validé (règle 3).
 */
export class VehicleMaintenanceConflictError extends Error {
  conflictingMaintenances: ConflictingMaintenance[];

  constructor(conflictingMaintenances: ConflictingMaintenance[]) {
    super("Le véhicule a une maintenance planifiée qui chevauche cette période.");
    this.name = "VehicleMaintenanceConflictError";
    this.conflictingMaintenances = conflictingMaintenances;
  }
}

/**
 * Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 3) : contrairement à
 * VehicleMaintenanceConflictError ci-dessus, ceci n'est PAS un blocage définitif — une
 * prolongation d'un contrat déjà validé (CONFIRMED/ACTIVE) qui chevauche une maintenance
 * planifiée déclenche une alerte explicite plutôt qu'un refus systématique (brief Sprint 34
 * étape 3) : levée une première fois pour informer, contournable uniquement par un appel
 * explicite avec `confirmMaintenanceConflict: true`, réservé à `locations.maintenance_conflict.
 * override` (vérifié côté route, jamais ici — ce module ne connaît pas les permissions). La
 * maintenance elle-même n'est jamais déplacée/modifiée par ce contournement.
 */
export class MaintenanceExtensionConflictError extends Error {
  conflictingMaintenances: ConflictingMaintenance[];

  constructor(conflictingMaintenances: ConflictingMaintenance[]) {
    super(
      "Cette prolongation chevauche une maintenance planifiée pour ce véhicule. Confirmez " +
        "explicitement pour prolonger malgré ce chevauchement (la maintenance ne sera jamais " +
        "déplacée automatiquement), ou choisissez d'autres dates."
    );
    this.name = "MaintenanceExtensionConflictError";
    this.conflictingMaintenances = conflictingMaintenances;
  }
}

/**
 * Sprint technique 3 (DOMAINRULES.md section 60, règle 11) : l'ancien parcours dédié
 * « Prolonger la location » (`UpdateLocationInput.extendReturnDate`, introduit Sprint 13E
 * tâche 2) est retiré du parcours utilisateur — `createLocationExtension`
 * (`src/lib/location-chains.ts`, `POST /api/locations/[id]/extend`) est désormais l'unique
 * mécanisme officiel de prolongation. Ce champ reste reconnu côté serveur (compatibilité d'un
 * ancien client/appel direct) mais ne réussit plus jamais, quel que soit l'état du contrat, la
 * permission de l'appelant, ou tout autre champ du corps de requête (voir updateLocation
 * ci-dessous : vérifié en tout premier, avant toute autre logique — aucune écriture possible).
 */
export class LocationExtensionMechanismRemovedError extends Error {
  constructor() {
    super(
      "Ce mécanisme de prolongation a été retiré. Créez une nouvelle prolongation via " +
        "POST /api/locations/[id]/extend (voir DOMAINRULES.md section 60)."
    );
    this.name = "LocationExtensionMechanismRemovedError";
  }
}

/**
 * Sprint technique 3 (DOMAINRULES.md section 60, règle 11) : une fois une chaîne de
 * prolongations créée (`createLocationExtension`), la contiguïté entre deux contrats liés
 * (`child.startDate === parent.endDate`, garantie par construction à la création — voir
 * `src/lib/location-chains.ts`) ne doit plus jamais pouvoir être rompue par ce PATCH générique.
 * Contrairement à `LocationLockedError`, ce verrou n'est **jamais** contournable — ni par
 * `adminOverride` ni par `confirmMaintenanceConflict` — même principe de conception que le refus
 * d'une transition `CANCELLED` sur un contrat déjà validé via ce même PATCH (voir
 * `LocationCancellationRequiresAdminError` ci-dessus) : une action structurellement sensible à
 * l'intégrité d'une donnée liée (ici, une autre `Location` de la même chaîne) est réservée à un
 * mécanisme qui la connaît, jamais à cette route générique. Bug identifié et corrigé Sprint
 * technique 3 : avant ce correctif, `adminOverride`/`extendReturnDate` pouvaient repousser
 * `endDate` d'un contrat parent au-delà de `startDate` de son enfant (silencieusement si le
 * véhicule différait entre les deux, `checkAvailability` ne portant que sur un même véhicule).
 */
export class LocationHasExtensionChainError extends Error {
  constructor() {
    super(
      "Ce contrat fait partie d'une chaîne de prolongations : ses dates ne sont plus modifiables " +
        "directement (la contiguïté avec le contrat lié serait rompue). Créez une nouvelle " +
        "prolongation (POST /api/locations/[id]/extend) pour prolonger la chaîne."
    );
    this.name = "LocationHasExtensionChainError";
  }
}

export class InvalidStatusTransitionError extends Error {
  constructor(from: LocationStatus, to: LocationStatus) {
    super(`Transition de statut invalide : ${from} → ${to}.`);
    this.name = "InvalidStatusTransitionError";
  }
}

export class LocationNotDeletableError extends Error {
  constructor() {
    super("Seule une location PENDING ou CANCELLED peut être supprimée ; sinon, annulez-la (status).");
    this.name = "LocationNotDeletableError";
  }
}

export class LocationHasInvoiceError extends Error {
  constructor() {
    super(
      "Cette location a une facture ISSUED/PARTIALLY_PAID/PAID, un paiement enregistré, ou un dégât " +
        "déclaré ; annulez/supprimez la facture (voir DELETE /api/invoices/[id]) ou traitez le(s) " +
        "dégât(s) avant de supprimer la location."
    );
    this.name = "LocationHasInvoiceError";
  }
}

export class MissingPriceError extends Error {
  constructor() {
    super(
      "Aucun prix/jour n'est disponible : le véhicule n'a pas de prix informatif et aucun " +
        "pricePerDay n'a été fourni pour cette location (voir DOMAINRULES.md section 5/7)."
    );
    this.name = "MissingPriceError";
  }
}

export class LocationLockedError extends Error {
  constructor() {
    super(
      "Ce contrat est verrouillé : les dates ne sont plus modifiables une fois la location " +
        "confirmée. Seuls le statut, le kilométrage de retour, la caution et les notes restent éditables."
    );
    this.name = "LocationLockedError";
  }
}

/**
 * Sprint 23 (DOMAINRULES.md section 39) : un contrat encore PENDING (brouillon jamais
 * confirmé) reste annulable par tout titulaire de locations.edit, comme avant ce sprint —
 * mais annuler un contrat déjà validé (CONFIRMED/ACTIVE/COMPLETED) est désormais réservé à un
 * ADMIN (voir adminOverride, déjà dérivé de user.role côté route, DOMAINRULES.md section 37).
 * Pour une annulation avec réversibilité financière complète (factures/caisse), voir
 * adminCancelValidatedLocation ci-dessous plutôt que cette transition simple.
 */
export class LocationCancellationRequiresAdminError extends Error {
  constructor() {
    super(
      "Seul un administrateur peut annuler un contrat déjà validé (voir POST /api/locations/[id]/admin-cancel)."
    );
    this.name = "LocationCancellationRequiresAdminError";
  }
}

/**
 * Sprint 23, révisée Sprint 31A (DOMAINRULES.md section 43) : garde de concurrence sur la
 * transition de statut (voir updateLocation) — déclenchée soit par le verrou de ligne posé en
 * tout début de transaction (l'état a changé entre la lecture hors transaction et l'écriture),
 * soit par l'`updateMany` conditionné conservé en défense en profondeur.
 */
export class LocationStatusConflictError extends Error {
  constructor() {
    super(
      "Cette opération n'a pas été appliquée. La location a déjà été modifiée par un autre utilisateur. Actualisez la page puis réessayez."
    );
    this.name = "LocationStatusConflictError";
  }
}

/** Sprint 23 — même validation que VehicleTransfer/VehicleTrip (src/lib/vehicle-transfers.ts),
 * dupliquée localement pour éviter une dépendance croisée entre modules indépendants. */
export class InvalidFuelLevelError extends Error {
  constructor() {
    super("Le niveau de carburant doit être un entier entre 0 et 100 (pourcentage).");
    this.name = "InvalidFuelLevelError";
  }
}

function validateFuelLevel(value: number | null | undefined): void {
  if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 0 || value > 100)) {
    throw new InvalidFuelLevelError();
  }
}

/**
 * BUG-005 (INCIDENTS.md) : le flux dédié de retour (POST /api/locations/[id]/return, voir
 * assertValidOdometer dans src/lib/location-return.ts) rejetait déjà un kilométrage de retour
 * inférieur ou égal au départ, mais updateLocation() ci-dessous — utilisé par le PATCH
 * générique, seul chemin disponible pour l'agence de RETOUR sans accès à l'agence de départ
 * (voir canAccessLocationAgency, src/lib/authz.ts) — acceptait endOdometer sans aucune
 * comparaison. Même règle, dupliquée ici plutôt qu'importée de location-return.ts : ce module
 * dépend transitivement de src/lib/locations.ts (via src/lib/invoices.ts), l'importer créerait
 * un cycle — même raisonnement que InvalidFuelLevelError/validateFuelLevel ci-dessus. */
export class InvalidReturnOdometerError extends Error {
  constructor() {
    super("Le kilométrage de retour doit être un entier strictement supérieur au kilométrage de départ.");
    this.name = "InvalidReturnOdometerError";
  }
}

function assertValidReturnOdometer(endOdometer: number, startOdometer: number | null): void {
  if (!Number.isInteger(endOdometer)) {
    throw new InvalidReturnOdometerError();
  }
  if (startOdometer !== null) {
    if (endOdometer <= startOdometer) {
      throw new InvalidReturnOdometerError();
    }
    return;
  }
  // Aucun kilométrage de départ connu (optionnel à la création, DOMAINRULES.md section 5) :
  // rien à comparer — un entier positif ou nul reste néanmoins exigé.
  if (endOdometer < 0) {
    throw new InvalidReturnOdometerError();
  }
}

/**
 * Machine à états explicite (ARCHITECTURE.md section 12) : aucune transition non listée
 * n'est autorisée. COMPLETED et CANCELLED sont des états terminaux.
 */
const ALLOWED_TRANSITIONS: Record<LocationStatus, LocationStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: LocationStatus, to: LocationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function calculateTotalPrice(pricePerDay: number, start: Date, end: Date): number {
  return pricePerDay * calculateDaysCount(start, end);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Génère le prochain numéro de contrat séquentiel pour l'agence : "{prefix}-{5 chiffres}"
 * (ou juste "{5 chiffres}" si aucun préfixe n'est configuré). Contrairement à la numérotation
 * des factures (générée par COUNT(), src/lib/invoices.ts), le compteur est un champ persisté
 * (Agency.lastContractNumber, Sprint 15 — déplacé depuis Tenant : chaque agence a son propre
 * préfixe et sa propre séquence indépendante, DOMAINRULES.md section 29) incrémenté
 * atomiquement (UPDATE ... SET n = n + 1 côté Postgres, donc sans condition de course même
 * sous forte concurrence) — nécessaire pour permettre de le redéfinir manuellement depuis les
 * paramètres de l'agence.
 *
 * `tx` optionnel (Sprint 26A, Finding A) — comportement inchangé pour tout appel sans
 * transaction partagée.
 */
export async function generateContractNumber(
  agencyId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<string> {
  const agency = await tx.agency.update({
    where: { id: agencyId },
    data: { lastContractNumber: { increment: 1 } },
    select: { lastContractNumber: true, contractNumberPrefix: true },
  });
  const padded = String(agency.lastContractNumber).padStart(5, "0");
  return agency.contractNumberPrefix ? `${agency.contractNumberPrefix}-${padded}` : padded;
}

export interface LocationFilters {
  vehicleId?: string;
  clientId?: string;
  /** Filtre explicite sur une agence précise (ex. paramètre `agencyId` de l'URL) — l'appelant
   * a déjà validé l'accès à cette agence (canAccessAgency) avant de la passer ici. Prioritaire
   * sur `accessibleAgencyIds` : un filtre explicite est plus spécifique qu'une portée générale. */
  agencyId?: string;
  /** Restreint aux locations visibles par l'appelant — agence de départ OU de retour, voir
   * locationAgencyScopeWhere ci-dessous. `null` = ADMIN, aucune restriction ;
   * `undefined` = non fourni, ignoré (voir `agencyId` ci-dessus si un filtre explicite est
   * fourni à la place). Ignoré si `agencyId` est fourni. */
  accessibleAgencyIds?: string[] | null;
  status?: LocationStatus;
  from?: Date;
  to?: Date;
}

export async function getLocations(tenantId: string, filters: LocationFilters = {}): Promise<Location[]> {
  return prisma.location.findMany({
    where: {
      tenantId,
      ...(filters.vehicleId ? { vehicleId: filters.vehicleId } : {}),
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.agencyId
        ? { agencyId: filters.agencyId }
        : filters.accessibleAgencyIds !== undefined
          ? locationAgencyScopeWhere(filters.accessibleAgencyIds)
          : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.from ? { endDate: { gte: filters.from } } : {}),
      ...(filters.to ? { startDate: { lte: filters.to } } : {}),
    },
    orderBy: { startDate: "desc" },
  });
}

/** `tx` optionnel (Sprint 26A, Finding A) — voir le commentaire équivalent sur
 * `getReservationById`, src/lib/reservations.ts. */
export async function getLocationById(
  tenantId: string,
  locationId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<Location | null> {
  return tx.location.findFirst({ where: { id: locationId, tenantId } });
}

export interface ContractOverviewRow {
  id: string;
  contractNumber: string | null;
  clientName: string;
  /** Résolue depuis la Reservation dont convertedLocationId pointe vers ce contrat (Sprint 23,
   * DOMAINRULES.md section 39) — null si le contrat a été créé directement, sans réservation. */
  source: string | null;
  startDate: Date;
  endDate: Date;
  make: string;
  licensePlate: string;
  startOdometer: number | null;
  endOdometer: number | null;
  startFuelLevel: number | null;
  endFuelLevel: number | null;
  totalPrice: number;
  currency: string;
  status: LocationStatus;
}

/**
 * Onglet « Listing contrats » (Sprint 23, DOMAINRULES.md section 39) — basé uniquement sur les
 * contrats réels (`Location`), décision confirmée explicitement avec le propriétaire du projet :
 * une réservation No Show/annulée qui n'a jamais généré de contrat n'apparaît jamais ici (aucune
 * `Location` n'existe pour elle). `source` (broker/direct) est résolue en cherchant la
 * `Reservation` dont `convertedLocationId` pointe vers chaque contrat (requête batch, une seule
 * fois pour toute la page) — vide si le contrat a été créé directement, sans réservation.
 * `agencyIds` restreint aux agences accessibles à l'appelant (départ **ou** retour, même
 * principe que `canAccessLocationAgency`, `src/lib/authz.ts`) ; `null` = ADMIN, aucune
 * restriction.
 */
export async function getContractsOverview(
  tenantId: string,
  filters: { agencyIds?: string[] | null; status?: LocationStatus; contractNumber?: string } = {}
): Promise<ContractOverviewRow[]> {
  const locations = await prisma.location.findMany({
    where: {
      tenantId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.agencyIds !== undefined ? locationAgencyScopeWhere(filters.agencyIds) : {}),
      // Recherche exacte/partielle, insensible à la casse (ex. "00004" ou "RAK-00004") — le
      // contrôle de longueur/espaces a déjà eu lieu côté route avant l'appel (voir
      // MAX_CONTRACT_NUMBER_SEARCH_LENGTH, src/app/api/locations/route.ts).
      ...(filters.contractNumber ? { contractNumber: { contains: filters.contractNumber, mode: "insensitive" } } : {}),
    },
    include: {
      vehicle: { select: { make: true, licensePlate: true } },
      client: { select: { name: true } },
    },
    orderBy: { startDate: "desc" },
  });

  const reservations = await prisma.reservation.findMany({
    where: { tenantId, convertedLocationId: { in: locations.map((location) => location.id) } },
    select: { convertedLocationId: true, source: true },
  });
  const sourceByLocationId = new Map(
    reservations
      .filter((reservation) => reservation.convertedLocationId !== null)
      .map((reservation) => [reservation.convertedLocationId as string, reservation.source])
  );

  return locations.map((location) => ({
    id: location.id,
    contractNumber: location.contractNumber,
    clientName: location.client.name,
    source: sourceByLocationId.get(location.id) ?? null,
    startDate: location.startDate,
    endDate: location.endDate,
    make: location.vehicle.make,
    licensePlate: location.vehicle.licensePlate,
    startOdometer: location.startOdometer,
    endOdometer: location.endOdometer,
    startFuelLevel: location.startFuelLevel,
    endFuelLevel: location.endFuelLevel,
    totalPrice: location.totalPrice,
    currency: location.currency,
    status: location.status,
  }));
}

export interface CreateLocationInput {
  tenantId: string;
  agencyId: string;
  /** Sprint 19 — agence de retour, si distincte de `agencyId` (dérivée de
   * reservation.dropoffAgencyId à la conversion, voir POST /api/reservations/[id]/convert) :
   * permet à l'agence d'arrivée de voir/gérer la réception sans accès à `agencyId`, voir
   * canAccessLocationAgency (src/lib/authz.ts) et le widget "Retours" du dashboard. */
  dropoffAgencyId?: string | null;
  vehicleId: string;
  clientId: string;
  /** Sprint 19 — second conducteur (réutilise Client, voir SecondDriverNotFoundError). */
  secondDriverId?: string | null;
  startDate: Date;
  endDate: Date;
  status?: LocationStatus;
  notes?: string;
  startOdometer?: number;
  endOdometer?: number;
  /** Sprint 23 — jauge de carburant départ/retour du contrat (0-100), voir Location.startFuelLevel/
   * endFuelLevel dans prisma/schema.prisma. */
  startFuelLevel?: number;
  endFuelLevel?: number;
  deposit?: number;
  /** Prix/jour réel de cette location (centimes), saisi à la réservation/au contrat — source
   * de vérité de la facturation (Sprint 14A, DOMAINRULES.md section 5/7). Si absent, retombe
   * sur `vehicle.pricePerDay` (valeur informative) ; si ni l'un ni l'autre n'est disponible,
   * `MissingPriceError` est levée plutôt que de créer une location à prix 0/indéfini. */
  pricePerDay?: number;
  /** Sprint 19 — montant total explicite (centimes), prioritaire sur le calcul pricePerDay ×
   * jours (calculateTotalPrice) : permet à la conversion d'une réservation de reprendre le
   * vrai montant négocié (reservation.totalPrice + options) plutôt qu'un recalcul silencieux
   * qui ignorait jusqu'ici toute remise ou option (GPS/siège bébé/conducteur suppl.). */
  totalPrice?: number;
}

/** Sprint 26C, Finding C : noms de savepoint fixes (jamais construits à partir d'une valeur
 * utilisateur/requête) — un par tentative de génération de numéro de contrat, voir
 * `createLocationLocked` ci-dessous. Un identifiant SQL (contrairement à une valeur) ne peut
 * pas être lié via un paramètre `$1` ; ces littéraux fixes, énumérés au nombre exact de
 * `MAX_CONTRACT_NUMBER_ATTEMPTS`, sont la façon sûre d'obtenir un SAVEPOINT distinct par
 * tentative sans jamais concaténer de donnée externe dans le SQL. */
const CONTRACT_NUMBER_SAVEPOINTS = [
  "location_contract_sp_0",
  "location_contract_sp_1",
  "location_contract_sp_2",
  "location_contract_sp_3",
  "location_contract_sp_4",
] as const;
const MAX_CONTRACT_NUMBER_ATTEMPTS = CONTRACT_NUMBER_SAVEPOINTS.length;

/** Sprint 26C, Finding C : au-delà du code `P2002` générique (`isUniqueConstraintError`),
 * vérifie que la contrainte violée est bien `[tenantId, contractNumber]` — la seule contrainte
 * unique de `Location` (voir prisma/schema.prisma) — avant de la traiter comme une collision de
 * numéro de contrat à réessayer. Toute autre erreur (y compris un autre `P2002` improbable)
 * n'est jamais réinterprétée comme une simple collision : elle se propage telle quelle. */
// Sprint technique 1 : export ajouté pour être réutilisée telle quelle par
// src/lib/location-chains.ts (même réessai de numérotation, même contrainte unique visée).
export function isContractNumberCollision(error: unknown): boolean {
  if (!isUniqueConstraintError(error)) {
    return false;
  }
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) {
    return target.includes("contractNumber");
  }
  if (typeof target === "string") {
    return target.includes("contractNumber");
  }
  // Repli conservateur si Prisma ne renseigne pas meta.target (comportement historique,
  // P2002 seul suffisait) — Location n'ayant qu'une seule contrainte unique, ce cas ne peut de
  // toute façon désigner qu'elle.
  return true;
}

/**
 * Vérifie la disponibilité du véhicule et calcule totalPrice à partir du pricePerDay effectif
 * (fourni explicitement, sinon celui — informatif — du véhicule) au moment de la création
 * (snapshot immuable : un changement ultérieur du tarif du véhicule ne doit pas modifier
 * rétroactivement une location existante).
 *
 * `tx` optionnel (Sprint 26A, Finding A) — défaut au client Prisma global, comportement
 * inchangé pour tout appel sans transaction partagée (ex. POST /api/locations) : ouvre alors sa
 * propre transaction interne (voir `createLocationLocked` ci-dessous), même principe que
 * `createPayment` (Sprint 26B, Finding B, src/lib/payments.ts). Avec une `tx` fournie par
 * l'appelant (ex. POST /api/reservations/[id]/convert, transaction partagée du Finding A),
 * aucune transaction n'est ouverte ici : le verrou Vehicle (Finding C) est posé dans la
 * transaction de l'appelant, sans imbrication.
 */
export async function createLocation(
  data: CreateLocationInput,
  tx: Prisma.TransactionClient = prisma
): Promise<Location> {
  if (data.endDate <= data.startDate) {
    throw new InvalidDateRangeError();
  }
  assertValidLocationNotes(data.notes);

  if (tx !== prisma) {
    return createLocationLocked(data, tx);
  }
  return prisma.$transaction((innerTx) => createLocationLocked(data, innerTx));
}

/**
 * Sprint 26C, Finding C : verrou explicite du Vehicle ciblé (`lockVehicleForUpdate`,
 * src/lib/vehicles.ts, `SELECT ... FOR UPDATE`) posé avant `checkAvailability`, dans la même
 * transaction que la création de la Location — une deuxième création/conversion concurrente sur
 * le même véhicule attend ici le commit (ou rollback) de la première avant de relire une
 * disponibilité à jour, au lieu de lire (comme avant ce sprint) un instantané potentiellement
 * périmé pendant que l'autre écrit encore.
 */
async function createLocationLocked(data: CreateLocationInput, tx: Prisma.TransactionClient): Promise<Location> {
  const vehicle = await lockVehicleForUpdate(data.tenantId, data.vehicleId, tx);
  if (!vehicle) {
    throw new VehicleNotFoundError();
  }
  assertVehicleStatusAllowsLocation(vehicle);

  // Correctif (revue OWASP Phase 6, 2026-08-31) : l'agence du contrat est dérivée du véhicule
  // fraîchement verrouillé ci-dessus, jamais de l'instantané `data.agencyId` lu par l'appelant
  // AVANT l'ouverture de cette transaction (POST /api/locations, POST
  // /api/reservations/[id]/convert lisent tous deux le véhicule et vérifient l'accès à son
  // agence, PUIS entrent dans cette transaction — un transfert de véhicule concurrent peut avoir
  // changé Vehicle.agencyId entre ces deux instants). Sans cette correction, `Location.agencyId`
  // pouvait diverger du `Vehicle.agencyId` réel après commit (numérotation de contrat par
  // agence ci-dessous, écritures de caisse dérivées de `location.agencyId`, et visibilité
  // agence-scopée pour un MEMBER restreint devenaient alors incohérentes) — les deux appelants
  // documentent déjà l'intention ("l'agence du contrat est dérivée du véhicule choisi côté
  // serveur, jamais d'un champ agencyId fourni par le client") : cette correction la rend
  // effective même sous concurrence, sans changer la signature ni le comportement d'aucun
  // appelant (leur propre vérification `canAccessAgency` pré-transaction reste inchangée,
  // défense en profondeur existante — voir POST /api/locations et
  // POST /api/reservations/[id]/convert).
  const agencyId = vehicle.agencyId;

  const client = await getClientById(data.tenantId, data.clientId, tx);
  if (!client) {
    throw new ClientNotFoundError();
  }
  assertDriverLicenseCoversReturn(client, data.endDate);
  assertClientMeetsMinimumAge(client, data.startDate, "client");

  if (data.secondDriverId) {
    const secondDriver = await getClientById(data.tenantId, data.secondDriverId, tx);
    if (!secondDriver) {
      throw new SecondDriverNotFoundError();
    }
    assertClientMeetsMinimumAge(secondDriver, data.startDate, "secondDriver");
  }

  validateFuelLevel(data.startFuelLevel);
  validateFuelLevel(data.endFuelLevel);

  const availability = await checkAvailability(
    data.tenantId,
    data.vehicleId,
    data.startDate,
    data.endDate,
    undefined,
    tx
  );
  if (!availability?.available) {
    throw new VehicleNotAvailableError(availability?.conflictingLocations ?? []);
  }

  // Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 1/2) : une nouvelle location ne peut
  // jamais chevaucher une maintenance planifiée/en cours — blocage strict, sans exception ADMIN,
  // même raisonnement que VehicleUnavailableForLocationError ci-dessus.
  const conflictingMaintenances = await findConflictingMaintenances(
    data.vehicleId,
    data.startDate,
    data.endDate,
    undefined,
    tx
  );
  if (conflictingMaintenances.length > 0) {
    throw new VehicleMaintenanceConflictError(conflictingMaintenances);
  }

  const pricePerDay = data.pricePerDay ?? vehicle.pricePerDay ?? undefined;
  if (pricePerDay === undefined) {
    throw new MissingPriceError();
  }

  const totalPrice = data.totalPrice ?? calculateTotalPrice(pricePerDay, data.startDate, data.endDate);

  // Sprint 26C, Finding C : la création s'exécute désormais toujours à l'intérieur d'une
  // transaction (partagée ou ouverte ci-dessus, voir createLocation) — un réessai naïf sur
  // collision y aurait avorté toute la transaction dès la première erreur de contrainte
  // (limite déjà documentée pour l'appel partagé du Finding A). Un SAVEPOINT distinct par
  // tentative (voir CONTRACT_NUMBER_SAVEPOINTS ci-dessus) isole chaque essai : une collision
  // (isContractNumberCollision) annule uniquement la tentative en cours via
  // `ROLLBACK TO SAVEPOINT`, jamais la transaction principale (aucun `COMMIT`/`ROLLBACK`
  // exécuté ici) — comportement des 5 tentatives strictement inchangé pour l'appelant.
  for (let attempt = 0; attempt < MAX_CONTRACT_NUMBER_ATTEMPTS; attempt++) {
    const contractNumber = await generateContractNumber(agencyId, tx);
    const savepoint = CONTRACT_NUMBER_SAVEPOINTS[attempt];
    await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
    try {
      const location = await tx.location.create({
        data: {
          tenantId: data.tenantId,
          agencyId,
          dropoffAgencyId: data.dropoffAgencyId && data.dropoffAgencyId !== agencyId ? data.dropoffAgencyId : null,
          vehicleId: data.vehicleId,
          clientId: data.clientId,
          secondDriverId: data.secondDriverId ?? null,
          startDate: data.startDate,
          endDate: data.endDate,
          status: data.status ?? "PENDING",
          pricePerDay,
          currency: vehicle.currency,
          totalPrice,
          notes: data.notes,
          startOdometer: data.startOdometer,
          endOdometer: data.endOdometer,
          startFuelLevel: data.startFuelLevel,
          endFuelLevel: data.endFuelLevel,
          deposit: data.deposit,
          contractNumber,
        },
      });
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      // Sprint technique 1 (DOMAINRULES.md section 60) : un contrat INITIAL est sa propre racine
      // de chaîne (rootLocationId auto-référencé) — id inconnu avant l'INSERT ci-dessus, donc
      // renseigné par un second appel dans la même transaction plutôt qu'à la création (même
      // principe que le SAVEPOINT ci-dessus : aucune écriture hors de cette transaction). Ne
      // change rien pour un appelant existant au-delà de ce champ supplémentaire.
      const finalLocation = await tx.location.update({
        where: { id: location.id },
        data: { rootLocationId: location.id },
      });
      // Sprint "statut opérationnel automatique" (2026-08-28) : une Location créée directement
      // ACTIVE (rare — la plupart démarrent PENDING/CONFIRMED) doit immédiatement faire passer
      // le véhicule à RENTED.
      if (finalLocation.status === "ACTIVE") {
        await syncVehicleStatus(vehicle.id, tx);
      }
      return finalLocation;
    } catch (error) {
      // Toute erreur qui n'est pas précisément une collision de numéro de contrat se propage
      // telle quelle, sans y toucher : la transaction principale (partagée ou non) sera
      // intégralement annulée par Prisma à la sortie de ce bloc, comme n'importe quelle autre
      // erreur de ce flux (rollback complet garanti par $transaction, aucune Location partielle).
      if (!isContractNumberCollision(error)) {
        throw error;
      }
      // Collision possible uniquement si lastContractNumber a été redéfini manuellement en
      // arrière depuis les paramètres (voir generateContractNumber) — jamais en usage normal
      // (compteur toujours strictement croissant). Réessaie avec le numéro suivant plutôt que
      // d'échouer, même principe que generateInvoiceNumber (src/lib/invoices.ts).
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      if (attempt === MAX_CONTRACT_NUMBER_ATTEMPTS - 1) {
        throw error;
      }
    }
  }

  throw new Error("Impossible de générer un numéro de contrat unique.");
}

export interface UpdateLocationInput {
  startDate?: Date;
  endDate?: Date;
  status?: LocationStatus;
  notes?: string;
  startOdometer?: number | null;
  endOdometer?: number | null;
  /** Sprint 23 — jauge de carburant départ/retour (0-100). */
  startFuelLevel?: number | null;
  endFuelLevel?: number | null;
  deposit?: number | null;
  /** Sprint 19 — second conducteur, ajoutable/modifiable à tout statut (n'affecte ni dates ni
   * prix, jamais verrouillé par LocationLockedError). `null` retire le second conducteur. */
  secondDriverId?: string | null;
  /** Sprint 19 — bascule ADMIN uniquement (voir PATCH /api/locations/[id]) : contourne
   * canTransition/LocationLockedError. Jamais un champ de corps de requête — toujours dérivé
   * côté serveur de user.role, voir DOMAINRULES.md section 37. */
  adminOverride?: boolean;
  /** Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 3) — décision explicite de prolonger
   * malgré un chevauchement avec une maintenance planifiée, sur un contrat déjà validé
   * uniquement (PENDING reste soumis au blocage strict, comme une création). Honoré seulement
   * si la route l'a déjà vérifié contre `locations.maintenance_conflict.override` — jamais une
   * simple valeur de corps de requête faisant foi d'elle-même pour l'autorisation, seulement
   * pour l'intention explicite de l'utilisateur (même distinction que adminOverride ci-dessus,
   * qui dérive lui de user.role plutôt que du corps de requête — ici la permission est
   * granulaire, pas liée au rôle, donc vérifiée côté route puis transmise). Contourne aussi
   * LocationLockedError (voir plus bas) — sans quoi un utilisateur non-ADMIN titulaire de cette
   * permission ne pourrait jamais atteindre une "prolongation" (par définition une modification
   * de dates sur un contrat déjà validé, donc déjà verrouillé) ; ne contourne jamais la garde de
   * transition de statut, distincte d'adminOverride sur ce point précis. */
  confirmMaintenanceConflict?: boolean;
  /** Sprint technique 3 (DOMAINRULES.md section 60, règle 11) : ancien parcours « Prolonger la
   * location » (Sprint 13E tâche 2), **retiré** — ce champ n'est plus reconnu que pour rejeter
   * explicitement toute requête qui le porte encore (voir LocationExtensionMechanismRemovedError
   * ci-dessus), jamais pour modifier quoi que ce soit. `createLocationExtension`
   * (`src/lib/location-chains.ts`) est l'unique mécanisme officiel de prolongation. */
  extendReturnDate?: boolean;
}

/**
 * Sprint 31A (DOMAINRULES.md section 43) : verrou de ligne sur la `Location` elle-même, même
 * primitive que `lockVehicleForUpdate` (src/lib/vehicles.ts) — posé en tout début de la
 * transaction d'`updateLocation` pour donner à toutes les gardes dépendant du statut (admin-cancel,
 * validité de transition) une vue à jour et stable, avant toute décision.
 */
/**
 * Sprint 13E tâche 3 : exportée (auparavant privée à ce module) pour être réutilisée par
 * getOrCreateMainInvoice (src/lib/invoices.ts) — invoices.ts importe déjà getLocationById depuis
 * ce module (aucun cycle : locations.ts n'importe rien depuis invoices.ts). Comportement
 * strictement inchangé.
 */
export async function lockLocationForUpdate(
  tenantId: string,
  locationId: string,
  tx: Prisma.TransactionClient
): Promise<{ id: string; status: LocationStatus } | null> {
  const locked = await tx.$queryRaw<{ id: string; status: LocationStatus }[]>`
    SELECT id, status FROM "Location" WHERE id = ${locationId} AND "tenantId" = ${tenantId} FOR UPDATE
  `;
  return locked[0] ?? null;
}

/** Sprint 13E tâche 2 (DOMAINRULES.md section 52) — dupliqué localement depuis
 * computeInvoiceTotals (src/lib/invoices.ts), même raisonnement que InvalidFuelLevelError/
 * validateFuelLevel ci-dessus : invoices.ts importe déjà getLocationById depuis ce module, un
 * import inverse créerait un cycle. */
const INVOICE_TAX_RATE_BASIS = 10_000;

/**
 * Resynchronise le sous-total/TVA/total de la facture RENTAL d'une location avec son nouveau
 * `totalPrice`, uniquement si elle est encore DRAFT — un simple sous-produit de la création du
 * contrat (voir le commentaire équivalent sur deleteLocation ci-dessous), jamais encore envoyé.
 * Une facture DRAFT ne peut structurellement avoir aucun Payment (InvoiceNotFinalizedError,
 * src/lib/payments.ts) : aucun solde encaissé à préserver, la resynchronisation est donc
 * toujours sûre. Une facture ISSUED/PARTIALLY_PAID/PAID/VOID n'est jamais modifiée ici
 * (verrouillée — InvoiceNotEditableError, src/lib/invoices.ts) : une prolongation sur un
 * contrat dont la facture a déjà été envoyée laisse volontairement la facture existante
 * inchangée (voir DOMAINRULES.md section 52 pour la limite documentée plutôt qu'inventée).
 *
 * Sprint 13E tâche 3, sous-phase 2b : filtre explicitement `type: "RENTAL"` — depuis que des
 * factures SUPPLEMENT/EXTENSION peuvent exister pour une même location, la recherche par
 * simple `createdAt DESC` sans filtre de type sélectionnerait à tort la facture additionnelle
 * la plus récente si elle est elle-même encore DRAFT, écrasant son montant (une charge
 * additionnelle, pas le prix de la location) avec le `totalPrice` de la location.
 */
async function syncDraftInvoiceTotal(
  tx: Prisma.TransactionClient,
  locationId: string,
  newSubtotal: number
): Promise<void> {
  const invoice = await tx.invoice.findFirst({
    where: { locationId, type: "RENTAL" },
    orderBy: { createdAt: "desc" },
  });
  if (!invoice || invoice.status !== "DRAFT") {
    return;
  }
  const taxAmount = Math.round((newSubtotal * invoice.taxRate) / INVOICE_TAX_RATE_BASIS);
  const totalAmount = newSubtotal - invoice.discountAmount + taxAmount;
  if (totalAmount < 0) {
    // Ne peut arriver que si les dates sont raccourcies au point que la remise dépasse
    // désormais le sous-total + TVA (jamais lors d'une prolongation, où le sous-total
    // augmente) — même garde que computeInvoiceTotals (src/lib/invoices.ts) : la facture
    // existante reste inchangée plutôt que de produire un montant négatif.
    return;
  }
  await tx.invoice.update({ where: { id: invoice.id }, data: { subtotal: newSubtotal, taxAmount, totalAmount } });
}

export async function updateLocation(
  tenantId: string,
  locationId: string,
  data: UpdateLocationInput
): Promise<Location | null> {
  assertValidLocationNotes(data.notes);

  const existing = await getLocationById(tenantId, locationId);
  if (!existing) {
    return null;
  }

  // Sprint technique 3 (DOMAINRULES.md section 60, règle 11) : vérifié en tout premier, avant
  // toute autre lecture/écriture — un ancien client ou un appel direct portant encore ce champ
  // ne doit jamais pouvoir réussir, quel que soit l'état du contrat ou tout autre champ du corps
  // de requête (voir LocationExtensionMechanismRemovedError ci-dessus).
  if (data.extendReturnDate) {
    throw new LocationExtensionMechanismRemovedError();
  }

  validateFuelLevel(data.startFuelLevel);
  validateFuelLevel(data.endFuelLevel);

  // BUG-005 (INCIDENTS.md) : comparé au kilométrage de départ résultant (celui fourni dans ce
  // même appel s'il change, sinon celui déjà enregistré) — même principe que nextStart/nextEnd
  // plus bas pour les dates. `null` explicite (retrait du champ) n'est jamais comparé.
  if (data.endOdometer !== undefined && data.endOdometer !== null) {
    const nextStartOdometer = data.startOdometer !== undefined ? data.startOdometer : existing.startOdometer;
    assertValidReturnOdometer(data.endOdometer, nextStartOdometer);
  }

  // Sprint 23 (DOMAINRULES.md section 39) : un contrat déjà validé (sorti de PENDING) ne peut
  // plus jamais être annulé via cette transition simple — ni par un titulaire ordinaire de
  // locations.edit, ni même par un ADMIN via adminOverride. Annuler un contrat validé n'est
  // plus une simple transition de statut : cela doit toujours passer par
  // adminCancelValidatedLocation (POST /api/locations/[id]/admin-cancel), qui orchestre en plus
  // l'annulation des factures et la réversibilité financière (écritures de caisse de
  // compensation) — sans quoi une facture/des paiements resteraient incohérents avec un
  // contrat désormais annulé. Un contrat encore PENDING (brouillon jamais confirmé) reste
  // annulable normalement par tout titulaire de locations.edit, comportement inchangé.
  // Sprint 31A (DOMAINRULES.md section 43) : cette garde est désormais évaluée à l'intérieur de
  // la transaction ci-dessous, après verrouillage de la ligne — jamais ici sur `existing.status`
  // (lu hors transaction, donc potentiellement périmé face à une modification concurrente). Voir
  // le correctif de la course qui en résultait, plus bas.

  // Contrat verrouillé (Sprint 14B, DOMAINRULES.md section 29) : les dates ne sont plus
  // modifiables une fois la location sortie de PENDING (confirmée/active/terminée/annulée) —
  // un contrat déjà généré est une pièce métier figée. Toujours autorisé tant que PENDING
  // (simple brouillon), pour ne pas régresser sur le comportement déjà testé/validé du Sprint 5.
  // Sprint 19 : un ADMIN passant adminOverride contourne ce verrou (voir DOMAINRULES.md
  // section 37) — action journalisée systématiquement côté route, jamais silencieuse.
  // Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 3) : `confirmMaintenanceConflict`
  // contourne aussi ce verrou — sans quoi la permission granulaire
  // `locations.maintenance_conflict.override` ne pourrait jamais s'exercer pour un non-ADMIN
  // (une "prolongation" est par définition une modification de dates sur un contrat déjà
  // validé, donc déjà verrouillé). Comme `adminOverride`, ce booléen n'est honoré que parce que
  // la route a déjà vérifié la permission correspondante avant d'appeler cette fonction — jamais
  // un simple champ de corps de requête faisant foi de lui-même. Reste distinct d'adminOverride :
  // ne contourne que ce verrou précis, jamais la garde de transition de statut plus bas.
  // Sprint technique 3 : `extendReturnDate` retiré de cette liste de contournements — la
  // requête a déjà été rejetée sans exception ci-dessus (LocationExtensionMechanismRemovedError)
  // avant d'atteindre cette garde ; seuls `adminOverride`/`confirmMaintenanceConflict` restent
  // des contournements valides pour un contrat hors PENDING.
  if (
    (data.startDate || data.endDate) &&
    existing.status !== "PENDING" &&
    !data.adminOverride &&
    !data.confirmMaintenanceConflict
  ) {
    throw new LocationLockedError();
  }

  const nextStart = data.startDate ?? existing.startDate;
  const nextEnd = data.endDate ?? existing.endDate;

  if (nextEnd <= nextStart) {
    throw new InvalidDateRangeError();
  }

  // Sprint 30 (DOMAINRULES.md section 45, point 7) : un second conducteur ajouté/modifié après
  // la création du contrat (jamais verrouillé par LocationLockedError, voir le commentaire sur
  // UpdateLocationInput.secondDriverId ci-dessus) reste soumis au même contrôle d'âge, comparé à
  // `nextStart` — la date de début effective après cette modification (identique à
  // existing.startDate tant que PENDING n'est pas en train de changer ses dates dans le même
  // appel). `null` retire le second conducteur : aucun contrôle nécessaire dans ce cas.
  if (data.secondDriverId) {
    const secondDriver = await getClientById(tenantId, data.secondDriverId);
    if (!secondDriver) {
      throw new SecondDriverNotFoundError();
    }
    assertClientMeetsMinimumAge(secondDriver, nextStart, "secondDriver");
  }

  const datesChanging = Boolean(data.startDate || data.endDate);
  const statusChanging = data.status !== undefined && data.status !== existing.status;
  // Sprint technique 6 (DOMAINRULES.md section 43, corrige une course non couverte par le
  // correctif Sprint 31A ci-dessous) : condition d'entrée dans la branche verrouillée distincte
  // de `statusChanging` — une demande de statut explicite (`data.status !== undefined`) doit
  // toujours passer sous verrou, même quand elle semble déjà correspondre à `existing.status`.
  // Sans cette distinction, une seconde requête d'activation arrivant juste après qu'une
  // première ait déjà committé (donc lisant `existing.status` déjà à jour, "ACTIVE") avait
  // `statusChanging === false` et retombait sur l'`prisma.location.update` non gardé tout en bas
  // de cette fonction — aucun verrou, aucun `updateMany` conditionné, 200 silencieux sur une
  // "activation" redondante d'un contrat déjà actif. Voir le test de concurrence dédié
  // (src/__tests__/vehicle-status.test.ts, describe « 19. Concurrence sur l'activation d'un
  // contrat ») pour la reproduction déterministe de cette course.
  const statusRequested = data.status !== undefined;

  const totalPrice = datesChanging
    ? calculateTotalPrice(existing.pricePerDay, nextStart, nextEnd)
    : existing.totalPrice;

  const updateData = {
    startDate: nextStart,
    endDate: nextEnd,
    totalPrice,
    ...(data.status ? { status: data.status } : {}),
    ...(data.notes !== undefined ? { notes: data.notes } : {}),
    ...(data.startOdometer !== undefined ? { startOdometer: data.startOdometer } : {}),
    ...(data.endOdometer !== undefined ? { endOdometer: data.endOdometer } : {}),
    ...(data.startFuelLevel !== undefined ? { startFuelLevel: data.startFuelLevel } : {}),
    ...(data.endFuelLevel !== undefined ? { endFuelLevel: data.endFuelLevel } : {}),
    ...(data.deposit !== undefined ? { deposit: data.deposit } : {}),
    ...(data.secondDriverId !== undefined ? { secondDriverId: data.secondDriverId } : {}),
  };

  // Sprint 23 (DOMAINRULES.md section 39, étend le correctif Sprint 22 — DOMAINRULES.md
  // section 38 point 3(c) — aux « flux similaires concernés ») : une transition de statut passe
  // par un `updateMany` conditionné sur `status: existing.status`, atomique côté base — deux
  // transitions quasi simultanées sur le même contrat (ex. un agent clique "Terminée" pendant
  // qu'un admin clique "Annuler") ne peuvent plus toutes deux réussir.
  //
  // Sprint 26C, Finding C : un changement de dates rejoint désormais la même transaction —
  // verrou explicite du Vehicle concerné (`lockVehicleForUpdate`, src/lib/vehicles.ts) posé
  // avant de revérifier la disponibilité (`checkAvailability`, avec `tx` et `excludeLocationId:
  // existing.id` pour ne jamais entrer en conflit avec la location qu'on modifie elle-même),
  // dans la même transaction que l'écriture finale — même ordre de validation qu'avant ce
  // sprint (disponibilité, puis transition de statut). Une modification qui ne touche ni les
  // dates ni le statut n'a besoin d'aucune des deux gardes.
  if (datesChanging || statusRequested) {
    return prisma.$transaction(async (tx) => {
      // Sprint 31A (DOMAINRULES.md section 43) : verrou de ligne posé en tout premier, avant
      // toute garde dépendant du statut — corrige une course où la garde admin-cancel et le
      // contrôle de transition statuaient jusqu'ici sur `existing.status`, lu hors transaction et
      // donc potentiellement périmé. Si le statut verrouillé diverge de celui observé par la
      // requête (`existing.status`), un autre utilisateur a modifié la location entre la lecture
      // et l'écriture : conflit explicite (409), avant toute autre décision — jamais un 403 de
      // façade masquant un changement concurrent, jamais un 409 masquant un vrai refus métier.
      const locked = await lockLocationForUpdate(tenantId, locationId, tx);
      if (!locked) {
        throw new LocationStatusConflictError();
      }
      if (locked.status !== existing.status) {
        throw new LocationStatusConflictError();
      }

      // Sprint technique 6 (DOMAINRULES.md section 43) : au-delà de la staleness ci-dessus (qui
      // ne détecte qu'une divergence entre `existing.status` et l'état verrouillé), une demande
      // de statut explicite identique au statut déjà en place n'est jamais une vraie transition
      // — la machine à états (`ALLOWED_TRANSITIONS`) ne définit d'ailleurs aucune boucle sur
      // elle-même (ex. `ACTIVE → ACTIVE` n'existe pas). Traité comme un conflit, jamais un no-op
      // silencieux : redemander l'activation d'un contrat déjà actif signifie presque toujours
      // qu'une autre requête a déjà effectué cette transition entre-temps (voir le commentaire
      // sur `statusRequested` ci-dessus) — jamais contournable par `adminOverride`, qui ne
      // dispense que d'un saut de la machine à états non listé, pas d'une écriture concurrente
      // potentiellement déjà appliquée par quelqu'un d'autre.
      if (data.status !== undefined && data.status === locked.status) {
        throw new LocationStatusConflictError();
      }

      // Sprint 23 (DOMAINRULES.md section 39), déplacée Sprint 31A : le statut verrouillé
      // ci-dessus est désormais garanti identique à `existing.status` — un refus ici est un vrai
      // refus métier, jamais un artefact de concurrence.
      if (data.status === "CANCELLED" && existing.status !== "CANCELLED" && existing.status !== "PENDING") {
        throw new LocationCancellationRequiresAdminError();
      }

      if (datesChanging) {
        // Sprint technique 3 (DOMAINRULES.md section 60, règle 11) : protection de chaîne,
        // jamais contournable (ni adminOverride ni confirmMaintenanceConflict — voir
        // LocationHasExtensionChainError ci-dessus). Vérifiée sous le même verrou de ligne que
        // ci-dessus (lockLocationForUpdate), donc sérialisée contre une création concurrente de
        // prolongation (createLocationExtension verrouille la même ligne parent avant d'écrire
        // son enfant, src/lib/location-chains.ts) : aucune fenêtre de course possible où un
        // enfant apparaîtrait juste après cette lecture sans être vu par cette transaction.
        // `endDate` est le bord partagé avec un enfant éventuel (`child.startDate ===
        // existing.endDate`, garanti par construction à la création de l'enfant) ; `startDate`
        // est le bord partagé avec un parent éventuel (`existing.startDate ===
        // parent.endDate`) — seul le bord réellement modifié par cette requête est vérifié.
        if (data.endDate !== undefined) {
          const child = await tx.location.findFirst({
            where: { parentLocationId: locationId },
            select: { id: true },
          });
          if (child) {
            throw new LocationHasExtensionChainError();
          }
        }
        if (data.startDate !== undefined && existing.parentLocationId) {
          throw new LocationHasExtensionChainError();
        }

        const vehicle = await lockVehicleForUpdate(tenantId, existing.vehicleId, tx);
        if (!vehicle) {
          throw new VehicleNotFoundError();
        }
        assertVehicleStatusAllowsLocation(vehicle);
        const availability = await checkAvailability(
          tenantId,
          existing.vehicleId,
          nextStart,
          nextEnd,
          existing.id,
          tx
        );
        if (!availability?.available) {
          throw new VehicleNotAvailableError(availability?.conflictingLocations ?? []);
        }

        // Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 3) : un contrat encore PENDING
        // (jamais confirmé, donc jamais une vraie "prolongation" pour un client déjà engagé)
        // reste soumis au même blocage strict qu'une création — voir createLocationLocked. Seule
        // la modification des dates d'un contrat déjà validé (CONFIRMED/ACTIVE, `locked.status`
        // relu sous verrou ci-dessus, jamais `existing.status` périmé) est une vraie prolongation
        // et bénéficie du parcours "alerte + décision explicite" au lieu d'un refus automatique.
        const conflictingMaintenances = await findConflictingMaintenances(
          existing.vehicleId,
          nextStart,
          nextEnd,
          undefined,
          tx
        );
        if (conflictingMaintenances.length > 0) {
          if (locked.status === "PENDING") {
            throw new VehicleMaintenanceConflictError(conflictingMaintenances);
          }
          if (!data.confirmMaintenanceConflict) {
            throw new MaintenanceExtensionConflictError(conflictingMaintenances);
          }
          // Décision explicite déjà vérifiée côté route (permission granulaire) : la
          // prolongation continue malgré le chevauchement, la maintenance reste inchangée —
          // jamais un déplacement automatique (règle 3, brief Sprint 34 étape 3).
        }
      }

      if (
        data.status &&
        data.status !== existing.status &&
        !canTransition(existing.status, data.status) &&
        !data.adminOverride
      ) {
        throw new InvalidStatusTransitionError(existing.status, data.status);
      }

      let updatedLocation: Location;
      if (statusChanging) {
        const { count } = await tx.location.updateMany({
          where: { id: locationId, status: existing.status },
          data: updateData,
        });
        if (count === 0) {
          throw new LocationStatusConflictError();
        }
        updatedLocation = await tx.location.findUniqueOrThrow({ where: { id: locationId } });
      } else {
        updatedLocation = await tx.location.update({ where: { id: locationId }, data: updateData });
      }

      // Sprint 13E tâche 2 (DOMAINRULES.md section 52) : la facture DRAFT générée à la création
      // (sous-produit, voir syncDraftInvoiceTotal ci-dessus) reste sinon un simple miroir figé
      // de l'ancien totalPrice après toute modification de dates qui change le prix (ADMIN ou
      // prolongation) — corrigé à la source ici, dans la même transaction que l'écriture.
      if (datesChanging && totalPrice !== existing.totalPrice) {
        await syncDraftInvoiceTotal(tx, locationId, totalPrice);
      }

      // Sprint "statut opérationnel automatique" (2026-08-28) : toute transition de statut
      // (CONFIRMED → ACTIVE, ACTIVE → COMPLETED/CANCELLED, PENDING → CANCELLED, etc.) peut faire
      // varier le statut opérationnel du véhicule — jamais une réécriture aveugle à AVAILABLE,
      // toujours un recalcul tenant compte d'une éventuelle autre opération déjà active.
      if (statusChanging) {
        await syncVehicleStatus(existing.vehicleId, tx);

        // Revue durée de réservation/retour véhicule (2026-09-01) : ce chemin (transition de
        // statut générique, PATCH /api/locations/[id]) est l'un des deux points d'entrée qui
        // peuvent clore un contrat par COMPLETED — l'autre étant returnLocation
        // (src/lib/location-return.ts, POST .../return). Les deux doivent synchroniser
        // Vehicle.currentOdometer/currentFuelLevel de la même façon, jamais un seul.
        if (data.status === "COMPLETED") {
          await syncVehicleOdometerAndFuel(
            existing.vehicleId,
            { odometer: updatedLocation.endOdometer, fuelLevel: updatedLocation.endFuelLevel },
            tx
          );
        }
      }

      return updatedLocation;
    });
  }

  return prisma.location.update({
    where: { id: locationId },
    data: updateData,
  });
}

/**
 * Une Invoice DRAFT sans paiement est un simple sous-produit de la génération automatique
 * à la création de la location (voir POST /api/locations) : elle est supprimée avec la
 * location. Toute facture allée au-delà (SENT/PARTIALLY_PAID/PAID) ou ayant reçu un
 * paiement (amountPaid > 0, y compris CANCELLED avec historique de paiement) est un vrai
 * document métier et bloque la suppression — même règle que deleteInvoice (src/lib/invoices.ts).
 */
export async function deleteLocation(tenantId: string, locationId: string): Promise<boolean> {
  const existing = await getLocationById(tenantId, locationId);
  if (!existing) {
    return false;
  }

  if (existing.status !== "PENDING" && existing.status !== "CANCELLED") {
    throw new LocationNotDeletableError();
  }

  const invoices = await prisma.invoice.findMany({ where: { locationId } });
  const hasNonDeletableInvoice = invoices.some(
    (invoice) => invoice.status !== "DRAFT" || invoice.amountPaid > 0
  );
  // Sprint 32 (DOMAINRULES.md section 32, correctif étape 5) : Damage a une contrainte de clé
  // étrangère réelle vers Location (jamais de suppression physique d'un dégât, voir
  // prisma/schema.prisma) — sans ce contrôle, la transaction ci-dessous échouait avec une
  // erreur Prisma brute non gérée (violation de contrainte) dès qu'un dégât, même non payé,
  // était attaché à une location PENDING/CANCELLED par ailleurs supprimable.
  const hasDamages = (await prisma.damage.count({ where: { locationId } })) > 0;
  // Campagne QA (2026-08-27, passe de correction obligatoire) : un surclassement est un
  // enregistrement d'audit immuable (accord/justification, montant validé, utilisateur
  // validateur) — même principe que Damage ci-dessus, jamais supprimé silencieusement avec son
  // contrat. Un contrat surclassé qu'on souhaite réellement annuler doit être annulé
  // (CANCELLED), pas supprimé.
  const hasUpgrade = (await prisma.locationUpgrade.count({ where: { locationId } })) > 0;
  if (hasNonDeletableInvoice || hasDamages || hasUpgrade) {
    throw new LocationHasInvoiceError();
  }

  await prisma.$transaction([
    prisma.invoice.deleteMany({ where: { locationId } }),
    prisma.location.delete({ where: { id: locationId } }),
  ]);
  return true;
}

/** Sprint 23 (DOMAINRULES.md section 39) — statuts considérés « validés » (sortis du simple
 * brouillon PENDING) : seuls ceux-là exigent le circuit de réversibilité complète ci-dessous. */
const VALIDATED_LOCATION_STATUSES: LocationStatus[] = ["CONFIRMED", "ACTIVE", "COMPLETED"];

export class LocationNotAdminCancellableError extends Error {
  constructor() {
    super(
      "Seul un contrat validé (CONFIRMED/ACTIVE/COMPLETED) peut être annulé par cette action — " +
        "un contrat encore PENDING s'annule normalement (PATCH), un contrat déjà CANCELLED l'est déjà."
    );
    this.name = "LocationNotAdminCancellableError";
  }
}

export interface AdminCancelLocationResult {
  location: Location;
  cancelledInvoiceIds: string[];
  reversedPaymentCount: number;
  reversedAmountTotal: number;
  /** Sprint 26D (Finding D1) : paiements marqués REFUNDED qui n'avaient aucune CashEntry
   * d'origine à compenser (legacy — jamais reflétés en caisse) — comptés séparément,
   * jamais mélangés à reversedPaymentCount/reversedAmountTotal. */
  refundedWithoutCashEntryCount: number;
  /** Sprint 26D (Finding D1) : détail par paiement remboursé, pour journalisation précise
   * côté route (notamment un éventuel overrideRefundMethod). */
  refunds: Array<{ paymentId: string; amount: number; originalMethod: PaymentMethod; appliedMethod: PaymentMethod | null }>;
}

export interface AdminCancelLocationOptions {
  /** Sprint 26D (Finding D1) : motif obligatoire — porté par la compensation de chaque
   * paiement remboursé et par le journal d'audit (voir la route). */
  reason: string;
  performedByUserId: string;
  /** Sprint 26D (Finding D1) : moyen de remboursement forcé, distinct du moyen d'origine de
   * chaque Payment — n'affecte jamais Payment.method (jamais réécrit), uniquement le
   * paymentMethod de la CashEntry de compensation. Réservé à `payments.override_refund_method`,
   * vérifié côté route avant l'appel — cette fonction fait confiance à l'appelant. */
  overrideRefundMethod?: PaymentMethod;
}

/**
 * Annulation d'un contrat déjà validé, réservée à un ADMIN (dérivé côté route uniquement,
 * jamais un champ de corps de requête — DOMAINRULES.md section 39) : orchestre en une seule
 * transaction Prisma (1) le passage atomique de la Location à CANCELLED (même garde
 * `updateMany` conditionnée que le reste de ce fichier — c'est cette garde qui rend l'ensemble
 * de l'opération idempotente : un second appel, séquentiel ou concurrent, échoue ici avant
 * d'atteindre la boucle paiements/factures, voir LocationStatusConflictError/le test Sprint 23),
 * (2) l'annulation de toute Invoice non déjà VOID de ce contrat — y compris depuis
 * PAID/PARTIALLY_PAID, un cas que la machine à états normale d'Invoice (src/lib/invoices.ts,
 * canTransition) n'autorise jamais autrement, jamais exposé par la route PATCH générique des
 * factures — (3) pour chaque Payment de ces factures, marqué REFUNDED (Sprint 26D — jamais
 * supprimé, jamais réécrit dans son amount/method/paidAt) et une CashEntry de compensation liée
 * (paymentId/parentEntryId, Sprint 26D) de type EXPENSE et de même montant que le paiement
 * d'origine, pour que le solde de caisse redevienne exact sans jamais réécrire l'historique
 * (DOMAINRULES.md sections 10/23). Le contrat lui-même n'est jamais supprimé (reste
 * consultable, mention « Contrat annulé ») — voir LocationHasInvoiceError pour la suppression,
 * volontairement non assouplie après cette opération (une facture VOID reste `!== DRAFT`).
 */
export async function adminCancelValidatedLocation(
  tenantId: string,
  locationId: string,
  options: AdminCancelLocationOptions
): Promise<AdminCancelLocationResult | null> {
  if (!options.reason.trim()) {
    throw new CorrectionReasonRequiredError();
  }

  const existing = await getLocationById(tenantId, locationId);
  if (!existing) {
    return null;
  }

  if (!VALIDATED_LOCATION_STATUSES.includes(existing.status)) {
    throw new LocationNotAdminCancellableError();
  }

  const result = await prisma.$transaction(async (tx) => {
    const { count } = await tx.location.updateMany({
      where: { id: locationId, status: existing.status },
      data: { status: "CANCELLED" },
    });
    if (count === 0) {
      throw new LocationStatusConflictError();
    }
    const location = await tx.location.findUniqueOrThrow({ where: { id: locationId } });
    // Sprint "statut opérationnel automatique" (2026-08-28) : un contrat ACTIVE annulé par un
    // ADMIN doit recalculer immédiatement le statut du véhicule (typiquement RENTED → AVAILABLE,
    // ou vers une autre opération déjà active le cas échéant).
    await syncVehicleStatus(existing.vehicleId, tx);

    // Ne force à VOID que les factures qui reflètent une vraie activité — même prédicat
    // que deleteLocation ci-dessus (hasNonDeletableInvoice) : ISSUED/PARTIALLY_PAID/PAID, ou
    // toute facture ayant reçu un paiement. Une facture DRAFT à 0 paiement n'est qu'un
    // sous-produit vide de la création du contrat (même commentaire que deleteLocation) —
    // la laisser DRAFT permet à un contrat validé annulé sans historique financier réel de
    // rester supprimable ensuite (LocationHasInvoiceError ne bloquerait alors jamais à tort).
    const invoicesToCancel = await tx.invoice.findMany({
      where: {
        locationId,
        status: { not: "VOID" },
        OR: [{ status: { not: "DRAFT" } }, { amountPaid: { gt: 0 } }],
      },
    });

    let reversedPaymentCount = 0;
    let reversedAmountTotal = 0;
    let refundedWithoutCashEntryCount = 0;
    const refunds: AdminCancelLocationResult["refunds"] = [];

    for (const invoice of invoicesToCancel) {
      await tx.invoice.update({ where: { id: invoice.id }, data: { status: "VOID" } });

      // Sprint 33 (DOMAINRULES.md section 48) : un paiement de dégât n'a plus jamais d'invoiceId
      // (Payment.invoiceId/damageInvoiceId mutuellement exclusifs, contrainte CHECK en base —
      // remplace le mécanisme provisoire du Sprint 32 où un paiement de dégât partageait
      // l'invoiceId de la facture du contrat). Filtrer par `invoiceId: invoice.id` exclut donc
      // déjà structurellement tout paiement de dégât : il n'a jamais cet invoiceId. L'annulation
      // d'un contrat n'annule jamais la réparation d'un dégât déjà réglée (facture séparée, voir
      // src/lib/damage-invoices.ts).
      const payments = await tx.payment.findMany({ where: { invoiceId: invoice.id } });
      for (const payment of payments) {
        // Idempotence en défense en profondeur (Sprint 26D) : la garde updateMany sur
        // Location.status ci-dessus empêche déjà structurellement un second appel d'atteindre
        // cette boucle (voir le commentaire de la fonction) — ce garde-fou supplémentaire ne
        // devrait donc jamais se déclencher en pratique, mais évite tout double remboursement
        // si l'invariant ci-dessus était un jour affaibli.
        if (payment.status === "REFUNDED") {
          continue;
        }

        // Un Payment antérieur au Sprint 18 (avant que createPayment n'alimente
        // systématiquement la caisse) peut n'avoir jamais eu de CashEntry — le client est
        // remboursé (status REFUNDED) sans qu'il existe d'écriture à compenser (rien à
        // inverser, jamais de compensation orpheline).
        const originalEntry = await tx.cashEntry.findFirst({
          where: { paymentId: payment.id, parentEntryId: null },
        });

        if (!originalEntry) {
          await tx.payment.update({ where: { id: payment.id }, data: { status: "REFUNDED" } });
          refundedWithoutCashEntryCount += 1;
          refunds.push({ paymentId: payment.id, amount: payment.amount, originalMethod: payment.method, appliedMethod: null });
          continue;
        }

        const appliedMethod = options.overrideRefundMethod ?? payment.method;
        await createCorrectionCashEntry(
          {
            tenantId,
            parentEntryId: originalEntry.id,
            paymentId: payment.id,
            type: "EXPENSE",
            amount: payment.amount,
            paymentMethod: appliedMethod,
            category: "ANNULATION_CONTRAT",
            description: `Annulation contrat ${location.contractNumber ?? `#${location.id.slice(-8)}`} — compensation du paiement du ${payment.paidAt.toISOString().slice(0, 10)}`,
            reason: options.reason.trim(),
            performedByUserId: options.performedByUserId,
            agencyId: location.agencyId,
            contractId: location.id,
            contractNumber: location.contractNumber,
          },
          tx
        );
        await tx.payment.update({ where: { id: payment.id }, data: { status: "REFUNDED" } });

        reversedPaymentCount += 1;
        reversedAmountTotal += payment.amount;
        refunds.push({ paymentId: payment.id, amount: payment.amount, originalMethod: payment.method, appliedMethod });
      }
    }

    return {
      location,
      cancelledInvoiceIds: invoicesToCancel.map((invoice) => invoice.id),
      reversedPaymentCount,
      reversedAmountTotal,
      refundedWithoutCashEntryCount,
      refunds,
    };
  });

  return result;
}
