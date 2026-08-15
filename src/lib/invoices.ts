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

export async function updateInvoice(
  tenantId: string,
  invoiceId: string,
  data: UpdateInvoiceInput
): Promise<Invoice | null> {
  const existing = await getInvoiceById(tenantId, invoiceId);
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

  // Une facture à 0 (remise à 100 %) n'a par construction jamais de Payment (createPayment
  // refuse tout montant contre un solde restant nul) : recomputeInvoiceStatus
  // (src/lib/payments.ts) ne s'exécute donc jamais pour elle, et elle resterait sinon
  // indéfiniment SENT malgré un solde déjà nul (bug réel, Sprint 18 — pilote terrain :
  // location offerte/remise commerciale intégrale). Au moment où elle est effectivement
  // finalisée (DRAFT → SENT), un total nul la fait donc atterrir directement en PAID.
  const resolvedStatus = data.status === "SENT" && totalAmount === 0 ? "PAID" : data.status;

  return prisma.invoice.update({
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
