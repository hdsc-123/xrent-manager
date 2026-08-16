import type { Invoice, InvoiceStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getLocationById } from "@/lib/locations";

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
 * Sprint 26E : versionnement documentaire d'une facture — jamais un avoir (pas de montant
 * négatif, pas de Payment négatif, aucun transfert de paiement). Seule une facture SENT sans
 * aucun Payment (compte réel, pas seulement amountPaid === 0 — voir versionInvoice) peut être
 * remplacée par une nouvelle version DRAFT.
 */
export class InvoiceNotVersionableError extends Error {
  constructor() {
    super(
      "Seule une facture SENT sans aucun paiement peut être versionnée " +
        "(DRAFT se modifie directement ; PARTIALLY_PAID/PAID/CANCELLED sont refusées)."
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
  DRAFT: ["SENT", "CANCELLED"],
  SENT: ["CANCELLED"],
  PARTIALLY_PAID: ["CANCELLED"],
  PAID: [],
  CANCELLED: [],
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

export interface UpdateInvoiceInput {
  status?: InvoiceStatus;
  taxRate?: number;
  discountAmount?: number;
  dueDate?: Date | null;
  notes?: string;
}

/** `tx` optionnel (Finding F) — permet d'appeler la finalisation DRAFT → SENT depuis une
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

  // Finding F (Sprint 26F) : la finalisation manuelle ou automatique (DRAFT → SENT) est
  // désormais inconditionnelle vis-à-vis du solde — SENT signifie « facture verrouillée, en
  // attente de paiement », pas « soldée » (voir DOMAINRULES.md). Le gate Sprint 26D
  // (InvoiceNotFullyPaidError) rendait SENT structurellement inatteignable puisque
  // recomputeInvoiceStatus (src/lib/payments.ts, Finding B, inchangée) fait déjà passer une
  // facture directement de DRAFT à PARTIALLY_PAID/PAID dès le premier paiement — retiré sur
  // décision explicite du propriétaire du projet.

  // Une facture à 0 (remise à 100 %) n'a par construction jamais de Payment (createPayment
  // refuse tout montant contre un solde restant nul) : recomputeInvoiceStatus
  // (src/lib/payments.ts) ne s'exécute donc jamais pour elle, et elle resterait sinon
  // indéfiniment SENT malgré un solde déjà nul (bug réel, Sprint 18 — pilote terrain :
  // location offerte/remise commerciale intégrale). Au moment où elle est effectivement
  // finalisée (DRAFT → SENT), un total nul la fait donc atterrir directement en PAID.
  const resolvedStatus = data.status === "SENT" && totalAmount === 0 ? "PAID" : data.status;

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
  // la supprimer romprait le lien vers la facture qu'elle remplace, restée CANCELLED sans jamais
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
 * Sérialise le versionnement contre une création de paiement concurrente sur la même facture
 * (createPaymentLocked pose le même verrou avant d'écrire un Payment) : l'une des deux
 * opérations attend le commit de l'autre avant de relire un état à jour, jamais l'inverse.
 */
async function lockInvoiceForVersioning(
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
 * Seule une facture SENT sans aucun Payment (compte réel via tx.payment.count, pas seulement
 * amountPaid === 0 — couvre le cas résiduel d'un Payment physiquement supprimé, voir
 * deletePayment, src/lib/payments.ts) peut être remplacée. L'ancienne facture passe CANCELLED
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
 * conditionné sur `status: "SENT"` comme réclamation atomique — même double primitive (verrou +
 * transition conditionnée) que adminCancelValidatedLocation (src/lib/locations.ts). `status`
 * seul suffit : cette même fonction est la seule à faire quitter `SENT` vers `CANCELLED` pour ce
 * motif, donc une seule facture SENT existe par chaîne à un instant donné (les versions
 * précédentes sont déjà CANCELLED) — verrouiller cette ligne sérialise structurellement toute
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
    const locked = await lockInvoiceForVersioning(tenantId, invoiceId, tx);
    if (!locked) {
      return null;
    }

    const paymentCount = await tx.payment.count({ where: { invoiceId: locked.id } });
    if (locked.status !== "SENT" || paymentCount > 0) {
      throw new InvoiceNotVersionableError();
    }

    const { count } = await tx.invoice.updateMany({
      where: { id: locked.id, tenantId, status: "SENT" },
      data: { status: "CANCELLED" },
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

    // Relit l'ancienne facture après le updateMany (status déjà CANCELLED) — aucune écriture
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
