import type { CashEntry, Invoice, InvoiceStatus, InvoiceType, Payment, PaymentMethod, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getLocationById, lockLocationForUpdate } from "@/lib/locations";
import { createCorrectionCashEntry, createCashEntry, CorrectionReasonRequiredError } from "@/lib/cash-register";
import { logAction } from "@/lib/audit";

export { CorrectionReasonRequiredError };

/** taxRate est exprimé en points de base (ex. 2000 = 20,00 %), pas en pourcentage flottant. */
const TAX_RATE_BASIS = 10_000;

export class InvoiceLocationNotFoundError extends Error {
  constructor() {
    super("Location introuvable.");
    this.name = "InvoiceLocationNotFoundError";
  }
}

export class InvalidInvoiceAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInvoiceAmountError";
  }
}

export class InvoiceNotEditableError extends Error {
  constructor() {
    super("Seule une facture DRAFT peut voir son sous-total, sa TVA ou sa remise modifiés.");
    this.name = "InvoiceNotEditableError";
  }
}

export class InvalidInvoiceStatusTransitionError extends Error {
  constructor(from: InvoiceStatus, to: InvoiceStatus) {
    super(`Transition de statut invalide : ${from} → ${to}.`);
    this.name = "InvalidInvoiceStatusTransitionError";
  }
}

export class InvoiceNotDeletableError extends Error {
  constructor() {
    super("Seule une facture DRAFT sans paiement peut être supprimée ; sinon, annulez-la (status).");
    this.name = "InvoiceNotDeletableError";
  }
}

/**
 * Sprint 28 (Finding D2) : une facture PARTIALLY_PAID a au moins un Payment réel — l'annuler
 * directement via PATCH laisserait cet argent encaissé sans aucune trace de ce qu'il advient
 * (ni compensation de caisse, ni Payment marqué REFUNDED). Distincte de
 * LocationCancellationRequiresAdminError (src/lib/locations.ts, Sprint 23) : même principe
 * (une transition sensible avec réversibilité financière doit passer par une route dédiée
 * réservée ADMIN), appliqué ici au niveau facture plutôt que contrat. `ISSUED → VOID` sans
 * aucun Payment n'est pas concerné (rien à compenser) et reste inchangé via PATCH.
 */
export class InvoiceCancellationRequiresAdminError extends Error {
  constructor() {
    super(
      "Seul un administrateur peut annuler une facture PARTIALLY_PAID " +
        "(voir POST /api/invoices/[id]/admin-cancel)."
    );
    this.name = "InvoiceCancellationRequiresAdminError";
  }
}

/** Sprint 28 (Finding D2) : adminCancelInvoice n'accepte qu'une facture PARTIALLY_PAID — DRAFT
 * (rien à compenser, PATCH suffit), ISSUED sans paiement (idem), PAID (aucune transition manuelle
 * possible vers VOID, voir canTransition) et VOID (déjà terminale) sont refusées. */
export class InvoiceNotAdminCancellableError extends Error {
  constructor() {
    super(
      "Seule une facture PARTIALLY_PAID peut être annulée avec compensation " +
        "(DRAFT/ISSUED sans paiement s'annulent directement via PATCH ; PAID/VOID sont refusées)."
    );
    this.name = "InvoiceNotAdminCancellableError";
  }
}

/** Sprint 28 (Finding D2) : une autre requête a déjà annulé/modifié cette facture entre la
 * lecture et la réclamation atomique (verrou + updateMany conditionné, voir adminCancelInvoice)
 * — une seule annulation concurrente réussit, les autres reçoivent cette erreur (409). */
export class InvoiceAdminCancelConflictError extends Error {
  constructor() {
    super("Cette facture a déjà été annulée ou modifiée entretemps — réessayez.");
    this.name = "InvoiceAdminCancelConflictError";
  }
}

/**
 * Sprint 26E : versionnement documentaire d'une facture — jamais un avoir (pas de montant
 * négatif, pas de Payment négatif, aucun transfert de paiement). Seule une facture ISSUED sans
 * aucun Payment (compte réel, pas seulement amountPaid === 0 — voir versionInvoice) peut être
 * remplacée par une nouvelle version DRAFT.
 */
export class InvoiceNotVersionableError extends Error {
  constructor() {
    super(
      "Seule une facture ISSUED sans aucun paiement peut être versionnée " +
        "(DRAFT se modifie directement ; PARTIALLY_PAID/PAID/VOID sont refusées)."
    );
    this.name = "InvoiceNotVersionableError";
  }
}

/** Sprint 26E : motif obligatoire pour créer une nouvelle version — dupliqué localement
 * (même message que CorrectionReasonRequiredError, src/lib/payments.ts) pour ne jamais importer
 * payments.ts depuis invoices.ts (payments.ts importe déjà invoices.ts — un import inverse
 * créerait un cycle) et ne pas modifier payments.ts (Finding D1, hors périmètre de ce sprint). */
export class InvoiceVersionReasonRequiredError extends Error {
  constructor() {
    super("Un motif est obligatoire pour créer une nouvelle version d'une facture.");
    this.name = "InvoiceVersionReasonRequiredError";
  }
}

/**
 * Sprint 26E : une autre requête a déjà versionné/modifié cette facture entre la lecture et la
 * tentative de réclamation atomique (verrou + updateMany conditionné, voir versionInvoice) —
 * une seule création concurrente réussit, les autres reçoivent cette erreur (409).
 */
export class InvoiceVersionConflictError extends Error {
  constructor() {
    super("Cette facture a déjà été versionnée ou modifiée entretemps — réessayez.");
    this.name = "InvoiceVersionConflictError";
  }
}

/**
 * Transitions manuelles autorisées via PATCH. PARTIALLY_PAID et PAID ne sont jamais
 * atteints par une transition manuelle : ils sont dérivés automatiquement de la somme
 * des paiements (voir src/lib/payments.ts, recomputeInvoiceStatus) pour garantir que
 * amountPaid et status restent toujours cohérents.
 */
const ALLOWED_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  DRAFT: ["ISSUED", "VOID"],
  ISSUED: ["VOID"],
  PARTIALLY_PAID: ["VOID"],
  PAID: [],
  VOID: [],
  CREDIT_NOTE: [],
};

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface InvoiceTotals {
  taxAmount: number;
  totalAmount: number;
}

/**
 * totalAmount = subtotal - discountAmount + taxAmount, jamais négatif (une remise ne
 * peut pas dépasser subtotal + taxAmount). Règles d'arrondi au-delà de ceci : DOMAINRULES.md.
 */
export function computeInvoiceTotals(subtotal: number, taxRate: number, discountAmount: number): InvoiceTotals {
  const taxAmount = Math.round((subtotal * taxRate) / TAX_RATE_BASIS);
  const totalAmount = subtotal - discountAmount + taxAmount;

  if (totalAmount < 0) {
    throw new InvalidInvoiceAmountError("La remise ne peut pas dépasser le sous-total plus la TVA.");
  }

  return { taxAmount, totalAmount };
}

function validateAmountInputs(taxRate: number, discountAmount: number): void {
  if (!Number.isInteger(taxRate) || taxRate < 0) {
    throw new InvalidInvoiceAmountError("taxRate doit être un entier positif ou nul (points de base).");
  }
  if (!Number.isInteger(discountAmount) || discountAmount < 0) {
    throw new InvalidInvoiceAmountError("discountAmount doit être un entier positif ou nul.");
  }
}

/**
 * Génère un numéro de facture unique par tenant, au format INV-{année}-{5 chiffres},
 * ex. INV-2026-00001 — compteur basé sur le nombre de factures déjà émises cette année
 * pour ce tenant. Pas de table de séquence dédiée (À DÉCIDER si le volume l'exige) :
 * en cas de collision sous forte concurrence, createInvoice réessaie (voir plus bas).
 */
