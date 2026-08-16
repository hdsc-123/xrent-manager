import type { Invoice, InvoiceStatus, Payment, PaymentMethod, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createPayment, PaymentInvoiceNotFoundError } from "@/lib/payments";
import { getInvoiceById, updateInvoice } from "@/lib/invoices";
import { logAction } from "@/lib/audit";
import { formatMoney } from "@/lib/format";

export const PAYMENT_METHODS: PaymentMethod[] = ["CASH", "CARD", "BANK_TRANSFER", "CHECK", "OTHER"];

/**
 * Section paiement partagée par POST /api/locations (Sprint 13A) et
 * POST /api/reservations/[id]/convert (Sprint 13D) — même formulaire de paiement intégré
 * dans les deux flux (création directe de location, ou conversion d'une réservation).
 * deferred = "paiement au retour" (aucun Payment créé) ; mixed = 2 lignes méthode+montant ;
 * partial (non mixte uniquement) = un montant inférieur au total facturé (sinon le total
 * facturé est réglé intégralement).
 */
export interface PaymentInput {
  deferred?: boolean;
  mixed?: boolean;
  partial?: boolean;
  method?: PaymentMethod;
  amount?: number;
  method1?: PaymentMethod;
  amount1?: number;
  method2?: PaymentMethod;
  amount2?: number;
}

export function validatePaymentInput(payment: PaymentInput | undefined): string | null {
  if (!payment || payment.deferred) {
    return null;
  }

  if (payment.mixed) {
    const lines = [
      { method: payment.method1, amount: payment.amount1 },
      { method: payment.method2, amount: payment.amount2 },
    ].filter((line) => line.amount !== undefined && line.amount > 0);

    if (lines.length === 0) {
      return "Le paiement mixte nécessite au moins un montant renseigné.";
    }
    for (const line of lines) {
      if (!line.method || !PAYMENT_METHODS.includes(line.method)) {
        return "Mode de paiement invalide dans le paiement mixte.";
      }
      if (!Number.isInteger(line.amount) || (line.amount as number) <= 0) {
        return "Chaque montant du paiement mixte doit être un entier positif.";
      }
    }
    return null;
  }

  if (!payment.method || !PAYMENT_METHODS.includes(payment.method)) {
    return "Mode de paiement invalide.";
  }

  if (payment.partial) {
    if (!Number.isInteger(payment.amount) || (payment.amount as number) <= 0) {
      return "Le montant payé doit être un entier positif.";
    }
  }

  return null;
}

export interface ProcessLocationPaymentInput {
  tenantId: string;
  userId: string;
  invoice: Invoice;
  payment: PaymentInput | undefined;
}

export interface ProcessLocationPaymentResult {
  invoice: Invoice;
  payments: Payment[];
  paymentError: string | null;
}

/**
 * Encaisse le paiement intégré (formulaire location/conversion) : chaque montant réellement
 * réglé passe par createPayment (src/lib/payments.ts) — le calcul du statut de facture
 * (SENT/PARTIALLY_PAID/PAID) reste entièrement dérivé de la somme réelle des paiements, et
 * l'écriture de caisse correspondante (Sprint 18 : centralisée dans createPayment lui-même,
 * pour que tout paiement en alimente une, quel que soit son point d'entrée) est créée avec.
 * Résilient par choix, même principe que la génération automatique de facture (Sprint 12B) :
 * un échec ne doit jamais faire échouer la création de la location/du contrat elle-même —
 * mais la facture et le(s) paiement(s) de *cette* opération restent cohérents entre eux
 * (Finding F, voir `finalizeAndPay` ci-dessous).
 *
 * Correctif Sprint 14B (paiement mixte) : le total des lignes est validé contre le solde
 * restant dû *avant* d'écrire quoi que ce soit — auparavant, un paiement mixte dont la somme
 * dépassait le solde écrivait quand même la première ligne (createPayment) avant d'échouer sur
 * la seconde, laissant un paiement partiel orphelin derrière un message d'erreur technique
 * (entier brut de centimes, voir PaymentExceedsRemainingBalanceError). Le message est
 * désormais toujours exprimé dans la devise de la facture (formatMoney), jamais un nombre brut.
 *
 * Finding F : une facture DRAFT ne peut plus recevoir de paiement (createPayment refuse
 * désormais DRAFT, voir InvoiceNotFinalizedError) — un paiement intégré à la création d'un
 * contrat/d'une location finalise donc automatiquement la facture (DRAFT → SENT) juste avant
 * de créer le(s) Payment, dans la même transaction que ce(s) paiement(s) (`finalizeAndPay`).
 * Si un paiement échoue (solde dépassé en situation de course, ligne suivante d'un paiement
 * mixte invalide, etc.), toute la transaction est rollback — finalisation, Payment et CashEntry
 * compris : jamais de facture SENT orpheline sans paiement, jamais de Payment/CashEntry partiel
 * pour un paiement mixte dont une ligne a échoué.
 */
/**
 * `tx` optionnel (Sprint 26A, Finding A) — défaut au client Prisma global, comportement
 * inchangé pour tout appel sans transaction partagée (POST /api/locations) : dans ce cas,
 * `finalizeAndPay` s'exécute dans une transaction dédiée ouverte ici (Finding F). Avec une `tx`
 * fournie par l'appelant (POST /api/reservations/[id]/convert, déjà entièrement transactionnel
 * depuis le Finding A), `finalizeAndPay` réutilise directement cette transaction, sans en ouvrir
 * de nouvelle — le rollback en cas d'échec reste alors de la responsabilité de l'appelant
 * (`ConversionPaymentError`, comportement inchangé). `logAction` (audit, ci-dessous) reste
 * volontairement hors transaction, mais n'est désormais journalisé qu'après le succès complet
 * de la transaction — jamais avant, pour ne jamais journaliser un paiement ou une finalisation
 * finalement rollback.
 */
