import type { Payment, PaymentMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getInvoiceById } from "@/lib/invoices";
import { formatMoney } from "@/lib/format";

export class PaymentInvoiceNotFoundError extends Error {
  constructor() {
    super("Facture introuvable.");
    this.name = "PaymentInvoiceNotFoundError";
  }
}

export class InvoiceCancelledError extends Error {
  constructor() {
    super("Impossible d'enregistrer un paiement sur une facture annulée.");
    this.name = "InvoiceCancelledError";
  }
}

export class InvalidPaymentAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPaymentAmountError";
  }
}

export class PaymentExceedsRemainingBalanceError extends Error {
  remainingBalance: number;

  /**
   * Message toujours exprimé dans la devise de la facture (jamais un entier brut de centimes)
   * — corrige un message technique incompréhensible pour un agent (Sprint 14B, voir
   * DOMAINRULES.md section 10).
   */
  constructor(remainingBalance: number, currency: string) {
    super(`Le montant dépasse le solde restant dû (${formatMoney(remainingBalance, currency)}).`);
    this.name = "PaymentExceedsRemainingBalanceError";
    this.remainingBalance = remainingBalance;
  }
}

/**
 * Recalcule amountPaid (somme des paiements) et status de la facture à partir des
 * paiements existants — jamais l'inverse. amountPaid n'est donc jamais incrémenté/
 * décrémenté directement : toujours recalculé pour éviter toute dérive (SECURITY.md
 * section 4, cohérence des montants financiers).
 */
async function recomputeInvoiceStatus(invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const aggregate = await prisma.payment.aggregate({
    where: { invoiceId },
    _sum: { amount: true },
  });
  const amountPaid = aggregate._sum.amount ?? 0;

  const nextStatus =
    invoice.status === "CANCELLED"
      ? invoice.status
      : amountPaid >= invoice.totalAmount && invoice.totalAmount > 0
        ? "PAID"
        : amountPaid > 0
          ? "PARTIALLY_PAID"
          : invoice.status === "PARTIALLY_PAID" || invoice.status === "PAID"
            ? "SENT"
            : invoice.status;

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { amountPaid, status: nextStatus },
  });
}

export interface PaymentFilters {
  invoiceId?: string;
  method?: PaymentMethod;
  from?: Date;
  to?: Date;
}

export async function getPayments(tenantId: string, filters: PaymentFilters = {}): Promise<Payment[]> {
  return prisma.payment.findMany({
    where: {
      tenantId,
      ...(filters.invoiceId ? { invoiceId: filters.invoiceId } : {}),
      ...(filters.method ? { method: filters.method } : {}),
      ...(filters.from ? { paidAt: { gte: filters.from } } : {}),
      ...(filters.to ? { paidAt: { lte: filters.to } } : {}),
    },
    orderBy: { paidAt: "desc" },
  });
}

export async function getPaymentById(tenantId: string, paymentId: string): Promise<Payment | null> {
  return prisma.payment.findFirst({ where: { id: paymentId, tenantId } });
}

export interface CreatePaymentInput {
  tenantId: string;
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  paidAt?: Date;
  reference?: string;
  notes?: string;
}

/**
 * currency n'est jamais fourni par le client : toujours dérivée de l'Invoice ciblée,
 * pour empêcher tout paiement enregistré dans une devise incohérente avec la facture.
 */
export async function createPayment(data: CreatePaymentInput): Promise<Payment> {
  if (!Number.isInteger(data.amount) || data.amount <= 0) {
    throw new InvalidPaymentAmountError("amount doit être un entier positif (plus petite unité monétaire).");
  }

  const invoice = await getInvoiceById(data.tenantId, data.invoiceId);
  if (!invoice) {
    throw new PaymentInvoiceNotFoundError();
  }

  if (invoice.status === "CANCELLED") {
    throw new InvoiceCancelledError();
  }

  const remainingBalance = invoice.totalAmount - invoice.amountPaid;
  if (data.amount > remainingBalance) {
    throw new PaymentExceedsRemainingBalanceError(remainingBalance, invoice.currency);
  }

  const payment = await prisma.payment.create({
    data: {
      tenantId: data.tenantId,
      invoiceId: data.invoiceId,
      amount: data.amount,
      currency: invoice.currency,
      method: data.method,
      paidAt: data.paidAt ?? new Date(),
      reference: data.reference,
      notes: data.notes,
    },
  });

  await recomputeInvoiceStatus(data.invoiceId);
  return payment;
}

