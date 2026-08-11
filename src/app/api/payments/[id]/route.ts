import { NextResponse } from "next/server";
import type { PaymentMethod } from "@prisma/client";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { getInvoiceById } from "@/lib/invoices";
import {
  getPaymentById,
  updatePayment,
  deletePayment,
  InvalidPaymentAmountError,
  PaymentExceedsRemainingBalanceError,
  PaymentInvoiceNotFoundError,
} from "@/lib/payments";

const PAYMENT_METHODS: PaymentMethod[] = ["CASH", "CARD", "BANK_TRANSFER", "CHECK", "OTHER"];

interface RouteParams {
  params: Promise<{ id: string }>;
}

async function loadAuthorizedPayment(tenantId: string, paymentId: string, user: { tenantId: string; id: string; role: string }) {
  const payment = await getPaymentById(tenantId, paymentId);
  if (!payment) {
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
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
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
    });
    return NextResponse.json({ payment: updated });
  } catch (error) {
    if (error instanceof InvalidPaymentAmountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof PaymentExceedsRemainingBalanceError || error instanceof PaymentInvoiceNotFoundError) {
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

  const { id } = await params;
  const payment = await loadAuthorizedPayment(user.tenantId, id, user);

  if (!payment) {
    return NextResponse.json({ error: "Paiement introuvable." }, { status: 404 });
  }

  await deletePayment(user.tenantId, payment.id);
  return NextResponse.json({ success: true });
}