async function generateInvoiceNumber(
  tenantId: string,
  year: number,
  tx: Prisma.TransactionClient = prisma
): Promise<string> {
  const prefix = `INV-${year}-`;
  const count = await tx.invoice.count({
    where: { tenantId, number: { startsWith: prefix } },
  });
  return `${prefix}${String(count + 1).padStart(5, "0")}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export interface InvoiceFilters {
  status?: InvoiceStatus;
  agencyId?: string;
  clientId?: string;
  locationId?: string;
  from?: Date;
  to?: Date;
  /** Sprint 26E : masque les factures remplacées (celles ayant une version plus récente) —
   * filtre explicite, jamais appliqué par défaut (comportement de GET /api/invoices inchangé
   * pour tout appelant existant, dashboard/rapports/lots PDF compris). Voir InvoicesTable.tsx
   * pour le seul écran qui l'active aujourd'hui. Filtre sur la relation inverse `replacedBy`
   * (aucune colonne physique dupliquée — voir prisma/schema.prisma, Invoice.replacesInvoiceId). */
  excludeReplaced?: boolean;
}

export async function getInvoices(tenantId: string, filters: InvoiceFilters = {}): Promise<Invoice[]> {
  return prisma.invoice.findMany({
    where: {
      tenantId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.agencyId ? { agencyId: filters.agencyId } : {}),
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.locationId ? { locationId: filters.locationId } : {}),
      ...(filters.from ? { issuedAt: { gte: filters.from } } : {}),
      ...(filters.to ? { issuedAt: { lte: filters.to } } : {}),
      ...(filters.excludeReplaced ? { replacedBy: null } : {}),
    },
    orderBy: { issuedAt: "desc" },
  });
}

/** `tx` optionnel (Sprint 26A, Finding A) — voir le commentaire équivalent sur
 * `getReservationById`, src/lib/reservations.ts. */
export async function getInvoiceById(
  tenantId: string,
  invoiceId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<Invoice | null> {
  return tx.invoice.findFirst({ where: { id: invoiceId, tenantId } });
}

export interface CreateInvoiceInput {
  tenantId: string;
  locationId: string;
  taxRate?: number;
  discountAmount?: number;
  dueDate?: Date;
  notes?: string;
}

const MAX_NUMBER_GENERATION_ATTEMPTS = 5;

/**
 * `tx` optionnel (Sprint 26A, Finding A) — défaut au client Prisma global, comportement
 * inchangé pour tout appel sans transaction partagée (ex. POST /api/locations). Même limite
 * documentée que `createLocation` (src/lib/locations.ts) sur le réessai de numérotation :
 * désactivé à l'intérieur d'une transaction partagée explicite (une seule tentative).
 */
export async function createInvoice(
  data: CreateInvoiceInput,
  tx: Prisma.TransactionClient = prisma
): Promise<Invoice> {
  const taxRate = data.taxRate ?? 0;
  const discountAmount = data.discountAmount ?? 0;
  validateAmountInputs(taxRate, discountAmount);

  const location = await getLocationById(data.tenantId, data.locationId, tx);
  if (!location) {
    throw new InvoiceLocationNotFoundError();
  }

  const subtotal = location.totalPrice;
  const { taxAmount, totalAmount } = computeInvoiceTotals(subtotal, taxRate, discountAmount);
  const year = new Date().getFullYear();

  const allowRetry = tx === prisma;
  const maxAttempts = allowRetry ? MAX_NUMBER_GENERATION_ATTEMPTS : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const number = await generateInvoiceNumber(data.tenantId, year, tx);
    try {
      return await tx.invoice.create({
        data: {
          tenantId: data.tenantId,
          agencyId: location.agencyId,
          locationId: location.id,
          clientId: location.clientId,
          number,
          subtotal,
          taxRate,
          taxAmount,
          discountAmount,
          totalAmount,
          currency: location.currency,
          dueDate: data.dueDate,
          notes: data.notes,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error) && attempt < maxAttempts - 1) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Impossible de générer un numéro de facture unique.");
}

/** Statuts considérés comme "actifs" pour une facture RENTAL — au plus une seule par Location
 * (voir l'index unique partiel Invoice_one_active_rental_per_location, migration Sprint 13E
 * tâche 3). VOID/CREDIT_NOTE en sont exclus : une facture RENTAL annulée ne bloque plus la
 * création d'une nouvelle facture RENTAL active pour la même Location. */
const ACTIVE_RENTAL_STATUSES: InvoiceStatus[] = ["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID"];

/**
 * Vérifié empiriquement (pas supposé) : pour une violation de l'index unique partiel
 * `Invoice_one_active_rental_per_location` (créé par SQL brut, hors DSL Prisma — un index
 * partiel filtré par WHERE ne s'exprime pas comme `@@unique`), `error.meta.target` contient les
 * NOMS DE COLONNES de l'index (`["locationId"]`), jamais le nom de l'index lui-même — le nom de
 * l'index n'apparaît nulle part dans l'erreur Prisma. C'est ce tableau à une seule colonne
 * `["locationId"]` qui permet de le distinguer sans ambiguïté des deux autres contraintes
 * uniques d'Invoice : `@@unique([tenantId, number])` (numérotation, cible deux colonnes) et
 * `replacesInvoiceId @unique` (cible une autre colonne).
 */
function isActiveRentalIndexViolation(error: unknown): boolean {
  if (!isUniqueConstraintError(error)) {
    return false;
  }
  const target = (error as Prisma.PrismaClientKnownRequestError).meta?.target;
  if (typeof target === "string") {
    return target === "locationId";
  }
  if (Array.isArray(target)) {
    return target.length === 1 && target[0] === "locationId";
  }
  return false;
}

async function findActiveRentalInvoice(
  tenantId: string,
  locationId: string,
  tx: Prisma.TransactionClient
): Promise<Invoice | null> {
  return tx.invoice.findFirst({
    where: { tenantId, locationId, type: "RENTAL", status: { in: ACTIVE_RENTAL_STATUSES } },
  });
}

export interface GetOrCreateMainInvoiceResult {
  invoice: Invoice;
  /** false si une facture RENTAL active existait déjà (aucune écriture) — permet à l'appelant
   * HTTP de choisir 200 (récupérée) vs 201 (créée), voir POST /api/invoices. */
  created: boolean;
}

async function getOrCreateMainInvoiceLocked(
  tenantId: string,
  locationId: string,
  input: Omit<CreateInvoiceInput, "tenantId" | "locationId">,
  tx: Prisma.TransactionClient
): Promise<GetOrCreateMainInvoiceResult> {
  // Verrou tenant-scopé sur la Location, avant toute lecture décisionnelle — même primitive que
  // le reste du projet (lockInvoiceRow/lockDamageForUpdate/lockVehicleForUpdate), réutilisée ici
  // plutôt que dupliquée (invoices.ts importe déjà getLocationById du même module).
  const lockedLocation = await lockLocationForUpdate(tenantId, locationId, tx);
  if (!lockedLocation) {
    throw new InvoiceLocationNotFoundError();
  }

  const existing = await findActiveRentalInvoice(tenantId, locationId, tx);
  if (existing) {
    // Facture principale déjà active : retournée telle quelle, aucune écriture. C'est cette
    // ligne qui rend POST /api/locations et POST /api/invoices idempotents pour type RENTAL.
    return { invoice: existing, created: false };
  }

  try {
    // Réutilise createInvoice telle quelle (aucune modification) — type RENTAL par défaut
    // (Invoice.type @default(RENTAL) dans le schéma), numérotation/calculs inchangés. `tx` étant
    // partagé (jamais `=== prisma` ici), le réessai de numérotation de createInvoice est
    // désactivé (une seule tentative) — comportement déjà existant et documenté pour tout appel
    // depuis une transaction partagée (voir le commentaire sur `allowRetry` ci-dessus), pas une
    // nouvelle limitation introduite ici.
    const invoice = await createInvoice({ tenantId, locationId, ...input }, tx);
    return { invoice, created: true };
  } catch (error) {
    if (isActiveRentalIndexViolation(error)) {
      // Filet de sécurité : sous le verrou de ligne ci-dessus, une collision concurrente réelle
      // ne devrait jamais atteindre ce point (le verrou sérialise déjà tout appel concurrent sur
      // la même Location) — mais si l'index partiel est néanmoins celui qui a intercepté la
      // violation, la facture qui vient d'être créée par l'autre chemin est retournée telle
      // quelle : jamais l'erreur technique brute (P2002) exposée à l'appelant.
      const raceWinner = await findActiveRentalInvoice(tenantId, locationId, tx);
      if (raceWinner) {
        return { invoice: raceWinner, created: false };
      }
    }
    throw error;
  }
}

/**
 * Sprint 13E tâche 3 : garantit qu'une Location a au plus une facture RENTAL active
 * (DRAFT/ISSUED/PARTIALLY_PAID/PAID) — récupère la facture existante de façon strictement
 * idempotente (aucune écriture) plutôt que d'en créer une seconde. Double protection contre le
 * doublon, comme demandé explicitement : (1) verrou de ligne applicatif (SELECT ... FOR UPDATE
 * sur la Location, avant toute décision), (2) index unique partiel Postgres
 * (Invoice_one_active_rental_per_location) comme filet de sécurité — jamais l'un sans l'autre.
 *
 * `tx` optionnel : si fourni, réutilisé tel quel (l'appelant tient déjà une transaction — jamais
 * de transaction imbriquée, Prisma ne le permet pas) ; sinon, une transaction dédiée est ouverte
 * ici pour tenir le verrou pendant toute la durée de la décision, même convention `tx?` que
 * `createInvoice`/`getInvoiceById` (Sprint 26A, Finding A).
 */
export async function getOrCreateMainInvoice(
  tenantId: string,
  locationId: string,
  input: Omit<CreateInvoiceInput, "tenantId" | "locationId"> = {},
  tx?: Prisma.TransactionClient
): Promise<GetOrCreateMainInvoiceResult> {
  if (tx) {
    return getOrCreateMainInvoiceLocked(tenantId, locationId, input, tx);
  }
  return prisma.$transaction((innerTx) => getOrCreateMainInvoiceLocked(tenantId, locationId, input, innerTx));
}

/**
 * Sprint 13E tâche 3, sous-phase 2b : SUPPLEMENT/EXTENSION — factures additionnelles rattachées
 * à une Location, jamais soumises à la contrainte « une seule facture active » (propre à
 * RENTAL, voir getOrCreateMainInvoice ci-dessus). Montant (subtotal) toujours explicite, fourni
 * par l'appelant (amount) — aucune formule automatique (ni pricePerDay × jours, ni dérivé
 * d'extensionEndDate ou de toute autre donnée) : décision validée du propriétaire du projet, en
 * l'absence de règle métier sur le contenu détaillé d'une prolongation/d'une option (voir
 * DOMAINRULES.md section 17).
 */
export function validateSupplementaryAmount(amount: unknown): asserts amount is number {
  if (
    typeof amount !== "number" ||
    Number.isNaN(amount) ||
    !Number.isFinite(amount) ||
    !Number.isInteger(amount) ||
    amount <= 0
  ) {
    throw new InvalidInvoiceAmountError(
      "amount doit être un entier fini strictement positif (plus petite unité monétaire)."
    );
  }
}

export class InvalidSupplementKeyError extends Error {
  constructor() {
    super("supplementKey est obligatoire et ne peut pas être vide.");
    this.name = "InvalidSupplementKeyError";
  }
}

export class InvalidExtensionEndDateError extends Error {
  constructor() {
    super("extensionEndDate est obligatoire et doit être une date valide.");
    this.name = "InvalidExtensionEndDateError";
  }
}

/** Même valeur qu'ACTIVE_RENTAL_STATUSES (voir plus haut) mais délibérément dupliquée plutôt que
 * réutilisée/renommée — SUPPLEMENT/EXTENSION restent des fonctions strictement séparées de
 * RENTAL, y compris sur cette constante, pour ne courir aucun risque qu'un futur changement de
 * l'une affecte silencieusement l'autre. */
export const ACTIVE_SUPPLEMENTARY_STATUSES: InvoiceStatus[] = ["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID"];

/**
 * Normalisation unique de supplementKey (trim, aucune autre transformation — reste une clé
 * opaque fournie par l'appelant, jamais une valeur métier interprétée) — appliquée
 * identiquement à la recherche, à l'insertion et donc à l'idempotence, jamais une valeur
 * différente entre ces trois usages.
 */
function normalizeSupplementKey(supplementKey: string): string {
  return supplementKey.trim();
}

// ---------------------------------------------------------------------------------------------
// SUPPLEMENT
// ---------------------------------------------------------------------------------------------

export interface CreateSupplementInvoiceInput {
  tenantId: string;
  locationId: string;
  supplementKey: string;
  amount: number;
  taxRate?: number;
  discountAmount?: number;
  dueDate?: Date;
  notes?: string;
}

/**
 * Création directe (non idempotente) d'une facture SUPPLEMENT — jamais appelée directement par
 * une route, toujours via getOrCreateSupplementInvoice ci-dessous (même division des
 * responsabilités que createInvoice/getOrCreateMainInvoice). Duplique volontairement la boucle
 * de réessai de numérotation de createInvoice plutôt que d'y toucher : CreateInvoiceInput et
 * createInvoice restent strictement inchangées, comportement RENTAL non affecté.
 */
export async function createSupplementInvoice(
  data: CreateSupplementInvoiceInput,
  tx: Prisma.TransactionClient = prisma
): Promise<Invoice> {
  validateSupplementaryAmount(data.amount);
  const supplementKey = normalizeSupplementKey(data.supplementKey);
  if (!supplementKey) {
    throw new InvalidSupplementKeyError();
  }
  const taxRate = data.taxRate ?? 0;
  const discountAmount = data.discountAmount ?? 0;
  validateAmountInputs(taxRate, discountAmount);

  const location = await getLocationById(data.tenantId, data.locationId, tx);
  if (!location) {
    throw new InvoiceLocationNotFoundError();
  }

  const subtotal = data.amount;
  const { taxAmount, totalAmount } = computeInvoiceTotals(subtotal, taxRate, discountAmount);
  const year = new Date().getFullYear();

  const allowRetry = tx === prisma;
  const maxAttempts = allowRetry ? MAX_NUMBER_GENERATION_ATTEMPTS : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const number = await generateInvoiceNumber(data.tenantId, year, tx);
    try {
      return await tx.invoice.create({
        data: {
          tenantId: data.tenantId,
          agencyId: location.agencyId,
          locationId: location.id,
          clientId: location.clientId,
          number,
          type: "SUPPLEMENT",
          supplementKey,
          subtotal,
          taxRate,
          taxAmount,
          discountAmount,
          totalAmount,
          currency: location.currency,
          dueDate: data.dueDate,
          notes: data.notes,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error) && attempt < maxAttempts - 1) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Impossible de générer un numéro de facture unique.");
}

/**
 * Vérifié empiriquement (script de diagnostic temporaire, xrent_test, supprimé après usage) :
 * pour une violation de l'index unique partiel Invoice_one_active_supplement_per_key (2
 * colonnes), error.meta.target = ["locationId","supplementKey"] — même principe que l'index
 * RENTAL à 1 colonne (noms de colonnes, jamais le nom de l'index). Distingué sans ambiguïté de
 * l'index EXTENSION (colonnes différentes) et des deux autres contraintes uniques d'Invoice par
 * la comparaison exacte de l'ensemble des deux noms de colonnes.
 */
function isSupplementIndexViolation(error: unknown): boolean {
  if (!isUniqueConstraintError(error)) {
    return false;
  }
  const target = (error as Prisma.PrismaClientKnownRequestError).meta?.target;
  if (!Array.isArray(target)) {
    return false;
  }
  return target.length === 2 && target.includes("locationId") && target.includes("supplementKey");
}

async function findActiveSupplementInvoice(
  tenantId: string,
  locationId: string,
  supplementKey: string,
  tx: Prisma.TransactionClient
): Promise<Invoice | null> {
  return tx.invoice.findFirst({
    where: {
      tenantId,
      locationId,
      type: "SUPPLEMENT",
      supplementKey,
      status: { in: ACTIVE_SUPPLEMENTARY_STATUSES },
    },
  });
}

export interface GetOrCreateSupplementaryInvoiceResult {
  invoice: Invoice;
  /** false si une facture active existait déjà pour cette clé métier (aucune écriture) — permet
   * à l'appelant HTTP de choisir 200 (récupérée) vs 201 (créée). */
  created: boolean;
}

async function getOrCreateSupplementInvoiceLocked(
  tenantId: string,
  locationId: string,
  supplementKey: string,
  input: Omit<CreateSupplementInvoiceInput, "tenantId" | "locationId" | "supplementKey">,
  tx: Prisma.TransactionClient
): Promise<GetOrCreateSupplementaryInvoiceResult> {
  const normalizedKey = normalizeSupplementKey(supplementKey);
  if (!normalizedKey) {
    throw new InvalidSupplementKeyError();
  }

  // Verrou tenant-scopé sur la Location — même primitive que getOrCreateMainInvoice.
  const lockedLocation = await lockLocationForUpdate(tenantId, locationId, tx);
  if (!lockedLocation) {
    throw new InvoiceLocationNotFoundError();
  }

  const existing = await findActiveSupplementInvoice(tenantId, locationId, normalizedKey, tx);
  if (existing) {
    return { invoice: existing, created: false };
  }

  try {
    const invoice = await createSupplementInvoice(
      { tenantId, locationId, supplementKey: normalizedKey, ...input },
      tx
    );
    return { invoice, created: true };
  } catch (error) {
    if (isSupplementIndexViolation(error)) {
      const raceWinner = await findActiveSupplementInvoice(tenantId, locationId, normalizedKey, tx);
      if (raceWinner) {
        return { invoice: raceWinner, created: false };
      }
    }
    throw error;
  }
}

/**
 * Garantit qu'une Location a au plus une facture SUPPLEMENT active par supplementKey — jamais
 * acheminée par getOrCreateMainInvoice, jamais soumise à la contrainte « une seule facture
 * active » propre à RENTAL (plusieurs SUPPLEMENT distincts, à clés différentes, coexistent
 * librement sur une même Location). Double protection identique à RENTAL : verrou de ligne
 * applicatif puis index unique partiel Postgres (Invoice_one_active_supplement_per_key) en
 * filet de sécurité — jamais l'un sans l'autre. `tx` optionnel, même convention que
 * getOrCreateMainInvoice.
 */
export async function getOrCreateSupplementInvoice(
  tenantId: string,
  locationId: string,
  supplementKey: string,
  input: Omit<CreateSupplementInvoiceInput, "tenantId" | "locationId" | "supplementKey">,
  tx?: Prisma.TransactionClient
): Promise<GetOrCreateSupplementaryInvoiceResult> {
  if (tx) {
    return getOrCreateSupplementInvoiceLocked(tenantId, locationId, supplementKey, input, tx);
  }
  return prisma.$transaction((innerTx) =>
    getOrCreateSupplementInvoiceLocked(tenantId, locationId, supplementKey, input, innerTx)
  );
}

// ---------------------------------------------------------------------------------------------
// EXTENSION
// ---------------------------------------------------------------------------------------------

export interface CreateExtensionInvoiceInput {
  tenantId: string;
  locationId: string;
  extensionEndDate: Date;
  amount: number;
  taxRate?: number;
  discountAmount?: number;
  dueDate?: Date;
  notes?: string;
}

/** Voir createSupplementInvoice ci-dessus — même structure, jamais partagée avec elle ni avec
 * createInvoice (fonctions dédiées, comme demandé). */
export async function createExtensionInvoice(
  data: CreateExtensionInvoiceInput,
  tx: Prisma.TransactionClient = prisma
): Promise<Invoice> {
  validateSupplementaryAmount(data.amount);
  if (!(data.extensionEndDate instanceof Date) || Number.isNaN(data.extensionEndDate.getTime())) {
    throw new InvalidExtensionEndDateError();
  }
  const taxRate = data.taxRate ?? 0;
  const discountAmount = data.discountAmount ?? 0;
  validateAmountInputs(taxRate, discountAmount);

  const location = await getLocationById(data.tenantId, data.locationId, tx);
  if (!location) {
    throw new InvoiceLocationNotFoundError();
  }

  const subtotal = data.amount;
  const { taxAmount, totalAmount } = computeInvoiceTotals(subtotal, taxRate, discountAmount);
  const year = new Date().getFullYear();

  const allowRetry = tx === prisma;
  const maxAttempts = allowRetry ? MAX_NUMBER_GENERATION_ATTEMPTS : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const number = await generateInvoiceNumber(data.tenantId, year, tx);
    try {
      return await tx.invoice.create({
        data: {
          tenantId: data.tenantId,
          agencyId: location.agencyId,
          locationId: location.id,
          clientId: location.clientId,
          number,
          type: "EXTENSION",
          extensionEndDate: data.extensionEndDate,
          subtotal,
          taxRate,
          taxAmount,
          discountAmount,
          totalAmount,
          currency: location.currency,
          dueDate: data.dueDate,
          notes: data.notes,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error) && attempt < maxAttempts - 1) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Impossible de générer un numéro de facture unique.");
}

/** Vérifié empiriquement (même méthode que isSupplementIndexViolation ci-dessus) :
 * error.meta.target = ["locationId","extensionEndDate"] pour une violation de
 * Invoice_one_active_extension_per_end_date. */
function isExtensionIndexViolation(error: unknown): boolean {
  if (!isUniqueConstraintError(error)) {
    return false;
  }
  const target = (error as Prisma.PrismaClientKnownRequestError).meta?.target;
  if (!Array.isArray(target)) {
    return false;
  }
  return target.length === 2 && target.includes("locationId") && target.includes("extensionEndDate");
}

async function findActiveExtensionInvoice(
  tenantId: string,
  locationId: string,
  extensionEndDate: Date,
  tx: Prisma.TransactionClient
): Promise<Invoice | null> {
  return tx.invoice.findFirst({
    where: {
      tenantId,
      locationId,
      type: "EXTENSION",
      extensionEndDate,
      status: { in: ACTIVE_SUPPLEMENTARY_STATUSES },
    },
  });
}

async function getOrCreateExtensionInvoiceLocked(
  tenantId: string,
  locationId: string,
  extensionEndDate: Date,
  input: Omit<CreateExtensionInvoiceInput, "tenantId" | "locationId" | "extensionEndDate">,
  tx: Prisma.TransactionClient
): Promise<GetOrCreateSupplementaryInvoiceResult> {
  if (!(extensionEndDate instanceof Date) || Number.isNaN(extensionEndDate.getTime())) {
    throw new InvalidExtensionEndDateError();
  }

  const lockedLocation = await lockLocationForUpdate(tenantId, locationId, tx);
  if (!lockedLocation) {
    throw new InvoiceLocationNotFoundError();
  }

  const existing = await findActiveExtensionInvoice(tenantId, locationId, extensionEndDate, tx);
  if (existing) {
    return { invoice: existing, created: false };
  }

  try {
    const invoice = await createExtensionInvoice({ tenantId, locationId, extensionEndDate, ...input }, tx);
    return { invoice, created: true };
  } catch (error) {
    if (isExtensionIndexViolation(error)) {
      const raceWinner = await findActiveExtensionInvoice(tenantId, locationId, extensionEndDate, tx);
      if (raceWinner) {
        return { invoice: raceWinner, created: false };
      }
    }
    throw error;
  }
}

/**
 * Garantit qu'une Location n'a jamais deux factures EXTENSION actives visant exactement la même
 * date de retour cible (extensionEndDate) — clé provisoire et minimale (voir DOMAINRULES.md
 * section 17) : ne modélise pas un événement d'extension à part entière, ne distingue pas deux
 * opérations différentes visant accidentellement la même date, ne permet pas de reconstituer un
 * historique si la date est modifiée après coup. Jamais acheminée par getOrCreateMainInvoice, ni
 * soumise à la contrainte RENTAL. Double protection identique à SUPPLEMENT/RENTAL.
 */
export async function getOrCreateExtensionInvoice(
  tenantId: string,
  locationId: string,
  extensionEndDate: Date,
  input: Omit<CreateExtensionInvoiceInput, "tenantId" | "locationId" | "extensionEndDate">,
  tx?: Prisma.TransactionClient
): Promise<GetOrCreateSupplementaryInvoiceResult> {
  if (tx) {
    return getOrCreateExtensionInvoiceLocked(tenantId, locationId, extensionEndDate, input, tx);
  }
  return prisma.$transaction((innerTx) =>
    getOrCreateExtensionInvoiceLocked(tenantId, locationId, extensionEndDate, input, innerTx)
  );
}

// ---------------------------------------------------------------------------------------------
// CREDIT_NOTE (avoir) — Sprint 13E tâche 3, sous-phase 2c1
// ---------------------------------------------------------------------------------------------
//
// Un avoir référence une facture source (originalInvoiceId) sans jamais la modifier ni la
// remplacer (distinct du versionnement, Sprint 26E, qui remplace un document). Créé directement
// à status=CREDIT_NOTE (jamais DRAFT, pas de cycle de vie — garanti par la contrainte CHECK
// Invoice_credit_note_status_type_consistency, déjà en base depuis la migration 2a). Purement
// documentaire (B1) : ne touche jamais Payment ni CashEntry, ne déclenche aucun remboursement
// automatique — un remboursement réel est un acte distinct, hors périmètre de 2c1 (voir
// DOMAINRULES.md). Aucune idempotence par clé (un avoir est un document financier ponctuel,
// plusieurs avoirs distincts peuvent légitimement référencer la même source) — la seule
// protection est le plafond cumulatif ci-dessous, sous verrou de la source.

export class CreditNoteReasonRequiredError extends Error {
  constructor() {
    super("Un motif est obligatoire pour créer un avoir.");
    this.name = "CreditNoteReasonRequiredError";
  }
}

export class CreditNoteSourceNotFoundError extends Error {
  constructor() {
    super("Facture source introuvable.");
    this.name = "CreditNoteSourceNotFoundError";
  }
}

/** RENTAL/SUPPLEMENT/EXTENSION uniquement (C2) — jamais CREDIT_NOTE (pas d'avoir sur un avoir). */
export class CreditNoteSourceTypeNotEligibleError extends Error {
  constructor() {
    super("Seule une facture RENTAL, SUPPLEMENT ou EXTENSION peut recevoir un avoir.");
    this.name = "CreditNoteSourceTypeNotEligibleError";
  }
}

/** ISSUED/PARTIALLY_PAID/PAID uniquement — DRAFT (rien n'a encore été facturé formellement) et
 * VOID (déjà annulée) sont refusées. PAID est le cas d'usage principal : c'est le seul mécanisme
 * de réversibilité pour une facture intégralement soldée (voidInvoice ne couvre pas ce cas, voir
 * DOMAINRULES.md). */
export class CreditNoteSourceStatusNotEligibleError extends Error {
  constructor() {
    super("Seule une facture ISSUED, PARTIALLY_PAID ou PAID peut recevoir un avoir (DRAFT/VOID refusées).");
    this.name = "CreditNoteSourceStatusNotEligibleError";
  }
}

export class CreditNoteExceedsRemainingCreditError extends Error {
  constructor() {
    super("Le montant de l'avoir dépasse le montant encore créditable de la facture source.");
    this.name = "CreditNoteExceedsRemainingCreditError";
  }
}

const CREDIT_NOTE_ELIGIBLE_SOURCE_TYPES: InvoiceType[] = ["RENTAL", "SUPPLEMENT", "EXTENSION"];
const CREDIT_NOTE_ELIGIBLE_SOURCE_STATUSES: InvoiceStatus[] = ["ISSUED", "PARTIALLY_PAID", "PAID"];

/**
 * Sous-phase 2c2-D : même règle d'éligibilité que createCreditNoteAttempt ci-dessous, exportée
 * pour que l'UI (bouton "Créer un avoir") puisse la réutiliser telle quelle plutôt que de
 * dupliquer CREDIT_NOTE_ELIGIBLE_SOURCE_TYPES/STATUSES — l'affichage du bouton n'est qu'un
 * confort visuel, la route POST .../credit-notes revalide de toute façon les mêmes conditions
 * côté serveur.
 */
export function isCreditNoteEligibleSource(invoice: Pick<Invoice, "type" | "status">): boolean {
  return (
    CREDIT_NOTE_ELIGIBLE_SOURCE_TYPES.includes(invoice.type) &&
    CREDIT_NOTE_ELIGIBLE_SOURCE_STATUSES.includes(invoice.status)
  );
}

/**
 * Génère un numéro d'avoir unique par tenant, au format AV-{année}-{5 chiffres} — délibérément
 * distinct de INV-{année}-{5 chiffres} (generateInvoiceNumber) et du suffixe -AV{n} du
 * versionnement (Sprint 26E, qui désigne une "version", pas un "avoir" — même sigle, sens
 * différent, jamais réutilisé ici pour éviter toute ambiguïté). Compteur dédié, jamais partagé
 * avec la numérotation RENTAL.
 */
async function generateCreditNoteNumber(
  tenantId: string,
  year: number,
  tx: Prisma.TransactionClient
): Promise<string> {
  const prefix = `AV-${year}-`;
  const count = await tx.invoice.count({
    where: { tenantId, number: { startsWith: prefix } },
  });
  return `${prefix}${String(count + 1).padStart(5, "0")}`;
}

/**
 * Montant total déjà crédité pour une facture source, strictement limité aux avoirs actifs qui
 * la référencent : type=CREDIT_NOTE ET status=CREDIT_NOTE (toujours les deux ensemble, voir la
 * contrainte CHECK) ET originalInvoiceId=sourceId. Ne peut structurellement jamais sommer une
 * facture ordinaire (originalInvoiceId est toujours NULL sur une facture non-avoir) ni la source
 * elle-même (dont originalInvoiceId ne pointe jamais vers elle-même).
 */
export async function getTotalCreditedAmount(
  originalInvoiceId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<number> {
  const result = await tx.invoice.aggregate({
    where: { originalInvoiceId, type: "CREDIT_NOTE", status: "CREDIT_NOTE" },
    _sum: { totalAmount: true },
  });
  return result._sum.totalAmount ?? 0;
}

export interface CreateCreditNoteInput {
  tenantId: string;
  /** Dérivé par l'appelant (route) depuis la facture source, jamais fourni par le client HTTP —
   * revérifié ci-dessous contre source.locationId sous verrou (défense en profondeur, ne devrait
   * jamais échouer en usage normal, un seul appelant interne existant). */
  locationId: string;
  originalInvoiceId: string;
  amount: number;
  reason: string;
  notes?: string;
}

/**
 * Crée un avoir référençant originalInvoiceId, sous verrou de la source tenu jusqu'à la
 * validation de la transaction (SELECT ... FOR UPDATE via lockInvoiceRow, même primitive que
 * versionInvoice/adminCancelInvoice) — sérialise toute création concurrente d'avoirs référençant
 * la même source, garantissant qu'aucun cumul ne dépasse jamais source.totalAmount.
 *
 * Réessai de numérotation : contrairement à createInvoice/createSupplementInvoice/
 * createExtensionInvoice (qui ne réessaient qu'un INSERT isolé, jamais entre eux nested dans le
 * verrou — sans effet réel dans leurs propres chemins verrouillés, puisque PostgreSQL invalide
 * le reste d'une transaction après une violation de contrainte), createCreditNote réessaie ici
 * la transaction ENTIÈRE (verrou + calcul + insertion) quand aucune transaction partagée n'est
 * fournie par l'appelant — seule façon de retenter effectivement après une collision de numéro
 * (deux sources différentes, non sérialisées entre elles par le verrou de l'une) tout en gardant
 * le verrou tenu jusqu'à l'insertion à l'intérieur de chaque tentative. Si un `tx` partagé est
 * fourni (nested), une seule tentative est faite, comme le reste du fichier.
 */
export async function createCreditNote(data: CreateCreditNoteInput, tx?: Prisma.TransactionClient): Promise<Invoice> {
  if (tx) {
    return createCreditNoteAttempt(data, tx);
  }
  for (let attempt = 0; attempt < MAX_NUMBER_GENERATION_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction((innerTx) => createCreditNoteAttempt(data, innerTx));
    } catch (error) {
      if (isUniqueConstraintError(error) && attempt < MAX_NUMBER_GENERATION_ATTEMPTS - 1) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Impossible de générer un numéro d'avoir unique.");
}

async function createCreditNoteAttempt(data: CreateCreditNoteInput, tx: Prisma.TransactionClient): Promise<Invoice> {
  const reason = data.reason.trim();
  if (!reason) {
    throw new CreditNoteReasonRequiredError();
  }
  validateSupplementaryAmount(data.amount);

  const source = await lockInvoiceRow(data.tenantId, data.originalInvoiceId, tx);
  if (!source || data.locationId !== source.locationId) {
    throw new CreditNoteSourceNotFoundError();
  }
  if (!CREDIT_NOTE_ELIGIBLE_SOURCE_TYPES.includes(source.type)) {
    throw new CreditNoteSourceTypeNotEligibleError();
  }
  if (!CREDIT_NOTE_ELIGIBLE_SOURCE_STATUSES.includes(source.status)) {
    throw new CreditNoteSourceStatusNotEligibleError();
  }

  // A1 : plafond cumulatif, calculé sous le verrou ci-dessus — deux appels concurrents référençant
  // la même source sont sérialisés, jamais de dépassement possible.
  const alreadyCredited = await getTotalCreditedAmount(source.id, tx);
  const remainingCredit = source.totalAmount - alreadyCredited;
  if (data.amount > remainingCredit) {
    throw new CreditNoteExceedsRemainingCreditError();
  }

  const year = new Date().getFullYear();
  const number = await generateCreditNoteNumber(data.tenantId, year, tx);

  // La source n'est jamais modifiée : aucun tx.invoice.update sur source.id, aucune écriture sur
  // Payment/CashEntry — seule une nouvelle ligne CREDIT_NOTE est insérée.
  return tx.invoice.create({
    data: {
      tenantId: data.tenantId,
      agencyId: source.agencyId,
      locationId: source.locationId,
      clientId: source.clientId,
      number,
      type: "CREDIT_NOTE",
      status: "CREDIT_NOTE",
      originalInvoiceId: source.id,
      reason,
      notes: data.notes,
      subtotal: data.amount,
      taxRate: 0,
      taxAmount: 0,
      discountAmount: 0,
      totalAmount: data.amount,
      currency: source.currency,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Montants dérivés (net/solde) — Sprint 13E tâche 3, sous-phase 2c2-A
// ---------------------------------------------------------------------------------------------
// Ces valeurs ne sont jamais stockées (aucune colonne persistée) : toujours recalculées à partir
// de source.totalAmount/amountPaid et des CREDIT_NOTE existants (getTotalCreditedAmount, déjà
// exportée en 2c1) — même principe que amountPaid/status (recomputeInvoiceStatus,
// src/lib/payments.ts) : une seule source de vérité, jamais une valeur dérivée dupliquée en base.
// S'applique uniquement au modèle Invoice (RENTAL/SUPPLEMENT/EXTENSION/CREDIT_NOTE) — DamageInvoice
// est un modèle Prisma entièrement distinct, jamais référencé ici, structurellement hors périmètre.
//
// Terminologie corrigée explicitement par le propriétaire du projet (2c2 LOT 1, correction 1) :
// aucun champ de ce module ne doit laisser croire qu'un remboursement est suivi ou possible dans
// ce lot. `creditedCollectedAmount` (ex-`refundableAmount`) n'est PAS un montant remboursable —
// c'est uniquement la part des avoirs qui correspond à une somme déjà encaissée, une lecture
// prospective sans aucun suivi de remboursement réel (aucun `totalRefunded`, aucune table, aucun
// champ ne l'enregistre — 2c2-C, non commencé). Ne jamais l'afficher comme « montant remboursable »
// dans une interface ou un export tant que 2c2-C n'existe pas.

export interface InvoiceNetAmounts {
  /** Somme des CREDIT_NOTE actifs référençant cette facture (voir getTotalCreditedAmount). */
  creditedAmount: number;
  /** max(0, totalAmount - creditedAmount) — jamais négatif même si creditedAmount dépassait
   * totalAmount (structurellement impossible aujourd'hui, le plafond de createCreditNote
   * l'empêche déjà, mais la formule reste défensive). */
  netAmount: number;
  /** max(0, netAmount - amountPaid) — solde restant dû après avoirs. Couvre explicitement le
   * sur-encaissement historique (amountPaid déjà supérieur au nouveau netAmount après un avoir
   * émis a posteriori) : ramené à 0, jamais négatif — aucun paiement n'est jamais annulé ni
   * aucun remboursement déclenché ici, voir DOMAINRULES.md section 56. */
  remainingBalance: number;
  /**
   * max(0, min(creditedAmount, amountPaid)) — PAS un montant remboursable : aucun `totalRefunded`
   * n'existe dans ce lot (aucun remboursement n'est stocké ni calculé, 2c2-C non commencé), donc
   * rien n'est jamais déduit ici. Représente uniquement la part des avoirs déjà émis qui
   * correspond à une somme réellement encaissée — une information prospective en lecture seule,
   * jamais utilisée pour déclencher un mouvement financier, jamais exposée comme « remboursable »
   * dans une interface/un export tant que 2c2-C n'existe pas.
   */
  creditedCollectedAmount: number;
}

/**
 * Calcul pur, déterministe, sans accès base — reçoit des montants déjà connus de l'appelant
 * (jamais de dérive possible entre deux appels avec les mêmes entrées). Toujours des entiers
 * (plus petite unité monétaire), jamais de division/arrondi flottant.
 */
export function computeInvoiceNetAmounts(
  totalAmount: number,
  amountPaid: number,
  creditedAmount: number
): InvoiceNetAmounts {
  const netAmount = Math.max(0, totalAmount - creditedAmount);
  const remainingBalance = Math.max(0, netAmount - amountPaid);
  const creditedCollectedAmount = Math.max(0, Math.min(creditedAmount, amountPaid));
  return { creditedAmount, netAmount, remainingBalance, creditedCollectedAmount };
}

/**
 * Variante pratique de computeInvoiceNetAmounts ci-dessus : lit creditedAmount depuis la base
 * (getTotalCreditedAmount, tenant implicitement garanti par l'appelant — reçoit une facture déjà
 * chargée/verrouillée dans son tenant, jamais un id brut non vérifié) plutôt que de l'exiger en
 * paramètre. Réutilisable par createPayment/createMixedPayments (src/lib/payments.ts), les
 * rapports et les exports (src/lib/reports.ts/exports.ts) sans dupliquer l'agrégation.
 * `tx` optionnel, même convention que getTotalCreditedAmount/getInvoiceById.
 */
export async function getInvoiceNetAmounts(
  invoice: Pick<Invoice, "id" | "totalAmount" | "amountPaid">,
  tx: Prisma.TransactionClient = prisma
): Promise<InvoiceNetAmounts> {
  const creditedAmount = await getTotalCreditedAmount(invoice.id, tx);
  return computeInvoiceNetAmounts(invoice.totalAmount, invoice.amountPaid, creditedAmount);
}

// ---------------------------------------------------------------------------------------------
// Remboursement d'un avoir (refundCreditNote) — Sprint 13E tâche 3, sous-phase 2c2-C
// ---------------------------------------------------------------------------------------------
// Action strictement distincte de createCreditNote (2c1) : jamais appelée depuis elle, jamais un
// paramètre refundImmediately. La création d'un avoir ne déclenche toujours aucun remboursement,
// ne crée toujours aucune CashEntry, ne modifie toujours ni Payment ni Invoice.amountPaid — ce
// module ne change rien à ce comportement déjà acté (2c2 LOT 1).

export class CreditNoteRefundReasonRequiredError extends Error {
  constructor() {
    super("Un motif est obligatoire pour rembourser un avoir.");
    this.name = "CreditNoteRefundReasonRequiredError";
  }
}

export class CreditNoteNotFoundError extends Error {
  constructor() {
    super("Avoir introuvable.");
    this.name = "CreditNoteNotFoundError";
  }
}

export class InvoiceIsNotCreditNoteError extends Error {
  constructor() {
    super("Seul un avoir (CREDIT_NOTE) peut faire l'objet d'un remboursement.");
    this.name = "InvoiceIsNotCreditNoteError";
  }
}

/** Réutilisée pour "la facture source d'un avoir a disparu" — devrait être structurellement
 * impossible (FK Restrict sur Invoice.originalInvoiceId), gardée en défense en profondeur. */
export class CreditNoteSourceMissingError extends Error {
  constructor() {
    super("Facture source de l'avoir introuvable.");
    this.name = "CreditNoteSourceMissingError";
  }
}

export class CreditNoteExceedsRefundableAmountError extends Error {
  constructor() {
    super("Le montant dépasse le montant encore remboursable de cet avoir.");
    this.name = "CreditNoteExceedsRefundableAmountError";
  }
}

/**
 * Sprint 13E tâche 3, sous-phase 2c2-C — bug réel trouvé pendant la revue corrective précédant
 * le commit (pas une extension de périmètre) : `adminCancelInvoice` fait passer une facture
 * PARTIALLY_PAID à VOID et marque ses Payment REFUNDED, mais ne réinitialise JAMAIS
 * `Invoice.amountPaid` (seul `status` est modifié — voir adminCancelInvoice ci-dessous). Sans
 * cette garde, un avoir déjà émis AVANT l'admin-cancel de sa source resterait remboursable
 * après coup en se basant sur cet `amountPaid` désormais obsolète — alors que l'argent a déjà
 * été repris via la compensation de caisse d'adminCancelInvoice — un double remboursement réel.
 * Refusé catégoriquement, indépendamment du montant demandé.
 */
export class CreditNoteSourceVoidError extends Error {
  constructor() {
    super("Impossible de rembourser un avoir dont la facture source est déjà annulée (VOID).");
    this.name = "CreditNoteSourceVoidError";
  }
}

/**
 * Somme des CashEntry de remboursement (type=EXPENSE, category=REMBOURSEMENT_AVOIR) déjà liées à
 * CET avoir précis — jamais aux autres avoirs de la même source (voir getTotalRefundedForSource
 * ci-dessous pour l'agrégat côté source). Structurellement hors de portée de DamageInvoice
 * (CashEntry.creditNoteId ne référence jamais qu'un Invoice de type CREDIT_NOTE).
 */
async function getTotalRefundedForCreditNote(
  creditNoteId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<number> {
  const result = await tx.cashEntry.aggregate({
    where: { creditNoteId, type: "EXPENSE", category: "REMBOURSEMENT_AVOIR" },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

/**
 * Somme des CashEntry de remboursement déjà liées à N'IMPORTE LEQUEL des avoirs actifs de cette
 * facture source — nécessaire car source.amountPaid est un plafond PARTAGÉ entre tous les avoirs
 * d'une même source (deux avoirs distincts sur la même source ne peuvent jamais faire rembourser,
 * ensemble, plus que ce qui a réellement été encaissé sur cette source). Sans cet agrégat
 * partagé, deux avoirs individuellement sous leur propre plafond pourraient, cumulés, dépasser
 * source.amountPaid.
 */
async function getTotalRefundedForSource(sourceInvoiceId: string, tx: Prisma.TransactionClient = prisma): Promise<number> {
  const result = await tx.cashEntry.aggregate({
    where: {
      type: "EXPENSE",
      category: "REMBOURSEMENT_AVOIR",
      creditNote: { originalInvoiceId: sourceInvoiceId },
    },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

export interface CreditNoteRefundableAmount {
  /** Plafond réel pour CET avoir précis, à cet instant (sous verrou lors d'un remboursement). */
  refundableAmount: number;
  totalRefundedForCreditNote: number;
  totalRefundedForSource: number;
}

/**
 * Calcule le montant encore remboursable d'un avoir précis :
 *   availableFromCollected = max(0, source.amountPaid - totalRefundedForSource)
 *   refundableAmount = max(0, min(creditNote.totalAmount - totalRefundedForCreditNote, availableFromCollected))
 * `availableFromCollected` est le solde partagé entre tous les avoirs de la source (voir
 * getTotalRefundedForSource ci-dessus) — jamais uniquement `source.amountPaid` seul, qui
 * permettrait un sur-remboursement agrégé si la source porte plusieurs avoirs actifs.
 */
export async function getCreditNoteRefundableAmount(
  creditNote: Pick<Invoice, "id" | "totalAmount" | "originalInvoiceId">,
  source: Pick<Invoice, "amountPaid">,
  tx: Prisma.TransactionClient = prisma
): Promise<CreditNoteRefundableAmount> {
  // originalInvoiceId n'est garanti non-null que par l'application (createCreditNote), jamais
  // par une contrainte CHECK en base (voir prisma/schema.prisma) — revérifié explicitement
  // plutôt qu'une assertion muette, cohérent avec le principe de ne jamais faire confiance à une
  // seule couche pour un invariant financier.
  if (!creditNote.originalInvoiceId) {
    throw new CreditNoteSourceMissingError();
  }
  const totalRefundedForCreditNote = await getTotalRefundedForCreditNote(creditNote.id, tx);
  const totalRefundedForSource = await getTotalRefundedForSource(creditNote.originalInvoiceId, tx);
  const availableFromCollected = Math.max(0, source.amountPaid - totalRefundedForSource);
  const refundableAmount = Math.max(
    0,
    Math.min(creditNote.totalAmount - totalRefundedForCreditNote, availableFromCollected)
  );
  return { refundableAmount, totalRefundedForCreditNote, totalRefundedForSource };
}

export interface RefundCreditNoteInput {
  tenantId: string;
  creditNoteId: string;
  amount: number;
  reason: string;
  performedByUserId: string;
  paymentMethod?: PaymentMethod;
}

export interface RefundCreditNoteResult {
  creditNote: Invoice;
  cashEntry: CashEntry;
}

/**
 * Rembourse tout ou partie d'un avoir déjà émis — action financière réelle et distincte de
 * createCreditNote : crée exactement une CashEntry EXPENSE (catégorie REMBOURSEMENT_AVOIR),
 * liée à l'avoir via creditNoteId, jamais via paymentId (réservé aux paiements réels). Ne
 * modifie jamais Payment.status (réservé à adminCancelInvoice/adminCancelValidatedLocation, un
 * mécanisme différent), ne modifie jamais Invoice.amountPaid (ni de l'avoir, ni de la source).
 *
 * Concurrence : verrou de ligne sur la facture SOURCE (lockInvoiceRow, jamais sur l'avoir seul)
 * — nécessaire car le plafond réel est partagé entre tous les avoirs d'une même source (voir
 * getTotalRefundedForSource) : verrouiller uniquement l'avoir ciblé ne sérialiserait pas deux
 * remboursements concurrents visant deux avoirs DIFFÉRENTS de la même source, qui pourraient
 * alors dépasser ensemble source.amountPaid. Le verrou étant posé avant toute lecture
 * décisionnelle et tenu jusqu'à la validation de la transaction, deux remboursements concurrents
 * sur la même source (même avoir ou avoirs différents) sont entièrement sérialisés par
 * PostgreSQL — aucun réessai n'est nécessaire ici (contrairement à la collision de numérotation
 * de createCreditNote, qui impliquait deux lignes non verrouillées l'une contre l'autre).
 *
 * Idempotence : aucune clé dédiée (un second remboursement identique est simplement revalidé
 * contre le plafond déjà réduit par le premier — refusé si le plafond est atteint, accepté sinon
 * comme un nouveau remboursement partiel légitime).
 *
 * Audit : écrit dans la MÊME transaction que la CashEntry (logAction reçoit `tx` explicitement,
 * voir src/lib/audit.ts) — une erreur d'audit fait échouer tout le remboursement, jamais une
 * CashEntry orpheline sans trace.
 */
export async function refundCreditNote(
  data: RefundCreditNoteInput,
  tx?: Prisma.TransactionClient
): Promise<RefundCreditNoteResult> {
  if (tx) {
    return refundCreditNoteLocked(data, tx);
  }
  return prisma.$transaction((innerTx) => refundCreditNoteLocked(data, innerTx));
}

async function refundCreditNoteLocked(
  data: RefundCreditNoteInput,
  tx: Prisma.TransactionClient
): Promise<RefundCreditNoteResult> {
  const reason = data.reason.trim();
  if (!reason) {
    throw new CreditNoteRefundReasonRequiredError();
  }
  validateSupplementaryAmount(data.amount);

  // L'avoir lui-même est immuable après création (aucun chemin ne le modifie jamais) — une
  // lecture non verrouillée de ses propres colonnes est donc sûre ; seule la facture SOURCE a
  // besoin d'être verrouillée (voir le commentaire de refundCreditNote ci-dessus).
  const creditNote = await tx.invoice.findFirst({ where: { id: data.creditNoteId, tenantId: data.tenantId } });
  if (!creditNote) {
    throw new CreditNoteNotFoundError();
  }
  if (creditNote.type !== "CREDIT_NOTE") {
    throw new InvoiceIsNotCreditNoteError();
  }
  if (!creditNote.originalInvoiceId) {
    throw new CreditNoteSourceMissingError();
  }

  const source = await lockInvoiceRow(data.tenantId, creditNote.originalInvoiceId, tx);
  if (!source) {
    throw new CreditNoteSourceMissingError();
  }
  // Voir CreditNoteSourceVoidError ci-dessus : ferme un double remboursement réel possible via
  // adminCancelInvoice (qui ne réinitialise jamais amountPaid). Vérifié après le verrou, donc
  // jamais périmé par une annulation concurrente entre la lecture et cette vérification.
  if (source.status === "VOID") {
    throw new CreditNoteSourceVoidError();
  }

  const { refundableAmount } = await getCreditNoteRefundableAmount(creditNote, source, tx);
  if (data.amount > refundableAmount) {
    throw new CreditNoteExceedsRefundableAmountError();
  }

  const location = await tx.location.findUnique({ where: { id: creditNote.locationId } });

  const cashEntry = await createCashEntry(
    {
      tenantId: data.tenantId,
      type: "EXPENSE",
      category: "REMBOURSEMENT_AVOIR",
      amount: data.amount,
      description: `Remboursement avoir ${creditNote.number} (facture source ${source.number})`,
      agencyId: creditNote.agencyId,
      contractId: creditNote.locationId,
      contractNumber: location?.contractNumber ?? null,
      paymentMethod: data.paymentMethod,
      creditNoteId: creditNote.id,
      reason,
      performedByUserId: data.performedByUserId,
    },
    tx
  );

  await logAction(
    {
      tenantId: data.tenantId,
      userId: data.performedByUserId,
      action: "invoice.credit_note_refunded",
      resource: "Invoice",
      resourceId: creditNote.id,
      metadata: {
        creditNoteId: creditNote.id,
        sourceInvoiceId: source.id,
        amount: data.amount,
        cashEntryId: cashEntry.id,
        reason,
        actorId: data.performedByUserId,
        tenantId: data.tenantId,
      } as unknown as Prisma.InputJsonValue,
    },
    tx
  );

  return { creditNote, cashEntry };
}

export interface CreditNoteSummaryItem {
  id: string;
  number: string;
  totalAmount: number;
  reason: string | null;
  createdAt: Date;
  currency: string;
  /** Somme des CashEntry de remboursement déjà liées à CET avoir (voir getCreditNoteRefundableAmount). */
  refundedAmount: number;
  /** Montant encore remboursable pour CET avoir, à cet instant — plafond partagé avec les
   * autres avoirs de la même source (voir getCreditNoteRefundableAmount). */
  refundableAmount: number;
}

/**
 * Sous-phase 2c2-D : liste des avoirs actifs (type=CREDIT_NOTE, status=CREDIT_NOTE) référençant
 * une facture source, chacun avec son statut de remboursement dérivé — même formule que
 * getCreditNoteRefundableAmount ci-dessus, jamais recalculée différemment ici. Réutilisée à la
 * fois par GET /api/invoices/[id] (Phase 2) et par la page de détail (Server Component,
 * src/app/dashboard/invoices/[id]/page.tsx) pour ne jamais dupliquer cette agrégation.
 * Retourne un tableau vide si sourceInvoiceId ne correspond à aucune facture de ce tenant.
 */
export async function getCreditNotesForSource(
  tenantId: string,
  sourceInvoiceId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<CreditNoteSummaryItem[]> {
  const source = await tx.invoice.findFirst({ where: { id: sourceInvoiceId, tenantId } });
  if (!source) {
    return [];
  }

  const creditNotes = await tx.invoice.findMany({
    where: { tenantId, originalInvoiceId: sourceInvoiceId, type: "CREDIT_NOTE", status: "CREDIT_NOTE" },
    orderBy: { createdAt: "asc" },
  });

  const items: CreditNoteSummaryItem[] = [];
  for (const creditNote of creditNotes) {
    const { refundableAmount, totalRefundedForCreditNote } = await getCreditNoteRefundableAmount(
      creditNote,
      source,
      tx
    );
    items.push({
      id: creditNote.id,
      number: creditNote.number,
      totalAmount: creditNote.totalAmount,
      reason: creditNote.reason,
      createdAt: creditNote.createdAt,
      currency: creditNote.currency,
      refundedAmount: totalRefundedForCreditNote,
      refundableAmount,
    });
  }
  return items;
}

export interface UpdateInvoiceInput {
  status?: InvoiceStatus;
  taxRate?: number;
  discountAmount?: number;
  dueDate?: Date | null;
  notes?: string;
}

/** `tx` optionnel (Finding F) — permet d'appeler la finalisation DRAFT → ISSUED depuis une
 * transaction partagée (voir `processLocationPayment`, src/lib/location-payment.ts), même
 * convention que `createInvoice`/`getInvoiceById` (Sprint 26A, Finding A). Comportement
 * inchangé pour tout appel sans transaction partagée (ex. PATCH /api/invoices/[id]). */
export async function updateInvoice(
  tenantId: string,
  invoiceId: string,
  data: UpdateInvoiceInput,
  tx: Prisma.TransactionClient = prisma
): Promise<Invoice | null> {
  const existing = await getInvoiceById(tenantId, invoiceId, tx);
  if (!existing) {
    return null;
  }

  // Sprint 28 (Finding D2) : une facture PARTIALLY_PAID a un Payment réel — son annulation
  // doit passer par POST /api/invoices/[id]/admin-cancel (adminCancelInvoice ci-dessous), qui
  // orchestre la compensation de caisse et le remboursement des Payment dans une transaction
  // unique. ISSUED → VOID (aucun Payment, voir Finding F) reste inconditionnel ci-dessous,
  // comportement inchangé.
  if (data.status === "VOID" && existing.status === "PARTIALLY_PAID") {
    throw new InvoiceCancellationRequiresAdminError();
  }

  const wantsAmountChange = data.taxRate !== undefined || data.discountAmount !== undefined;
  if (wantsAmountChange && existing.status !== "DRAFT") {
    throw new InvoiceNotEditableError();
  }

  if (data.status && data.status !== existing.status && !canTransition(existing.status, data.status)) {
    throw new InvalidInvoiceStatusTransitionError(existing.status, data.status);
  }

  const taxRate = data.taxRate ?? existing.taxRate;
  const discountAmount = data.discountAmount ?? existing.discountAmount;
  if (wantsAmountChange) {
    validateAmountInputs(taxRate, discountAmount);
  }
  const { taxAmount, totalAmount } = wantsAmountChange
    ? computeInvoiceTotals(existing.subtotal, taxRate, discountAmount)
    : { taxAmount: existing.taxAmount, totalAmount: existing.totalAmount };

  // Finding F (Sprint 26F) : la finalisation manuelle ou automatique (DRAFT → ISSUED) est
  // désormais inconditionnelle vis-à-vis du solde — ISSUED signifie « facture verrouillée, en
  // attente de paiement », pas « soldée » (voir DOMAINRULES.md). Le gate Sprint 26D
  // (InvoiceNotFullyPaidError) rendait ISSUED structurellement inatteignable puisque
  // recomputeInvoiceStatus (src/lib/payments.ts, Finding B, inchangée) fait déjà passer une
  // facture directement de DRAFT à PARTIALLY_PAID/PAID dès le premier paiement — retiré sur
  // décision explicite du propriétaire du projet.

  // Une facture à 0 (remise à 100 %) n'a par construction jamais de Payment (createPayment
  // refuse tout montant contre un solde restant nul) : recomputeInvoiceStatus
  // (src/lib/payments.ts) ne s'exécute donc jamais pour elle, et elle resterait sinon
  // indéfiniment ISSUED malgré un solde déjà nul (bug réel, Sprint 18 — pilote terrain :
  // location offerte/remise commerciale intégrale). Au moment où elle est effectivement
  // finalisée (DRAFT → ISSUED), un total nul la fait donc atterrir directement en PAID.
  const resolvedStatus = data.status === "ISSUED" && totalAmount === 0 ? "PAID" : data.status;

  return tx.invoice.update({
    where: { id: invoiceId },
    data: {
      ...(resolvedStatus ? { status: resolvedStatus } : {}),
      taxRate,
      discountAmount,
      taxAmount,
      totalAmount,
      ...(data.dueDate !== undefined ? { dueDate: data.dueDate } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    },
  });
}

export async function deleteInvoice(tenantId: string, invoiceId: string): Promise<boolean> {
  const existing = await getInvoiceById(tenantId, invoiceId);
  if (!existing) {
    return false;
  }

  // Sprint 26E : une facture née d'un versionnement (replacesInvoiceId renseigné) n'est jamais
  // supprimable, même DRAFT sans paiement — c'est le document courant d'une chaîne de versions ;
  // la supprimer romprait le lien vers la facture qu'elle remplace, restée VOID sans jamais
  // pouvoir redevenir active.
  if (existing.replacesInvoiceId) {
    throw new InvoiceNotDeletableError();
  }

  if (existing.status !== "DRAFT" || existing.amountPaid > 0) {
    throw new InvoiceNotDeletableError();
  }

  const paymentCount = await prisma.payment.count({ where: { invoiceId } });
  if (paymentCount > 0) {
    throw new InvoiceNotDeletableError();
  }

  await prisma.invoice.delete({ where: { id: invoiceId } });
  return true;
}

/**
 * Sprint 26E : verrou de ligne explicite (SELECT ... FOR UPDATE), tenant-scopé — même
 * primitive que lockInvoiceForUpdate (src/lib/payments.ts, Finding B), dupliquée ici plutôt
 * qu'importée : payments.ts importe déjà invoices.ts (getInvoiceById), un import inverse
 * créerait un cycle, et payments.ts (Findings B/D1/F) ne doit pas être modifié par ce sprint.
 * Sérialise le versionnement (Sprint 26E) et l'annulation ADMIN (Sprint 28, Finding D2) contre
 * une création de paiement concurrente sur la même facture (createPaymentLocked pose le même
 * verrou avant d'écrire un Payment) : l'une des deux opérations attend le commit de l'autre
 * avant de relire un état à jour, jamais l'inverse. Renommée `lockInvoiceRow` (Sprint 28,
 * initialement `lockInvoiceForVersioning`) car désormais partagée par `versionInvoice` et
 * `adminCancelInvoice`.
 */
async function lockInvoiceRow(
  tenantId: string,
  invoiceId: string,
  tx: Prisma.TransactionClient
): Promise<Invoice | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Invoice" WHERE id = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE
  `;
  if (locked.length === 0) {
    return null;
  }
  return getInvoiceById(tenantId, invoiceId, tx);
}

