import type { Location, LocationStatus, PaymentMethod, Prisma, Vehicle, VehicleStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { checkAvailability, lockVehicleForUpdate } from "@/lib/vehicles";
import { getClientById } from "@/lib/clients";
import { createCorrectionCashEntry, CorrectionReasonRequiredError } from "@/lib/cash-register";

export { CorrectionReasonRequiredError };

export class InvalidDateRangeError extends Error {
  constructor() {
    super("endDate doit être postérieure à startDate.");
    this.name = "InvalidDateRangeError";
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

const VEHICLE_STATUSES_BLOCKING_LOCATION: VehicleStatus[] = ["MAINTENANCE", "TRANSFERRING", "ON_TRIP"];

/**
 * Appliqué immédiatement après lockVehicleForUpdate — création (toujours) et modification
 * (uniquement quand les dates changent, seul cas où le véhicule est aujourd'hui reverrouillé/
 * revérifié, voir updateLocation). Ne s'applique jamais rétroactivement à une Location déjà
 * créée dont le véhicule change de statut ensuite (aucune fonction ne parcourt les Location
 * existantes pour les annuler/suspendre) — comportement délibéré, DOMAINRULES.md section 30.
 */
function assertVehicleStatusAllowsLocation(vehicle: Vehicle): void {
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
      "Cette location a une facture SENT/PARTIALLY_PAID/PAID ou avec un paiement enregistré ; " +
        "annulez ou supprimez la facture (voir DELETE /api/invoices/[id]) avant de supprimer la location."
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

/** Sprint 23 — garde de concurrence sur la transition de statut (voir updateLocation). */
export class LocationStatusConflictError extends Error {
  constructor() {
    super("Le statut de ce contrat a été modifié entre-temps — rechargez la page et réessayez.");
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

/** Nombre de jours arrondi au jour supérieur, minimum 1 jour. */
export function calculateTotalPrice(pricePerDay: number, start: Date, end: Date): number {
  const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
  return pricePerDay * days;
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
  agencyId?: string;
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
      ...(filters.agencyId ? { agencyId: filters.agencyId } : {}),
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
  filters: { agencyIds?: string[] | null; status?: LocationStatus } = {}
): Promise<ContractOverviewRow[]> {
  const locations = await prisma.location.findMany({
    where: {
      tenantId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.agencyIds
        ? { OR: [{ agencyId: { in: filters.agencyIds } }, { dropoffAgencyId: { in: filters.agencyIds } }] }
        : {}),
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
function isContractNumberCollision(error: unknown): boolean {
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

  const client = await getClientById(data.tenantId, data.clientId, tx);
  if (!client) {
    throw new ClientNotFoundError();
  }

  if (data.secondDriverId) {
    const secondDriver = await getClientById(data.tenantId, data.secondDriverId, tx);
    if (!secondDriver) {
      throw new SecondDriverNotFoundError();
    }
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
    const contractNumber = await generateContractNumber(data.agencyId, tx);
    const savepoint = CONTRACT_NUMBER_SAVEPOINTS[attempt];
    await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
    try {
      const location = await tx.location.create({
        data: {
          tenantId: data.tenantId,
          agencyId: data.agencyId,
          dropoffAgencyId: data.dropoffAgencyId && data.dropoffAgencyId !== data.agencyId ? data.dropoffAgencyId : null,
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
      return location;
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
}

export async function updateLocation(
  tenantId: string,
  locationId: string,
  data: UpdateLocationInput
): Promise<Location | null> {
  const existing = await getLocationById(tenantId, locationId);
  if (!existing) {
    return null;
  }

  if (data.secondDriverId) {
    const secondDriver = await getClientById(tenantId, data.secondDriverId);
    if (!secondDriver) {
      throw new SecondDriverNotFoundError();
    }
  }

  validateFuelLevel(data.startFuelLevel);
  validateFuelLevel(data.endFuelLevel);

  // Sprint 23 (DOMAINRULES.md section 39) : un contrat déjà validé (sorti de PENDING) ne peut
  // plus jamais être annulé via cette transition simple — ni par un titulaire ordinaire de
  // locations.edit, ni même par un ADMIN via adminOverride. Annuler un contrat validé n'est
  // plus une simple transition de statut : cela doit toujours passer par
  // adminCancelValidatedLocation (POST /api/locations/[id]/admin-cancel), qui orchestre en plus
  // l'annulation des factures et la réversibilité financière (écritures de caisse de
  // compensation) — sans quoi une facture/des paiements resteraient incohérents avec un
  // contrat désormais annulé. Un contrat encore PENDING (brouillon jamais confirmé) reste
  // annulable normalement par tout titulaire de locations.edit, comportement inchangé.
  if (data.status === "CANCELLED" && existing.status !== "CANCELLED" && existing.status !== "PENDING") {
    throw new LocationCancellationRequiresAdminError();
  }

  // Contrat verrouillé (Sprint 14B, DOMAINRULES.md section 29) : les dates ne sont plus
  // modifiables une fois la location sortie de PENDING (confirmée/active/terminée/annulée) —
  // un contrat déjà généré est une pièce métier figée. Toujours autorisé tant que PENDING
  // (simple brouillon), pour ne pas régresser sur le comportement déjà testé/validé du Sprint 5.
  // Sprint 19 : un ADMIN passant adminOverride contourne ce verrou (voir DOMAINRULES.md
  // section 37) — action journalisée systématiquement côté route, jamais silencieuse.
  if ((data.startDate || data.endDate) && existing.status !== "PENDING" && !data.adminOverride) {
    throw new LocationLockedError();
  }

  const nextStart = data.startDate ?? existing.startDate;
  const nextEnd = data.endDate ?? existing.endDate;

  if (nextEnd <= nextStart) {
    throw new InvalidDateRangeError();
  }

  const datesChanging = Boolean(data.startDate || data.endDate);
  const statusChanging = data.status !== undefined && data.status !== existing.status;

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
  if (datesChanging || statusChanging) {
    return prisma.$transaction(async (tx) => {
      if (datesChanging) {
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
      }

      if (
        data.status &&
        data.status !== existing.status &&
        !canTransition(existing.status, data.status) &&
        !data.adminOverride
      ) {
        throw new InvalidStatusTransitionError(existing.status, data.status);
      }

      if (statusChanging) {
        const { count } = await tx.location.updateMany({
          where: { id: locationId, status: existing.status },
          data: updateData,
        });
        if (count === 0) {
          throw new LocationStatusConflictError();
        }
        return tx.location.findUniqueOrThrow({ where: { id: locationId } });
      }

      return tx.location.update({ where: { id: locationId }, data: updateData });
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
  if (hasNonDeletableInvoice) {
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
 * (2) l'annulation de toute Invoice non déjà CANCELLED de ce contrat — y compris depuis
 * PAID/PARTIALLY_PAID, un cas que la machine à états normale d'Invoice (src/lib/invoices.ts,
 * canTransition) n'autorise jamais autrement, jamais exposé par la route PATCH générique des
 * factures — (3) pour chaque Payment de ces factures, marqué REFUNDED (Sprint 26D — jamais
 * supprimé, jamais réécrit dans son amount/method/paidAt) et une CashEntry de compensation liée
 * (paymentId/parentEntryId, Sprint 26D) de type EXPENSE et de même montant que le paiement
 * d'origine, pour que le solde de caisse redevienne exact sans jamais réécrire l'historique
 * (DOMAINRULES.md sections 10/23). Le contrat lui-même n'est jamais supprimé (reste
 * consultable, mention « Contrat annulé ») — voir LocationHasInvoiceError pour la suppression,
 * volontairement non assouplie après cette opération (une facture CANCELLED reste `!== DRAFT`).
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

    // Ne force à CANCELLED que les factures qui reflètent une vraie activité — même prédicat
    // que deleteLocation ci-dessus (hasNonDeletableInvoice) : SENT/PARTIALLY_PAID/PAID, ou
    // toute facture ayant reçu un paiement. Une facture DRAFT à 0 paiement n'est qu'un
    // sous-produit vide de la création du contrat (même commentaire que deleteLocation) —
    // la laisser DRAFT permet à un contrat validé annulé sans historique financier réel de
    // rester supprimable ensuite (LocationHasInvoiceError ne bloquerait alors jamais à tort).
    const invoicesToCancel = await tx.invoice.findMany({
      where: {
        locationId,
        status: { not: "CANCELLED" },
        OR: [{ status: { not: "DRAFT" } }, { amountPaid: { gt: 0 } }],
      },
    });

    let reversedPaymentCount = 0;
    let reversedAmountTotal = 0;
    let refundedWithoutCashEntryCount = 0;
    const refunds: AdminCancelLocationResult["refunds"] = [];

    for (const invoice of invoicesToCancel) {
      await tx.invoice.update({ where: { id: invoice.id }, data: { status: "CANCELLED" } });

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