export async function processLocationPayment(
  input: ProcessLocationPaymentInput,
  tx: Prisma.TransactionClient = prisma
): Promise<ProcessLocationPaymentResult> {
  const { tenantId, userId, payment } = input;
  const invoice = input.invoice;

  if (!payment || payment.deferred) {
    return { invoice, payments: [], paymentError: null };
  }

  const lines = payment.mixed
    ? [
        { method: payment.method1, amount: payment.amount1 },
        { method: payment.method2, amount: payment.amount2 },
      ].filter(
        (line): line is { method: PaymentMethod; amount: number } =>
          line.amount !== undefined && line.amount > 0 && line.method !== undefined
      )
    : [
        {
          method: payment.method as PaymentMethod,
          amount: payment.partial ? (payment.amount as number) : invoice.totalAmount,
        },
      ];

  const remainingBalance = invoice.totalAmount - invoice.amountPaid;
  const linesTotal = lines.reduce((sum, line) => sum + line.amount, 0);

  if (linesTotal > remainingBalance) {
    return {
      invoice,
      payments: [],
      paymentError:
        `Le total du paiement (${formatMoney(linesTotal, invoice.currency)}) dépasse le solde restant dû ` +
        `(${formatMoney(remainingBalance, invoice.currency)}). Aucun paiement n'a été enregistré : ` +
        `corrigez les montants et réessayez.`,
    };
  }

  try {
    const result =
      tx !== prisma
        ? await finalizeAndPay(tenantId, invoice, lines, tx)
        : await prisma.$transaction((innerTx) => finalizeAndPay(tenantId, invoice, lines, innerTx));

    // Transaction commitée avec succès uniquement à ce stade : journalisation après coup
    // uniquement (jamais avant/pendant), même principe que
    // POST /api/reservations/[id]/convert — un paiement ou une finalisation qui aurait été
    // rollback ne doit jamais laisser de trace dans l'AuditLog. Seule la finalisation
    // (DRAFT → SENT) elle-même est journalisée ici, jamais la dérivation SENT →
    // PARTIALLY_PAID/PAID qui suit (même convention que le paiement direct, PATCH
    // /api/payments/[id] : recomputeInvoiceStatus n'est jamais séparément audité, seul le
    // Payment qui la déclenche l'est, ci-dessous).
    if (result.finalizedFrom) {
      await logAction({
        tenantId,
        userId,
        action: "invoice.status_changed",
        resource: "Invoice",
        resourceId: result.invoice.id,
        metadata: { from: result.finalizedFrom, to: "SENT", auto: true },
      });
    }
    for (const created of result.payments) {
      await logAction({
        tenantId,
        userId,
        action: "payment.created",
        resource: "Payment",
        resourceId: created.id,
        metadata: { invoiceId: created.invoiceId, amount: created.amount, method: created.method, auto: true },
      });
    }

    return { invoice: result.invoice, payments: result.payments, paymentError: null };
  } catch (error) {
    console.error("Erreur lors de l'enregistrement du paiement intégré à la location :", error);
    return {
      invoice,
      payments: [],
      paymentError: error instanceof Error ? error.message : "Erreur lors de l'enregistrement du paiement.",
    };
  }
}

/**
 * Finalise (DRAFT → SENT, si nécessaire) puis crée chaque ligne de paiement, entièrement dans
 * la transaction `tx` fournie par l'appelant — délibérément sans aucun `try/catch` : toute
 * erreur (solde dépassé, facture introuvable, etc.) doit se propager telle quelle pour que la
 * transaction englobante (`processLocationPayment` ci-dessus) rollback l'ensemble — finalisation
 * SENT, Payment déjà créés et leur(s) CashEntry — plutôt que de committer un état partiel
 * (Finding F).
 */
async function finalizeAndPay(
  tenantId: string,
  invoice: Invoice,
  lines: { method: PaymentMethod; amount: number }[],
  tx: Prisma.TransactionClient
): Promise<{ invoice: Invoice; payments: Payment[]; finalizedFrom: InvoiceStatus | null }> {
  let currentInvoice = invoice;
  let finalizedFrom: InvoiceStatus | null = null;
  if (currentInvoice.status === "DRAFT") {
    const finalized = await updateInvoice(tenantId, currentInvoice.id, { status: "SENT" }, tx);
    if (!finalized) {
      throw new PaymentInvoiceNotFoundError();
    }
    finalizedFrom = currentInvoice.status;
    currentInvoice = finalized;
  }

  const payments: Payment[] = [];
  for (const line of lines) {
    const created = await createPayment(
      { tenantId, invoiceId: currentInvoice.id, amount: line.amount, method: line.method },
      tx
    );
    payments.push(created);
  }

  // createPayment (ci-dessus) a déjà recalculé amountPaid/status en base
  // (recomputeInvoiceStatus, src/lib/payments.ts) ; relu ici pour refléter ce nouveau statut
  // dans le résultat, sinon l'appelant renverrait à tort SENT au lieu de PARTIALLY_PAID/PAID.
  const refreshed = await getInvoiceById(tenantId, currentInvoice.id, tx);
  return { invoice: refreshed ?? currentInvoice, payments, finalizedFrom };
}
