import type { Invoice, Payment, PaymentMethod } from "@prisma/client";
import { createPayment } from "@/lib/payments";
import { getInvoiceById } from "@/lib/invoices";
import { createCashEntry } from "@/lib/cash-register";
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
  locationId: string;
  /** Numéro de contrat (Sprint 14B) — dénormalisé sur l'écriture de caisse, voir CashEntry.contractNumber. */
  contractNumber?: string | null;
  invoice: Invoice;
  clientName?: string;
  payment: PaymentInput | undefined;
}

export interface ProcessLocationPaymentResult {
  invoice: Invoice;
  payments: Payment[];
  paymentError: string | null;
}

/**
 * Encaisse le paiement intégré (formulaire location/conversion) : chaque montant réellement
 * réglé passe par createPayment (src/lib/payments.ts, inchangé) — le calcul du statut de
 * facture (SENT/PARTIALLY_PAID/PAID) reste entièrement dérivé de la somme réelle des
 * paiements. Chaque Payment réussi alimente aussi la Caisse (createCashEntry). Résilient par
 * choix, même principe que la génération automatique de facture (Sprint 12B) : un échec ne
 * doit jamais faire échouer la création de la location/du contrat elle-même.
 *
 * Correctif Sprint 14B (paiement mixte) : le total des lignes est validé contre le solde
 * restant dû *avant* d'écrire quoi que ce soit — auparavant, un paiement mixte dont la somme
 * dépassait le solde écrivait quand même la première ligne (createPayment) avant d'échouer sur
 * la seconde, laissant un paiement partiel orphelin derrière un message d'erreur technique
 * (entier brut de centimes, voir PaymentExceedsRemainingBalanceError). Le message est
 * désormais toujours exprimé dans la devise de la facture (formatMoney), jamais un nombre brut.
 */
export async function processLocationPayment(
  input: ProcessLocationPaymentInput
): Promise<ProcessLocationPaymentResult> {
  const { tenantId, userId, locationId, contractNumber, payment, clientName } = input;
  let invoice = input.invoice;
  const payments: Payment[] = [];
  let paymentError: string | null = null;

  if (!payment || payment.deferred) {
    return { invoice, payments, paymentError };
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
      payments,
      paymentError:
        `Le total du paiement (${formatMoney(linesTotal, invoice.currency)}) dépasse le solde restant dû ` +
        `(${formatMoney(remainingBalance, invoice.currency)}). Aucun paiement n'a été enregistré : ` +
        `corrigez les montants et réessayez.`,
    };
  }

  try {
    for (const line of lines) {
      const created = await createPayment({
        tenantId,
        invoiceId: invoice.id,
        amount: line.amount,
        method: line.method,
      });
      payments.push(created);
      await logAction({
        tenantId,
        userId,
        action: "payment.created",
        resource: "Payment",
        resourceId: created.id,
        metadata: { invoiceId: created.invoiceId, amount: created.amount, method: created.method, auto: true },
      });

      const cashEntry = await createCashEntry({
        tenantId,
        type: "ENTRY",
        category: "VERSEMENT",
        amount: created.amount,
        description: `Paiement location ${contractNumber ?? `#${locationId.slice(-8)}`}`,
        contractId: locationId,
        contractNumber,
        clientName,
        paymentMethod: created.method,
      });
      await logAction({
        tenantId,
        userId,
        action: "cashEntry.created",
        resource: "CashEntry",
        resourceId: cashEntry.id,
        metadata: { type: cashEntry.type, amount: cashEntry.amount, contractId: locationId, auto: true },
      });
    }
  } catch (error) {
    paymentError = error instanceof Error ? error.message : "Erreur lors de l'enregistrement du paiement.";
    console.error("Erreur lors de l'enregistrement du paiement intégré à la location :", error);
  }

  // createPayment (ci-dessus) a déjà recalculé amountPaid/status en base
  // (recomputeInvoiceStatus, src/lib/payments.ts) ; la variable locale `invoice` doit être
  // relue pour refléter ce nouveau statut, sinon l'appelant renverrait à tort DRAFT/SENT.
  if (payments.length > 0) {
    const refreshed = await getInvoiceById(tenantId, invoice.id);
    if (refreshed) {
      invoice = refreshed;
    }
  }

  return { invoice, payments, paymentError };
}