export interface UpdatePaymentInput {
  amount?: number;
  method?: PaymentMethod;
  paidAt?: Date;
  reference?: string;
  notes?: string;
}

export async function updatePayment(
  tenantId: string,
  paymentId: string,
  data: UpdatePaymentInput
): Promise<Payment | null> {
  const existing = await getPaymentById(tenantId, paymentId);
  if (!existing) {
    return null;
  }

  if (data.amount !== undefined) {
    if (!Number.isInteger(data.amount) || data.amount <= 0) {
      throw new InvalidPaymentAmountError("amount doit être un entier positif (plus petite unité monétaire).");
    }

    const invoice = await getInvoiceById(tenantId, existing.invoiceId);
    if (!invoice) {
      throw new PaymentInvoiceNotFoundError();
    }

    // Solde restant en excluant ce paiement lui-même, pour permettre d'ajuster son propre montant.
    const remainingExcludingThis = invoice.totalAmount - (invoice.amountPaid - existing.amount);
    if (data.amount > remainingExcludingThis) {
      throw new PaymentExceedsRemainingBalanceError(remainingExcludingThis, invoice.currency);
    }
  }

  const updated = await prisma.payment.update({
    where: { id: paymentId },
    data: {
      ...(data.amount !== undefined ? { amount: data.amount } : {}),
      ...(data.method ? { method: data.method } : {}),
      ...(data.paidAt ? { paidAt: data.paidAt } : {}),
      ...(data.reference !== undefined ? { reference: data.reference } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    },
  });

  await recomputeInvoiceStatus(existing.invoiceId);
  return updated;
}

export interface MixedPaymentLine {
  amount: number;
  method: PaymentMethod;
}

export interface CreateMixedPaymentsInput {
  tenantId: string;
  invoiceId: string;
  lines: MixedPaymentLine[];
  paidAt?: Date;
  reference?: string;
  notes?: string;
}

/**
 * Paiement mixte (plusieurs lignes méthode+montant) depuis la fiche facture existante
 * (`InvoiceActions.tsx`) — même garantie que `processLocationPayment`
 * (src/lib/location-payment.ts, Sprint 14B) : le total des lignes est validé contre le solde
 * restant *relu au moment de l'appel* avant d'écrire quoi que ce soit, pour ne jamais laisser
 * un paiement partiel orphelin si le solde a changé depuis l'ouverture du formulaire (Sprint 17
 * — jusqu'ici `InvoiceActions.tsx` revalidait côté client contre un solde figé au chargement de
 * la page, puis postait chaque ligne séparément : une baisse du solde réel entre l'ouverture du
 * dialogue et la soumission pouvait laisser la première ligne écrite avant que la seconde échoue).
 */
export async function createMixedPayments(data: CreateMixedPaymentsInput): Promise<Payment[]> {
  if (data.lines.length === 0) {
    throw new InvalidPaymentAmountError("Le paiement mixte nécessite au moins une ligne.");
  }
  for (const line of data.lines) {
    if (!Number.isInteger(line.amount) || line.amount <= 0) {
      throw new InvalidPaymentAmountError("Chaque montant du paiement mixte doit être un entier positif.");
    }
  }

  const invoice = await getInvoiceById(data.tenantId, data.invoiceId);
  if (!invoice) {
    throw new PaymentInvoiceNotFoundError();
  }
  if (invoice.status === "CANCELLED") {
    throw new InvoiceCancelledError();
  }

  const remainingBalance = invoice.totalAmount - invoice.amountPaid;
  const linesTotal = data.lines.reduce((sum, line) => sum + line.amount, 0);
  if (linesTotal > remainingBalance) {
    throw new PaymentExceedsRemainingBalanceError(remainingBalance, invoice.currency);
  }

  const payments: Payment[] = [];
  for (const line of data.lines) {
    payments.push(
      await createPayment({
        tenantId: data.tenantId,
        invoiceId: data.invoiceId,
        amount: line.amount,
        method: line.method,
        paidAt: data.paidAt,
        reference: data.reference,
        notes: data.notes,
      })
    );
  }
  return payments;
}

export async function deletePayment(tenantId: string, paymentId: string): Promise<boolean> {
  const existing = await getPaymentById(tenantId, paymentId);
  if (!existing) {
    return false;
  }

  await prisma.payment.delete({ where: { id: paymentId } });
  await recomputeInvoiceStatus(existing.invoiceId);
  return true;
}
