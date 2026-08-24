import type { Location, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getClientById } from "@/lib/clients";
import { logAction } from "@/lib/audit";
import { getOrCreateMainInvoice, getInvoiceNetAmounts } from "@/lib/invoices";
import { checkAvailability, lockVehicleForUpdate, findConflictingMaintenances } from "@/lib/vehicles";
import { canAccessLocationAgency, type SessionUser } from "@/lib/authz";
import {
  getLocationById,
  lockLocationForUpdate,
  generateContractNumber,
  isContractNumberCollision,
  assertVehicleStatusAllowsLocation,
  assertDriverLicenseCoversReturn,
  calculateTotalPrice,
  InvalidDateRangeError,
  ClientNotFoundError,
  VehicleNotFoundError,
  VehicleNotAvailableError,
  VehicleMaintenanceConflictError,
  MissingPriceError,
  InvalidFuelLevelError,
} from "@/lib/locations";

/**
 * Sprint technique 1 (DOMAINRULES.md section 60, HANDOFF.md point 43) : création d'une
 * prolongation comme nouveau contrat indépendant — jamais une modification du contrat existant.
 * Depuis le Sprint technique 3 (règle 11), c'est l'**unique** mécanisme officiel de
 * prolongation : l'ancien parcours `extendReturnDate` (Sprint 13E tâche 2, DOMAINRULES.md
 * section 54) a été entièrement retiré du parcours utilisateur, et `updateLocation`
 * (src/lib/locations.ts) rejette désormais sans exception toute requête le portant encore
 * (LocationExtensionMechanismRemovedError) ainsi que toute modification de date sur un contrat
 * déjà chaîné, même par un ADMIN (LocationHasExtensionChainError). Module séparé de
 * locations.ts/invoices.ts, même principe que location-payment.ts/location-return.ts : orchestre
 * les deux domaines dans une seule transaction, ce que locations.ts ne peut pas faire lui-même
 * (invoices.ts importe déjà getLocationById depuis locations.ts — un import inverse y créerait
 * un cycle, déjà documenté dans ce fichier).
 */

export class LocationExtensionParentNotFoundError extends Error {
  constructor() {
    super("Contrat parent introuvable.");
    this.name = "LocationExtensionParentNotFoundError";
  }
}

/** DOMAINRULES.md section 60, règles 1/8/9 : une seule vérification de statut couvre les trois
 * cas interdits (contrat pas encore actif, déjà retourné/COMPLETED, ou CANCELLED) — ACTIVE est
 * l'unique statut autorisé, cohérent avec ALLOWED_TRANSITIONS (locations.ts) où ACTIVE ne peut
 * aller que vers COMPLETED ou CANCELLED, jamais l'inverse. */
export class LocationExtensionParentNotActiveError extends Error {
  constructor() {
    super(
      "Seul un contrat ACTIVE peut être prolongé (jamais avant activation, après retour, ni sur un contrat annulé)."
    );
    this.name = "LocationExtensionParentNotActiveError";
  }
}

/** DOMAINRULES.md section 60, règle 3 : chaîne strictement linéaire, aucun embranchement — au
 * plus un enfant direct par contrat (garanti en dernier ressort par @@unique(parentLocationId),
 * voir la contrainte CHECK de la migration). */
export class LocationExtensionParentHasChildError extends Error {
  constructor() {
    super("Ce contrat a déjà une prolongation directe : la chaîne doit rester strictement linéaire.");
    this.name = "LocationExtensionParentHasChildError";
  }
}

