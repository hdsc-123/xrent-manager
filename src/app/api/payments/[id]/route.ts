import { NextResponse } from "next/server";
import type { PaymentMethod, Prisma } from "@prisma/client";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getInvoiceById } from "@/lib/invoices";
import {
  getPaymentById,
  updatePayment,
  deletePayment,
  InvalidPaymentAmountError,
  PaymentExceedsRemainingBalanceError,
  PaymentInvoiceNotFoundError,
  CorrectionReasonRequiredError,
  PaymentAlreadyRefundedError,
  PaymentCashEntryNotFoundError,
  PaymentHasCashEntryError,
} from "@/lib/payments";
import { logAction } from "@/lib/audit";

const PAYMENT_METHODS: PaymentMethod[] = ["CASH", "CARD", "BANK_TRANSFER", "CHECK", "OTHER"];

interface RouteParams {
  params: Promise<{ id: string }>;
}

async function loadAuthorizedPayment(tenantId: string, paymentId: string, user: { tenantId: string; id: string; role: string }) {
  const payment = await getPaymentById(tenantId, paymentId);
  if (!payment) {
    return null;
  }

  // Sprint 33 (DOMAINRULES.md section 48) : cette route ne traite jamais que des paiements
  // locatifs — un paiement de dégât (Payment.invoiceId null, Payment.damageInvoiceId non nul,
  // voir prisma/schema.prisma) n'est jamais résolu ici (traité comme introuvable, jamais exposé
  // via cette route générique) ; il relève exclusivement de /api/damage-invoices/[id]/payments.
  if (!payment.invoiceId) {
    return null;
  }

  const invoice = await getInvoiceById(tenantId, payment.invoiceId);
  if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) {
    return null;
  }

  return payment;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "payments.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const payment = await loadAuthorizedPayment(user.tenantId, id, user);

  if (!payment) {
    return NextResponse.json({ error: "Paiement introuvable." }, { status: 404 });
  }

  return NextResponse.json({ payment });
}

interface UpdatePaymentBody {
  amount?: number;
  method?: PaymentMethod;
  paidAt?: string;
  reference?: string;
  notes?: string;
  /** Sprint 26D (Finding D1) : obligatoire dès que amount/method/paidAt change réellement —
   * voir CorrectionReasonRequiredError, src/lib/payments.ts. */
  reason?: string;
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  // Sprint 26D (Finding D1) : payments.correct est la clé dédiée pour cette action
  // (correction de montant/moyen/date d'un paiement déjà encaissé, avec compensation de
  // caisse) — payments.create reste accepté en alternative pour ne retirer silencieusement
  // l'accès à aucun groupe personnalisé existant qui n'aurait pas encore payments.correct
  // (voir DEFAULT_GROUPS/PAST_PERMISSION_BACKFILLS, src/lib/permissions.ts).
  if (!(await can(user, "payments.correct")) && !(await can(user, "payments.create"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const payment = await loadAuthorizedPayment(user.tenantId, id, user);

  if (!payment) {
    return NextResponse.json({ error: "Paiement introuvable." }, { status: 404 });
  }

  let body: UpdatePaymentBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.method && !PAYMENT_METHODS.includes(body.method)) {
    return NextResponse.json({ error: "method invalide." }, { status: 400 });
  }

  let paidAt: Date | undefined;
  if (body.paidAt) {
    paidAt = new Date(body.paidAt);
    if (Number.isNaN(paidAt.getTime())) {
      return NextResponse.json({ error: "paidAt doit être une date ISO valide." }, { status: 400 });
    }
  }

  try {
    const updated = await updatePayment(user.tenantId, payment.id, {
      amount: body.amount,
      method: body.method,
      paidAt,
      reference: body.reference,
      notes: body.notes,
      reason: body.reason,
      performedByUserId: user.id,
    });
    // Sprint 26D (Finding D1) : ancien/nouveau montant, moyen et date capturés explicitement
    // (pas seulement `changes: body`) pour que le motif de correction soit exploitable tel
    // quel dans le journal d'audit, y compris pour une correction de date seule (aucune
    // CashEntry créée dans ce cas — voir updatePaymentLocked, src/lib/payments.ts).
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "payment.updated",
      resource: "Payment",
      resourceId: payment.id,
      metadata: {
        changes: body,
        previousAmount: payment.amount,
        newAmount: updated?.amount,
        previousMethod: payment.method,
        newMethod: updated?.method,
        previousPaidAt: payment.paidAt.toISOString(),
        newPaidAt: updated?.paidAt.toISOString(),
        reason: body.reason,
      } as unknown as Prisma.InputJsonValue,
    });
    return NextResponse.json({ payment: updated });
  } catch (error) {
    if (error instanceof InvalidPaymentAmountError || error instanceof CorrectionReasonRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (
      error instanceof PaymentExceedsRemainingBalanceError ||
      error instanceof PaymentInvoiceNotFoundError ||
      error instanceof PaymentAlreadyRefundedError ||
      error instanceof PaymentCashEntryNotFoundError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    console.error("Erreur lors de la modification du paiement :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "payments.delete"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const payment = await loadAuthorizedPayment(user.tenantId, id, user);

  if (!payment) {
    return NextResponse.json({ error: "Paiement introuvable." }, { status: 404 });
  }

  // Sprint 26D (Finding D1) : suppression physique refusée dès qu'une CashEntry est liée à
  // ce paiement (voir PaymentHasCashEntryError, src/lib/payments.ts) — le flux normal pour
  // un paiement déjà encaissé est désormais le remboursement (annulation du contrat),
  // jamais une suppression qui effacerait l'historique financier.
  try {
    await deletePayment(user.tenantId, payment.id);
  } catch (error) {
    if (error instanceof PaymentHasCashEntryError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la suppression du paiement :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "payment.deleted",
    resource: "Payment",
    resourceId: payment.id,
    metadata: { invoiceId: payment.invoiceId, amount: payment.amount },
  });

  return NextResponse.json({ success: true });
}
