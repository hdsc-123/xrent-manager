import type { Invoice, Payment, PaymentMethod, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getInvoiceById } from "@/lib/invoices";
import { getLocationById } from "@/lib/locations";
import { getClientById } from "@/lib/clients";
import { createCashEntry } from "@/lib/cash-register";
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
/** `tx` optionnel (Sprint 26A, Finding A) — voir le commentaire équivalent sur
 * `getReservationById`, src/lib/reservations.ts. */
async function recomputeInvoiceStatus(invoiceId: string, tx: Prisma.TransactionClient = prisma): Promise<void> {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const aggregate = await tx.payment.aggregate({
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

  await tx.invoice.update({
    where: { id: invoiceId },
    data: { amountPaid, status: nextStatus },
  });
}

/**
 * Sprint 26A, Finding B : verrou de ligne explicite (`SELECT ... FOR UPDATE`) sur l'Invoice
 * ciblée, posé avant toute lecture du solde restant — nécessaire car ni `updateMany`
 * conditionné (motif du Finding A, inadapté ici : on ne transite pas un statut, on valide un
 * montant contre une somme agrégée) ni contrainte SQL ne peuvent empêcher deux créations de
 * paiement concurrentes de lire le même `amountPaid` périmé avant d'écrire. Une deuxième
 * transaction concurrente sur la même facture attend ici le commit de la première, puis relit
 * un `amountPaid` à jour — jamais l'inverse. Requête paramétrée via template tag Prisma (aucune
 * concaténation de valeur utilisateur) ; ne doit être appelée que depuis une véritable
 * transaction (`Prisma.TransactionClient` issue de `prisma.$transaction`), jamais sur le client
 * global. La relecture après verrou passe par `getInvoiceById` (typée), pas par le résultat brut
 * du `$queryRaw`.
 */
async function lockInvoiceForUpdate(
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
 *
 * `tx` optionnel (Sprint 26A, Finding A) — défaut au client Prisma global, comportement
 * inchangé pour tout appel sans transaction partagée (POST /api/payments, etc.).
 *
 * Sprint 26A, Finding B : sans `tx` fournie, ouvre désormais sa propre transaction interne
 * (au lieu d'exécuter chaque étape en autocommit séparé) pour verrouiller l'Invoice avant de
 * valider le solde restant (voir `lockInvoiceForUpdate` ci-dessus) — deux créations concurrentes
 * sur la même facture ne peuvent plus toutes deux passer la validation contre une lecture
 * périmée. Avec une `tx` fournie par l'appelant (ex. `processLocationPayment` dans la
 * transaction du Finding A), aucune transaction n'est ouverte ici : le verrou est posé dans la
 * transaction de l'appelant, sans imbrication.
 */
export async function createPayment(
  data: CreatePaymentInput,
  tx: Prisma.TransactionClient = prisma
): Promise<Payment> {
  if (!Number.isInteger(data.amount) || data.amount <= 0) {
    throw new InvalidPaymentAmountError("amount doit être un entier positif (plus petite unité monétaire).");
  }

  if (tx !== prisma) {
    return createPaymentLocked(data, tx);
  }
  return prisma.$transaction((innerTx) => createPaymentLocked(data, innerTx));
}

async function createPaymentLocked(data: CreatePaymentInput, tx: Prisma.TransactionClient): Promise<Payment> {
  const invoice = await lockInvoiceForUpdate(data.tenantId, data.invoiceId, tx);
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

  const payment = await tx.payment.create({
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

  await recomputeInvoiceStatus(data.invoiceId, tx);
  await recordPaymentCashEntry(data.tenantId, invoice.locationId, payment, tx);
  return payment;
}

/**
 * Toute écriture de paiement encaissée doit se refléter en caisse — corrige un bug réel
 * (Sprint 18, pilote terrain) : seul le paiement intégré à la création d'une location
 * (processLocationPayment) alimentait la caisse ; un paiement enregistré plus tard depuis la
 * fiche facture (createPayment/createMixedPayments, POST /api/payments) n'y apparaissait
 * jamais, alors que c'est le flux normal documenté (paiement « au retour » réglé après coup).
 * Centralisé ici (plutôt que dupliqué par chaque appelant) pour que tout paiement, quel que
 * soit son point d'entrée, ait la même garantie.
 *
 * `tx` optionnel (Sprint 26A, Finding A) — voir le commentaire équivalent sur `createPayment`.
 */
async function recordPaymentCashEntry(
  tenantId: string,
  locationId: string,
  payment: Payment,
  tx: Prisma.TransactionClient = prisma
): Promise<void> {
  const location = await getLocationById(tenantId, locationId, tx);
  const contractNumber = location?.contractNumber ?? null;
  const clientName = location ? (await getClientById(tenantId, location.clientId, tx))?.name : undefined;

  await createCashEntry(
    {
      tenantId,
      type: "ENTRY",
      category: "VERSEMENT",
      amount: payment.amount,
      description: `Paiement location ${contractNumber ?? `#${locationId.slice(-8)}`}`,
      contractId: locationId,
      contractNumber,
      clientName,
      paymentMethod: payment.method,
      // Sprint 22 : agence d'origine de l'écriture, dérivée de la Location réglée — permet de
      // calculer un solde/CA par agence en plus du solde global (voir src/lib/cash-register.ts).
      agencyId: location?.agencyId,
    },
    tx
  );
}

export interface UpdatePaymentInput {
  amount?: number;
  method?: PaymentMethod;
  paidAt?: Date;
  reference?: string;
  notes?: string;
}

/**
 * `tx` optionnel (Sprint 26A, Finding B) — même contrat que `createPayment` : sans `tx`
 * fournie, ouvre une transaction interne ; avec une `tx` fournie par l'appelant, la réutilise
 * sans imbrication. Le verrou (`lockInvoiceForUpdate`) n'est posé que si `amount` est modifié
 * (seul cas où le solde restant est recalculé) — un changement de méthode/date/référence/notes
 * seul ne verrouille rien. Ne touche jamais aux `CashEntry` (Finding D1, hors périmètre).
 */
export async function updatePayment(
  tenantId: string,
  paymentId: string,
  data: UpdatePaymentInput,
  tx: Prisma.TransactionClient = prisma
): Promise<Payment | null> {
  if (tx !== prisma) {
    return updatePaymentLocked(tenantId, paymentId, data, tx);
  }
  return prisma.$transaction((innerTx) => updatePaymentLocked(tenantId, paymentId, data, innerTx));
}

async function updatePaymentLocked(
  tenantId: string,
  paymentId: string,
  data: UpdatePaymentInput,
  tx: Prisma.TransactionClient
): Promise<Payment | null> {
  const existing = await tx.payment.findFirst({ where: { id: paymentId, tenantId } });
  if (!existing) {
    return null;
  }

  if (data.amount !== undefined) {
    if (!Number.isInteger(data.amount) || data.amount <= 0) {
      throw new InvalidPaymentAmountError("amount doit être un entier positif (plus petite unité monétaire).");
    }

    const invoice = await lockInvoiceForUpdate(tenantId, existing.invoiceId, tx);
    if (!invoice) {
      throw new PaymentInvoiceNotFoundError();
    }

    // Solde restant en excluant ce paiement lui-même, pour permettre d'ajuster son propre montant.
    const remainingExcludingThis = invoice.totalAmount - (invoice.amountPaid - existing.amount);
    if (data.amount > remainingExcludingThis) {
      throw new PaymentExceedsRemainingBalanceError(remainingExcludingThis, invoice.currency);
    }
  }

  const updated = await tx.payment.update({
    where: { id: paymentId },
    data: {
      ...(data.amount !== undefined ? { amount: data.amount } : {}),
      ...(data.method ? { method: data.method } : {}),
      ...(data.paidAt ? { paidAt: data.paidAt } : {}),
      ...(data.reference !== undefined ? { reference: data.reference } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    },
  });

  await recomputeInvoiceStatus(existing.invoiceId, tx);
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
 *
 * `tx` optionnel (Sprint 26A, Finding B) — même contrat que `createPayment`/`updatePayment` :
 * sans `tx` fournie, ouvre une seule transaction interne pour toutes les lignes (jamais une par
 * ligne) ; avec une `tx` fournie, la réutilise. Le verrou (`lockInvoiceForUpdate`) n'est posé
 * qu'une fois, avant la validation globale du total — chaque `createPayment` interne (une par
 * ligne, ci-dessous) reçoit ensuite cette même `tx` et réutilise donc le même verrou (déjà tenu
 * par cette transaction : une réacquisition `FOR UPDATE` sur une ligne déjà verrouillée par la
 * transaction courante est un no-op côté Postgres, jamais un blocage). La validation par ligne de
 * `createPayment` reste inchangée et ne fait que confirmer, ligne après ligne, ce que la
 * validation globale ci-dessous a déjà garanti pour le total.
 */
export async function createMixedPayments(
  data: CreateMixedPaymentsInput,
  tx: Prisma.TransactionClient = prisma
): Promise<Payment[]> {
  if (data.lines.length === 0) {
    throw new InvalidPaymentAmountError("Le paiement mixte nécessite au moins une ligne.");
  }
  for (const line of data.lines) {
    if (!Number.isInteger(line.amount) || line.amount <= 0) {
      throw new InvalidPaymentAmountError("Chaque montant du paiement mixte doit être un entier positif.");
    }
  }

  if (tx !== prisma) {
    return createMixedPaymentsLocked(data, tx);
  }
  return prisma.$transaction((innerTx) => createMixedPaymentsLocked(data, innerTx));
}

async function createMixedPaymentsLocked(
  data: CreateMixedPaymentsInput,
  tx: Prisma.TransactionClient
): Promise<Payment[]> {
  const invoice = await lockInvoiceForUpdate(data.tenantId, data.invoiceId, tx);
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
      await createPayment(
        {
          tenantId: data.tenantId,
          invoiceId: data.invoiceId,
          amount: line.amount,
          method: line.method,
          paidAt: data.paidAt,
          reference: data.reference,
          notes: data.notes,
        },
        tx
      )
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