export interface CreateLocationExtensionInput {
  tenantId: string;
  userId: string | null;
  parentLocationId: string;
  /** Nouvelle agence de référence si différente de celle du contrat parent (DOMAINRULES.md
   * section 60, règle 5 — sert aussi de base à la numérotation, voir generateContractNumber).
   * L'accès de l'appelant à cette agence est vérifié côté route (canAccessAgency), jamais ici. */
  agencyId?: string;
  /** Nouveau véhicule si différent de celui du contrat parent (règle 4). La disponibilité est
   * revérifiée dans tous les cas (véhicule identique ou non), la période étant nouvelle. */
  vehicleId?: string;
  /** Nouvelle date de retour. La date de départ n'est jamais fournie par l'appelant : elle vaut
   * toujours `parent.endDate` exactement (contrat contigu, jamais de trou ni de chevauchement
   * avec le parent — voir la vérification de disponibilité ci-dessous, qui s'appuie sur cette
   * contiguïté pour ne jamais entrer en conflit avec le contrat parent lui-même). */
  endDate: Date;
  notes?: string;
  startOdometer?: number;
  endOdometer?: number;
  startFuelLevel?: number;
  endFuelLevel?: number;
  deposit?: number;
  /** Tarif propre à cette prolongation (règle 6), jamais hérité du contrat parent. `0` est
   * accepté explicitement (règle 7, prolongation gratuite) : seul `undefined` retombe sur le
   * prix informatif du véhicule, exactement comme createLocation. */
  pricePerDay?: number;
  totalPrice?: number;
  /** Remise et TVA propres à cette prolongation (règle 6), jamais héritées du parent — transmises
   * telles quelles à createInvoice (src/lib/invoices.ts), 0 par défaut comme pour tout contrat.
   * Une remise couvrant tout le sous-total (prolongation partiellement ou totalement gratuite,
   * règle 7) est acceptée sans plancher, déjà garanti par computeInvoiceTotals existant. */
  discountAmount?: number;
  taxRate?: number;
}

export interface CreateLocationExtensionResult {
  location: Location;
  invoice: Awaited<ReturnType<typeof getOrCreateMainInvoice>>["invoice"];
}

function validateFuelLevel(value: number | null | undefined): void {
  if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 0 || value > 100)) {
    throw new InvalidFuelLevelError();
  }
}

/** Savepoints distincts de ceux de createLocation (locations.ts) — même mécanisme de réessai sur
 * collision de numéro de contrat (voir isContractNumberCollision, réutilisée telle quelle), noms
 * SQL fixes et propres à ce module pour ne jamais partager d'identifiant de savepoint entre deux
 * fonctions différentes, même si elles ne s'imbriquent jamais en pratique. */
const EXTENSION_NUMBER_SAVEPOINTS = [
  "location_extension_sp_0",
  "location_extension_sp_1",
  "location_extension_sp_2",
  "location_extension_sp_3",
  "location_extension_sp_4",
] as const;
const MAX_EXTENSION_NUMBER_ATTEMPTS = EXTENSION_NUMBER_SAVEPOINTS.length;

/**
 * Étapes 1 à 4 (session, tenant, agence autorisée, permission `locations.extension.create`) :
 * du ressort exclusif de l'appelant HTTP (POST /api/locations/[id]/extend) — ce module ne connaît
 * pas les permissions, même principe que createLocation/updateLocation (locations.ts).
 * Étapes 5 à 15 : implémentées ci-dessous, dans une seule transaction atomique.
 */
export async function createLocationExtension(
  data: CreateLocationExtensionInput,
  tx: Prisma.TransactionClient = prisma
): Promise<CreateLocationExtensionResult> {
  // La date de départ n'est connue qu'une fois le contrat parent verrouillé et lu (étape 5) —
  // contrairement à createLocation, la validation de plage de dates (étape 8) ne peut donc se
  // faire qu'à l'intérieur de la transaction, pas ici.
  if (tx !== prisma) {
    return createLocationExtensionLocked(data, tx);
  }
  return prisma.$transaction((innerTx) => createLocationExtensionLocked(data, innerTx));
}