export interface VersionInvoiceInput {
  reason: string;
  performedByUserId: string;
}

export interface VersionInvoiceResult {
  oldInvoice: Invoice;
  newInvoice: Invoice;
}

/**
 * Sprint 26E : versionnement documentaire — jamais un avoir (aucun montant négatif, aucun
 * Payment négatif, aucun transfert de paiement, aucune nouvelle logique de remboursement).
 * Seule une facture ISSUED sans aucun Payment (compte réel via tx.payment.count, pas seulement
 * amountPaid === 0 — couvre le cas résiduel d'un Payment physiquement supprimé, voir
 * deletePayment, src/lib/payments.ts) peut être remplacée. L'ancienne facture passe VOID
 * (jamais supprimée, jamais réécrite dans ses montants) ; elle est retrouvable depuis la
 * nouvelle via `replacesInvoiceId` (FK réelle, `@unique` — relation 1:1, une facture n'est
 * jamais remplacée deux fois) et, dans l'autre sens, via la relation inverse Prisma
 * `invoice.replacedBy` — **aucune colonne physique dupliquée** : l'information n'est stockée
 * qu'une fois, sur la nouvelle facture. La nouvelle facture est créée DRAFT, reprenant
 * locationId/agencyId/clientId/currency/dueDate/notes tels quels (jamais re-dérivés de la
 * Location, pour ne jamais changer indirectement un montant) — subtotal/taxRate/discountAmount
 * copiés à l'identique, taxAmount/totalAmount recalculés via computeInvoiceTotals (doit
 * reproduire les valeurs d'origine).
 *
 * Concurrence (une seule création doit réussir, les autres 409) : verrou de ligne
 * (lockInvoiceForVersioning) posé avant toute lecture d'éligibilité, puis `updateMany`
 * conditionné sur `status: "ISSUED"` comme réclamation atomique — même double primitive (verrou +
 * transition conditionnée) que adminCancelValidatedLocation (src/lib/locations.ts). `status`
 * seul suffit : cette même fonction est la seule à faire quitter `ISSUED` vers `VOID` pour ce
 * motif, donc une seule facture ISSUED existe par chaîne à un instant donné (les versions
 * précédentes sont déjà VOID) — verrouiller cette ligne sérialise structurellement toute
 * tentative concurrente de remplacement de cette chaîne précise.
 *
 * Numérotation : `${numéroRacine}-AV${versionNumber - 1}` — déterministe sous le verrou de
 * ligne ci-dessus, jamais de renumérotation des factures historiques, jamais de remplacement du
 * préfixe INV existant (voir generateInvoiceNumber, inchangée). `@@unique([tenantId, number])`
 * conservée comme filet de sécurité (P2002 mappée en conflit, tout comme l'unicité de
 * `replacesInvoiceId`) : aucune boucle de réessai n'est nécessaire ici, contrairement à
 * generateInvoiceNumber, puisque le numéro est déterministe sous verrou plutôt que basé sur un
 * comptage.
 */