async function createLocationExtensionLocked(
  data: CreateLocationExtensionInput,
  tx: Prisma.TransactionClient
): Promise<CreateLocationExtensionResult> {
  // Étape 5 : charger et verrouiller le contrat parent (SELECT ... FOR UPDATE) — sérialise deux
  // tentatives concurrentes de prolonger le même contrat (même primitive que createLocation/
  // getOrCreateMainInvoice, lockLocationForUpdate, src/lib/locations.ts) : la seconde attend le
  // commit/rollback de la première avant de relire un état à jour (parent déjà prolongé ou non).
  const lockedParent = await lockLocationForUpdate(data.tenantId, data.parentLocationId, tx);
  if (!lockedParent) {
    throw new LocationExtensionParentNotFoundError();
  }

  // Étape 6 : statut du parent.
  if (lockedParent.status !== "ACTIVE") {
    throw new LocationExtensionParentNotActiveError();
  }

  // Lecture complète du parent, garantie cohérente grâce au verrou ci-dessus.
  const parent = await getLocationById(data.tenantId, data.parentLocationId, tx);
  if (!parent) {
    throw new LocationExtensionParentNotFoundError();
  }

  // Étape 7 : au plus un enfant direct. Vérification proactive pour un message d'erreur clair ;
  // @@unique(parentLocationId) (voir migration) reste le garde-fou ultime au niveau base.
  const existingChild = await tx.location.findFirst({
    where: { parentLocationId: parent.id },
    select: { id: true },
  });
  if (existingChild) {
    throw new LocationExtensionParentHasChildError();
  }

  // Étape 8 : dates — la période commence exactement où finit le contrat parent (jamais fournie
  // par l'appelant), ce qui garantit par construction l'absence de trou et de chevauchement avec
  // le parent lui-même (periodsOverlap, src/lib/vehicles.ts, est stricte : deux périodes qui se
  // touchent exactement ne sont jamais en conflit).
  const startDate = parent.endDate;
  if (data.endDate <= startDate) {
    throw new InvalidDateRangeError();
  }

  // Étape 10 : agence de référence du nouveau contrat, y compris pour sa numérotation
  // (DOMAINRULES.md section 60, règle 5) — par défaut celle du parent.
  const referenceAgencyId = data.agencyId ?? parent.agencyId;

  // Étape 9 : disponibilité du véhicule (nouveau ou inchangé — la période est nouvelle dans tous
  // les cas). Verrou explicite du Vehicle avant lecture de disponibilité, même primitive que
  // createLocation (Sprint 26C, Finding C).
  const vehicleId = data.vehicleId ?? parent.vehicleId;
  const vehicle = await lockVehicleForUpdate(data.tenantId, vehicleId, tx);
  if (!vehicle) {
    throw new VehicleNotFoundError();
  }
  assertVehicleStatusAllowsLocation(vehicle);

  const availability = await checkAvailability(data.tenantId, vehicleId, startDate, data.endDate, undefined, tx);
  if (!availability?.available) {
    throw new VehicleNotAvailableError(availability?.conflictingLocations ?? []);
  }
  const conflictingMaintenances = await findConflictingMaintenances(vehicleId, startDate, data.endDate, undefined, tx);
  if (conflictingMaintenances.length > 0) {
    throw new VehicleMaintenanceConflictError(conflictingMaintenances);
  }

  // Client/second conducteur : toujours ceux du contrat parent — aucune des 12 règles validées
  // n'autorise un changement de client sur une prolongation, à la différence du véhicule et de
  // l'agence (DOMAINRULES.md section 60). La validité du permis jusqu'à la nouvelle date de
  // retour est revérifiée (elle ne l'était jusqu'ici qu'à la création du contrat initial) : une
  // prolongation repousse le retour, un permis valide pour le contrat parent peut ne plus l'être
  // pour sa date de retour repoussée.
  const client = await getClientById(data.tenantId, parent.clientId, tx);
  if (!client) {
    throw new ClientNotFoundError();
  }
  assertDriverLicenseCoversReturn(client, data.endDate);

  validateFuelLevel(data.startFuelLevel);
  validateFuelLevel(data.endFuelLevel);

  const pricePerDay = data.pricePerDay ?? vehicle.pricePerDay ?? undefined;
  if (pricePerDay === undefined) {
    throw new MissingPriceError();
  }
  const totalPrice = data.totalPrice ?? calculateTotalPrice(pricePerDay, startDate, data.endDate);

  // Étapes 11-14 : numérotation (réessai sur collision, mécanisme inchangé), création de la
  // Location, de sa facture RENTAL indépendante et de l'entrée d'audit — dans une seule
  // transaction (étape 15 : validée implicitement en retournant depuis prisma.$transaction).
  for (let attempt = 0; attempt < MAX_EXTENSION_NUMBER_ATTEMPTS; attempt++) {
    const contractNumber = await generateContractNumber(referenceAgencyId, tx);
    const savepoint = EXTENSION_NUMBER_SAVEPOINTS[attempt];
    await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
    try {
      // Statut ACTIVE dès la création (décision d'implémentation, non explicitement fournie par
      // le cadrage métier) : une prolongation porte sur un véhicule déjà en cours d'usage réel
      // par le même client (le contrat parent est ACTIVE, jamais retourné) — il n'existe aucune
      // étape de prise en charge/confirmation distincte à modéliser pour ce nouveau contrat,
      // contrairement à un contrat initial (PENDING -> CONFIRMED -> ACTIVE). Documenté ici
      // explicitement plutôt que silencieusement choisi (CLAUDE.md section 8) — à confirmer
      // par le propriétaire du projet si un besoin contraire apparaît.
      const location = await tx.location.create({
        data: {
          tenantId: data.tenantId,
          agencyId: referenceAgencyId,
          vehicleId,
          clientId: parent.clientId,
          secondDriverId: parent.secondDriverId,
          startDate,
          endDate: data.endDate,
          status: "ACTIVE",
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
          contractKind: "EXTENSION",
          parentLocationId: parent.id,
          rootLocationId: parent.rootLocationId ?? parent.id,
        },
      });
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);

      // Étape 13 : facture RENTAL indépendante, dans la même transaction — contrairement à
      // POST /api/locations (résiliente/hors transaction par choix documenté), l'exigence
      // explicite de ce sprint est une création atomique incluant la facture (DOMAINRULES.md
      // section 60, règle « chaque prolongation possède sa propre facture RENTAL »).
      const { invoice } = await getOrCreateMainInvoice(
        data.tenantId,
        location.id,
        { taxRate: data.taxRate, discountAmount: data.discountAmount },
        tx
      );

      // Étape 14 : audit, dans la même transaction — même principe que refundCreditNote
      // (src/lib/invoices.ts), première fonction du projet à exiger explicitement que l'audit et
      // l'écriture métier soient créés atomiquement ; logAction accepte un `tx` optionnel pour
      // ce cas précis.
      await logAction(
        {
          tenantId: data.tenantId,
          userId: data.userId,
          action: "location.extension_created",
          resource: "Location",
          resourceId: location.id,
          metadata: {
            parentLocationId: parent.id,
            rootLocationId: location.rootLocationId,
            agencyId: referenceAgencyId,
            vehicleId,
            vehicleChanged: vehicleId !== parent.vehicleId,
            agencyChanged: referenceAgencyId !== parent.agencyId,
            contractNumber: location.contractNumber,
            invoiceId: invoice.id,
          },
        },
        tx
      );

      return { location, invoice };
    } catch (error) {
      // Toute erreur qui n'est pas précisément une collision de numéro de contrat se propage
      // telle quelle (y compris une erreur de facturation/audit survenue après la création de la
      // Location ci-dessus) : la transaction entière sera annulée par Prisma à la sortie de ce
      // bloc, rollback complet garanti (aucune Location/Invoice/AuditLog partielle).
      if (!isContractNumberCollision(error)) {
        throw error;
      }
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      if (attempt === MAX_EXTENSION_NUMBER_ATTEMPTS - 1) {
        throw error;
      }
    }
  }

  throw new Error("Impossible de générer un numéro de contrat unique pour la prolongation.");
}

// -------------------------------------------------------------------------------------------
// Sprint technique 2 (DOMAINRULES.md section 60, règle 12) : affichage de la chaîne
// contractuelle et soldes consolidés — lecture seule, aucune écriture. Module réutilisé (pas
// dupliqué) : location-chains.ts est déjà le seul point du projet à connaître à la fois
// locations.ts et invoices.ts (cycle d'import documenté en tête de fichier), donc le point
// naturel pour agréger un solde qui traverse plusieurs Location d'une même chaîne.
// -------------------------------------------------------------------------------------------

/** Champs financiers agrégés pour un contrat (ou pour toute une chaîne, par simple addition —
 * jamais par soustraction globale, DOMAINRULES.md section 60). `totalInvoiced`/`totalPaid`/
 * `totalCredited`/`remainingBalance` réutilisent exactement getInvoiceNetAmounts (src/lib/
 * invoices.ts, déjà validée/testée) : aucune formule financière n'est réinventée ici.
 * `totalRefunded` est une information complémentaire, purement additive à l'affichage — jamais
 * soustraite de `remainingBalance` (qui reste la formule déjà en vigueur sur la fiche facture
 * individuelle, GET /api/invoices/[id]/InvoiceDetailPage : un paiement remboursé n'est jamais
 * réinjecté dans amountPaid, voir le commentaire de recomputeInvoiceStatus/adminCancelInvoice,
 * src/lib/payments.ts/invoices.ts — remainingBalance reste donc correct sans double comptage). */