export async function versionInvoice(
  tenantId: string,
  invoiceId: string,
  data: VersionInvoiceInput
): Promise<VersionInvoiceResult | null> {
  if (!data.reason.trim()) {
    throw new InvoiceVersionReasonRequiredError();
  }

  const existing = await getInvoiceById(tenantId, invoiceId);
  if (!existing) {
    return null;
  }

  return prisma.$transaction(async (tx) => {
    const locked = await lockInvoiceRow(tenantId, invoiceId, tx);
    if (!locked) {
      return null;
    }

    const paymentCount = await tx.payment.count({ where: { invoiceId: locked.id } });
    if (locked.status !== "ISSUED" || paymentCount > 0) {
      throw new InvoiceNotVersionableError();
    }

    const { count } = await tx.invoice.updateMany({
      where: { id: locked.id, tenantId, status: "ISSUED" },
      data: { status: "VOID" },
    });
    if (count === 0) {
      throw new InvoiceVersionConflictError();
    }

    const rootInvoiceId = locked.rootInvoiceId ?? locked.id;
    const rootNumber = locked.rootInvoiceId
      ? (await tx.invoice.findUniqueOrThrow({ where: { id: rootInvoiceId }, select: { number: true } })).number
      : locked.number;
    const newVersionNumber = locked.versionNumber + 1;
    const newNumber = `${rootNumber}-AV${newVersionNumber - 1}`;

    // subtotal/taxRate/discountAmount copiés à l'identique de l'ancienne facture : doit
    // reproduire exactement taxAmount/totalAmount d'origine (aucune modification indirecte des
    // montants de location/des lignes contractuelles).
    const { taxAmount, totalAmount } = computeInvoiceTotals(locked.subtotal, locked.taxRate, locked.discountAmount);

    let newInvoice: Invoice;
    try {
      newInvoice = await tx.invoice.create({
        data: {
          tenantId,
          agencyId: locked.agencyId,
          locationId: locked.locationId,
          clientId: locked.clientId,
          number: newNumber,
          status: "DRAFT",
          subtotal: locked.subtotal,
          taxRate: locked.taxRate,
          taxAmount,
          discountAmount: locked.discountAmount,
          totalAmount,
          currency: locked.currency,
          dueDate: locked.dueDate,
          notes: locked.notes,
          replacesInvoiceId: locked.id,
          rootInvoiceId,
          versionNumber: newVersionNumber,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new InvoiceVersionConflictError();
      }
      throw error;
    }

    // Relit l'ancienne facture après le updateMany (status déjà VOID) — aucune écriture
    // supplémentaire nécessaire : la FK replacesInvoiceId posée sur newInvoice ci-dessus est la
    // seule source de vérité du lien entre les deux factures.
    const oldInvoice = await tx.invoice.findUniqueOrThrow({ where: { id: locked.id } });

    return { oldInvoice, newInvoice };
  });
}

/** Sprint 26E : chaîne complète (racine + toutes les versions), triée par versionNumber
 * croissant — utilisée par la page détail pour afficher l'historique. */
export async function getInvoiceVersionHistory(tenantId: string, invoiceId: string): Promise<Invoice[]> {
  const invoice = await getInvoiceById(tenantId, invoiceId);
  if (!invoice) {
    return [];
  }
  const rootId = invoice.rootInvoiceId ?? invoice.id;
  return prisma.invoice.findMany({
    where: { tenantId, OR: [{ id: rootId }, { rootInvoiceId: rootId }] },
    orderBy: { versionNumber: "asc" },
  });
}

export interface AdminCancelInvoiceOptions {
  reason: string;
  performedByUserId: string;
}

export interface AdminCancelInvoiceRefund {
  paymentId: string;
  amount: number;
  method: PaymentMethod;
}

export interface AdminCancelInvoiceResult {
  invoice: Invoice;
  reversedPaymentCount: number;
  reversedAmountTotal: number;
  refundedWithoutCashEntryCount: number;
  refunds: AdminCancelInvoiceRefund[];
}

/**
 * Sprint 28 (Finding D2) : annulation ADMIN d'une facture PARTIALLY_PAID avec réversibilité
 * financière complète — même principe qu'adminCancelValidatedLocation (src/lib/locations.ts,
 * Sprint 23/26D), appliqué au niveau facture plutôt que contrat, et **sans y toucher** : les
 * deux flux restent indépendants (une facture annulée ici ne force jamais le statut de sa
 * Location, contrairement à l'inverse). Une compensation de caisse ne modélise jamais un
 * remboursement bancaire/espèces réel (DOMAINRULES.md section 10) — seul le solde de caisse est
 * corrigé ; chaque Payment ACTIVE passe à REFUNDED (jamais réécrit dans amount/method/paidAt,
 * jamais supprimé), même mécanisme que le Finding D1. Un Payment déjà REFUNDED est ignoré (rien
 * à compenser une seconde fois) — filtré directement par la requête `status: "ACTIVE"`
 * ci-dessous, jamais par une simple omission côté boucle.
 *
 * Éligibilité : seule une facture PARTIALLY_PAID est acceptée (InvoiceNotAdminCancellableError
 * sinon) — DRAFT/ISSUED sans paiement n'ont rien à compenser (PATCH suffit, inchangé) ; PAID/
 * VOID sont des états terminaux (PAID n'a d'ailleurs aucune transition manuelle possible,
 * voir canTransition). Concurrence : verrou de ligne (lockInvoiceRow) posé avant toute lecture
 * d'éligibilité, puis `updateMany` conditionné sur `status: "PARTIALLY_PAID"` comme réclamation
 * atomique — une seule annulation concurrente réussit, les autres 409
 * (InvoiceAdminCancelConflictError), même double primitive que versionInvoice/
 * adminCancelValidatedLocation. Atomicité : toute la boucle de compensation s'exécute dans la
 * même transaction Prisma que le passage à VOID — un échec à n'importe quelle itération
 * (ex. createCorrectionCashEntry) annule l'intégralité de la transaction : le statut de la
 * facture, les CashEntry déjà créées et les Payment déjà marqués REFUNDED dans ce même appel
 * sont tous défaits par Prisma, jamais d'état partiel.
 */
export async function adminCancelInvoice(
  tenantId: string,
  invoiceId: string,
  options: AdminCancelInvoiceOptions
): Promise<AdminCancelInvoiceResult | null> {
  if (!options.reason.trim()) {
    throw new CorrectionReasonRequiredError();
  }

  const existing = await getInvoiceById(tenantId, invoiceId);
  if (!existing) {
    return null;
  }

  if (existing.status !== "PARTIALLY_PAID") {
    throw new InvoiceNotAdminCancellableError();
  }

  return prisma.$transaction(async (tx) => {
    const locked = await lockInvoiceRow(tenantId, invoiceId, tx);
    if (!locked) {
      return null;
    }

    const { count } = await tx.invoice.updateMany({
      where: { id: invoiceId, tenantId, status: "PARTIALLY_PAID" },
      data: { status: "VOID" },
    });
    if (count === 0) {
      throw new InvoiceAdminCancelConflictError();
    }

    // Seul le contractNumber (affichage de la CashEntry, même convention que
    // adminCancelValidatedLocation) est dérivé de la Location — locked.agencyId (dénormalisé
    // sur Invoice) suffit pour la CashEntry elle-même, aucune dépendance fonctionnelle à cette
    // lecture au-delà de l'affichage.
    const location = await tx.location.findUnique({ where: { id: locked.locationId } });

    const activePayments: Payment[] = await tx.payment.findMany({
      where: { invoiceId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
    });

    let reversedPaymentCount = 0;
    let reversedAmountTotal = 0;
    let refundedWithoutCashEntryCount = 0;
    const refunds: AdminCancelInvoiceRefund[] = [];

    for (const payment of activePayments) {
      // Un Payment antérieur au Sprint 18 (avant que createPayment n'alimente
      // systématiquement la caisse) peut n'avoir jamais eu de CashEntry — même cas résiduel
      // que adminCancelValidatedLocation : le Payment est marqué REFUNDED sans compensation
      // créée (rien à inverser, jamais de compensation orpheline).
      const originalEntry = await tx.cashEntry.findFirst({
        where: { paymentId: payment.id, parentEntryId: null },
      });

      if (!originalEntry) {
        await tx.payment.update({ where: { id: payment.id }, data: { status: "REFUNDED" } });
        refundedWithoutCashEntryCount += 1;
        refunds.push({ paymentId: payment.id, amount: payment.amount, method: payment.method });
        continue;
      }

      await createCorrectionCashEntry(
        {
          tenantId,
          parentEntryId: originalEntry.id,
          paymentId: payment.id,
          type: "EXPENSE",
          amount: payment.amount,
          paymentMethod: payment.method,
          category: "ANNULATION_FACTURE",
          description:
            `Annulation facture ${locked.number}` +
            (location?.contractNumber ? ` (contrat ${location.contractNumber})` : "") +
            ` — compensation du paiement du ${payment.paidAt.toISOString().slice(0, 10)}`,
          reason: options.reason.trim(),
          performedByUserId: options.performedByUserId,
          agencyId: locked.agencyId,
          contractId: locked.locationId,
          contractNumber: location?.contractNumber ?? null,
        },
        tx
      );
      await tx.payment.update({ where: { id: payment.id }, data: { status: "REFUNDED" } });

      reversedPaymentCount += 1;
      reversedAmountTotal += payment.amount;
      refunds.push({ paymentId: payment.id, amount: payment.amount, method: payment.method });
    }

    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });

    return { invoice, reversedPaymentCount, reversedAmountTotal, refundedWithoutCashEntryCount, refunds };
  });
}