export interface LocationBalanceTotals {
  /** Somme de Invoice.totalAmount sur toutes les factures RENTAL/SUPPLEMENT/EXTENSION du
   * contrat — CREDIT_NOTE volontairement exclue : un avoir n'est pas un montant facturé au
   * client, il réduit le solde net de sa facture source (déjà reflété dans totalCredited/
   * remainingBalance ci-dessous), le compter en plus doublerait artificiellement le total facturé. */
  totalInvoiced: number;
  /** Somme de Invoice.amountPaid — jamais recalculée différemment ici (une seule source de
   * vérité, recomputeInvoiceStatus, src/lib/payments.ts). */
  totalPaid: number;
  /** Somme de InvoiceNetAmounts.creditedAmount (avoirs actifs) sur les factures du contrat. */
  totalCredited: number;
  /** Remboursements réels déjà exécutés pour ce contrat : paiements marqués REFUNDED
   * (annulation admin d'une facture/d'un contrat validé, src/lib/invoices.ts/locations.ts) +
   * CashEntry de remboursement d'avoir (refundCreditNote, creditNoteId non nul). Deux mécanismes
   * disjoints (un avoir remboursé ne marque jamais un Payment REFUNDED, une annulation admin ne
   * crée jamais de CashEntry.creditNoteId) : aucun risque de double comptage entre les deux sommes. */
  totalRefunded: number;
  /** Somme de InvoiceNetAmounts.remainingBalance — solde individuel du contrat (ou solde
   * consolidé de la chaîne quand agrégée sur plusieurs contrats, voir getLocationChain). */
  remainingBalance: number;
}

export interface LocationBalance extends LocationBalanceTotals {
  currency: string;
  /** Nombre de factures RENTAL/SUPPLEMENT/EXTENSION prises en compte (CREDIT_NOTE exclue,
   * cohérent avec totalInvoiced ci-dessus) — permet à l'interface de distinguer « aucune facture »
   * de « facture(s) à solde nul ». */
  invoiceCount: number;
}

const EMPTY_AGGREGATE_SUM = { _sum: { amount: 0 as number | null } };

/**
 * Solde individuel d'un contrat (DOMAINRULES.md section 60, règle 12) — lit toutes les factures
 * (Invoice) de ce contrat, jamais une seule facture supposée unique (un contrat peut avoir
 * plusieurs factures RENTAL/SUPPLEMENT/EXTENSION, voir PROJECT_MAP.md). Réutilise
 * getInvoiceNetAmounts (src/lib/invoices.ts) facture par facture, jamais une formule dupliquée :
 * même principe que le reste du projet (une seule source de vérité par calcul financier).
 * `currency` est celle du contrat (Location.currency), fournie par l'appelant plutôt que
 * redéduite d'une facture qui pourrait ne pas exister (contrat sans facture — cas couvert).
 */
export async function getLocationBalance(
  tenantId: string,
  locationId: string,
  currency: string,
  tx: Prisma.TransactionClient = prisma
): Promise<LocationBalance> {
  const invoices = await tx.invoice.findMany({
    where: { tenantId, locationId },
    select: { id: true, type: true, totalAmount: true, amountPaid: true },
  });

  const receivables = invoices.filter((invoice) => invoice.type !== "CREDIT_NOTE");
  const creditNoteIds = invoices.filter((invoice) => invoice.type === "CREDIT_NOTE").map((invoice) => invoice.id);

  let totalInvoiced = 0;
  let totalPaid = 0;
  let totalCredited = 0;
  let remainingBalance = 0;
  for (const invoice of receivables) {
    const net = await getInvoiceNetAmounts(invoice, tx);
    totalInvoiced += invoice.totalAmount;
    totalPaid += invoice.amountPaid;
    totalCredited += net.creditedAmount;
    remainingBalance += net.remainingBalance;
  }

  const invoiceIds = receivables.map((invoice) => invoice.id);
  const [refundedPayments, creditNoteRefunds] = await Promise.all([
    invoiceIds.length
      ? tx.payment.aggregate({ where: { tenantId, invoiceId: { in: invoiceIds }, status: "REFUNDED" }, _sum: { amount: true } })
      : Promise.resolve(EMPTY_AGGREGATE_SUM),
    creditNoteIds.length
      ? tx.cashEntry.aggregate({ where: { tenantId, creditNoteId: { in: creditNoteIds } }, _sum: { amount: true } })
      : Promise.resolve(EMPTY_AGGREGATE_SUM),
  ]);
  const totalRefunded = (refundedPayments._sum.amount ?? 0) + (creditNoteRefunds._sum.amount ?? 0);

  return {
    currency,
    invoiceCount: receivables.length,
    totalInvoiced,
    totalPaid,
    totalCredited,
    totalRefunded,
    remainingBalance,
  };
}

/** Un maillon accessible de la chaîne, avec son solde individuel déjà calculé. Ne contient
 * jamais que des champs déjà visibles ailleurs sur une fiche contrat (aucune donnée nouvelle
 * exposée) : évite de dupliquer un DTO différent par écran pour la même ressource. */
export interface LocationChainNode {
  id: string;
  contractNumber: string | null;
  contractKind: Location["contractKind"];
  status: Location["status"];
  startDate: Date;
  endDate: Date;
  currency: string;
  totalPrice: number;
  agencyId: string;
  agencyName: string;
  vehicleId: string;
  vehicleLabel: string;
  parentLocationId: string | null;
  rootLocationId: string;
  isCurrent: boolean;
  balance: LocationBalance;
}

export interface LocationChainResult {
  /** Chaîne complète accessible, triée du plus ancien (racine) au plus récent — jamais un
   * contrat auquel l'utilisateur n'a pas accès (tenant + agence, canAccessLocationAgency). */
  nodes: LocationChainNode[];
  /** Nombre de contrats de la chaîne existant réellement mais filtrés (agence non accessible à
   * l'appelant) — jamais accompagné du moindre détail (id, numéro, dates, montants) sur CES
   * contrats précis : uniquement un compte agrégé, pour ne jamais révéler l'existence d'un
   * contrat précis auquel l'utilisateur n'a pas accès tout en restant honnête sur le fait que la
   * chaîne réelle peut être plus longue que ce qui est affiché. */
  hiddenCount: number;
  parent: LocationChainNode | null;
  /** true si le contrat courant a bien un parentLocationId mais que ce parent a été filtré
   * (agence non accessible) — permet à l'interface d'afficher « accès restreint » plutôt que
   * « aucun parent », sans jamais révéler la moindre donnée sur ce parent précis. */
  parentRestricted: boolean;
  /** null quand le contrat courant EST déjà la racine (root.id === current.id, cas normal d'un
   * contrat INITIAL) — l'interface ne doit alors pas répéter une seconde fois le même contrat. */
  root: LocationChainNode | null;
  rootRestricted: boolean;
  /** Prolongations directes accessibles (0 ou 1 en pratique, chaîne strictement linéaire —
   * @@unique(parentLocationId) — mais un tableau reste générique plutôt que de coder en dur
   * cette limite ailleurs que dans le schéma lui-même). */
  children: LocationChainNode[];
  hiddenChildrenCount: number;
  /** Solde consolidé de la chaîne accessible, groupé par devise (jamais sommé entre devises
   * différentes — un contrat de la chaîne peut changer d'agence donc potentiellement de devise,
   * DOMAINRULES.md section 60 règle 5) : addition stricte des soldes individuels des contrats
   * listés dans `nodes` ci-dessus, jamais une soustraction globale recalculée sur l'ensemble de
   * la chaîne (DOMAINRULES.md section 60, condition de conception explicite). Ne comprend
   * jamais un contrat filtré par `hiddenCount`/`hiddenChildrenCount` : resterait sinon
   * incohérent avec ce qui est effectivement listé et affiché à l'utilisateur. */
  consolidated: Record<string, LocationBalanceTotals & { contractCount: number }>;
}

/**
 * Chaîne contractuelle complète d'un contrat (DOMAINRULES.md section 60) — contrat courant,
 * parent, racine, prolongations directes, et l'ensemble ordonné de la chaîne avec le solde
 * individuel de chacun. `current` doit déjà avoir été chargé et son accès déjà vérifié par
 * l'appelant (même contrat que celui affiché par la page — jamais rechargé ici depuis un id
 * fourni par le client, voir GET /api/locations/[id]/route.ts pour l'équivalent déjà en place
 * sur le contrat seul). Chaque AUTRE contrat de la chaîne est revérifié individuellement
 * (tenantId, implicite via la requête filtrée ; agence, via canAccessLocationAgency) avant
 * d'être inclus : ne charge jamais un contrat lié par son seul identifiant.
 */
export async function getLocationChain(
  tenantId: string,
  user: SessionUser,
  current: Location,
  tx: Prisma.TransactionClient = prisma
): Promise<LocationChainResult> {
  const rootId = current.rootLocationId ?? current.id;

  // rootLocationId n'a pas de contrainte de clé étrangère inter-tenant explicite au niveau
  // schéma, mais le filtre tenantId ci-dessous garantit à lui seul l'isolation : un id de
  // Location est un cuid globalement unique, aucune Location d'un autre tenant ne peut donc
  // jamais correspondre à rootLocationId = rootId pour CE tenantId.
  const chainLocations = await tx.location.findMany({
    where: { tenantId, rootLocationId: rootId },
    orderBy: { startDate: "asc" },
  });

  const accessibleFlags = await Promise.all(
    chainLocations.map((location) =>
      location.id === current.id ? Promise.resolve(true) : canAccessLocationAgency(user, location)
    )
  );
  const accessibleLocations = chainLocations.filter((_, index) => accessibleFlags[index]);
  const hiddenCount = chainLocations.length - accessibleLocations.length;

  const agencyIds = Array.from(new Set(accessibleLocations.map((location) => location.agencyId)));
  const vehicleIds = Array.from(new Set(accessibleLocations.map((location) => location.vehicleId)));
  const [agencies, vehicles, balances] = await Promise.all([
    agencyIds.length
      ? tx.agency.findMany({ where: { id: { in: agencyIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    vehicleIds.length
      ? tx.vehicle.findMany({ where: { id: { in: vehicleIds } }, select: { id: true, name: true, licensePlate: true } })
      : Promise.resolve([]),
    Promise.all(accessibleLocations.map((location) => getLocationBalance(tenantId, location.id, location.currency, tx))),
  ]);
  const agencyNames = new Map(agencies.map((agency) => [agency.id, agency.name]));
  const vehicleLabels = new Map(vehicles.map((vehicle) => [vehicle.id, `${vehicle.name} (${vehicle.licensePlate})`]));

  const nodes: LocationChainNode[] = accessibleLocations.map((location, index) => ({
    id: location.id,
    contractNumber: location.contractNumber,
    contractKind: location.contractKind,
    status: location.status,
    startDate: location.startDate,
    endDate: location.endDate,
    currency: location.currency,
    totalPrice: location.totalPrice,
    agencyId: location.agencyId,
    agencyName: agencyNames.get(location.agencyId) ?? "—",
    vehicleId: location.vehicleId,
    vehicleLabel: vehicleLabels.get(location.vehicleId) ?? "—",
    parentLocationId: location.parentLocationId,
    rootLocationId: location.rootLocationId ?? location.id,
    isCurrent: location.id === current.id,
    balance: balances[index],
  }));

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parent = current.parentLocationId ? (byId.get(current.parentLocationId) ?? null) : null;
  const parentRestricted = current.parentLocationId !== null && !parent;
  // Sciemment null quand le contrat courant EST déjà la racine (rootId === current.id) : sans ce
  // cas particulier, byId.get(rootId) retrouverait le nœud courant lui-même (il figure toujours
  // dans `nodes`) et le dupliquerait sous `root`, ce que le commentaire de LocationChainResult.root
  // exclut explicitement.
  const root = rootId === current.id ? null : (byId.get(rootId) ?? null);
  const rootRestricted = rootId !== current.id && !root;
  const children = nodes.filter((node) => node.parentLocationId === current.id);
  const hiddenChildrenCount = chainLocations.filter(
    (location) => location.parentLocationId === current.id && !byId.has(location.id)
  ).length;

  const consolidated: Record<string, LocationBalanceTotals & { contractCount: number }> = {};
  for (const node of nodes) {
    const entry = consolidated[node.currency] ?? {
      totalInvoiced: 0,
      totalPaid: 0,
      totalCredited: 0,
      totalRefunded: 0,
      remainingBalance: 0,
      contractCount: 0,
    };
    entry.totalInvoiced += node.balance.totalInvoiced;
    entry.totalPaid += node.balance.totalPaid;
    entry.totalCredited += node.balance.totalCredited;
    entry.totalRefunded += node.balance.totalRefunded;
    entry.remainingBalance += node.balance.remainingBalance;
    entry.contractCount += 1;
    consolidated[node.currency] = entry;
  }

  return {
    nodes,
    hiddenCount,
    parent,
    parentRestricted,
    root,
    rootRestricted,
    children,
    hiddenChildrenCount,
    consolidated,
  };
}
