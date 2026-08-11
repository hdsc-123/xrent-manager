import { NextResponse } from "next/server";
import type { PaymentMethod } from "@prisma/client";
import { getSessionUser, canAccessAgency, getAccessibleAgencyIds } from "@/lib/authz";
import { getInvoiceById } from "@/lib/invoices";
import { prisma } from "@/lib/prisma";
import {
  getPayments,
  createPayment,
  type PaymentFilters,
  PaymentInvoiceNotFoundError,
  InvoiceCancelledError,
  InvalidPaymentAmountError,
  PaymentExceedsRemainingBalanceError,
} from "@/lib/payments";

const PAYMENT_METHODS: PaymentMethod[] = ["CASH", "CARD", "BANK_TRANSFER", "CHECK", "OTHER"];

export async function GET(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const invoiceId = searchParams.get("invoiceId") ?? undefined;
  const methodParam = searchParams.get("method") ?? undefined;
  const fromParam = searchParams.get("from") ?? undefined;
  const toParam = searchParams.get("to") ?? undefined;

  if (methodParam && !PAYMENT_METHODS.includes(methodParam as PaymentMethod)) {
    return NextResponse.json({ error: "method invalide." }, { status: 400 });
  }

  if (invoiceId) {
    const invoice = await getInvoiceById(user.tenantId, invoiceId);
    if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) {
      return NextResponse.json({ error: "Accès refusé à cette facture." }, { status: 403 });
    }
  }

  const filters: PaymentFilters = {
    invoiceId,
    method: methodParam as PaymentMethod | undefined,
    from: fromParam ? new Date(fromParam) : undefined,
    to: toParam ? new Date(toParam) : undefined,
  };

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const payments = await getPayments(user.tenantId, filters);

  if (accessibleAgencyIds === null || invoiceId) {
    return NextResponse.json({ payments });
  }

  // Un MEMBER ne voit que les paiements des factures de ses agences (même principe que
  // vehicles/locations) : filtrage post-requête via l'agencyId des factures concernées.
  const invoiceIds = [...new Set(payments.map((payment) => payment.invoiceId))];
  const invoices = await prisma.invoice.findMany({
    where: { id: { in: invoiceIds } },
    select: { id: true, agencyId: true },
  });
  const accessibleInvoiceIds = new Set(
    invoices.filter((invoice) => accessibleAgencyIds.includes(invoice.agencyId)).map((invoice) => invoice.id)
  );

  return NextResponse.json({
    payments: payments.filter((payment) => accessibleInvoiceIds.has(payment.invoiceId)),
  });
}

interface CreatePaymentBody {
  invoiceId?: string;
  amount?: number;
  method?: PaymentMethod;
  paidAt?: string;
  reference?: string;
  notes?: string;
}

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  let body: CreatePaymentBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { invoiceId, amount, method } = body;
  if (!invoiceId || amount === undefined || !method) {
    return NextResponse.json({ error: "invoiceId, amount et method sont requis." }, { status: 400 });
  }

  if (!PAYMENT_METHODS.includes(method)) {
    return NextResponse.json({ error: "method invalide." }, { status: 400 });
  }

  let paidAt: Date | undefined;
  if (body.paidAt) {
    paidAt = new Date(body.paidAt);
    if (Number.isNaN(paidAt.getTime())) {
      return NextResponse.json({ error: "paidAt doit être une date ISO valide." }, { status: 400 });
    }
  }

  const invoice = await getInvoiceById(user.tenantId, invoiceId);
  if (!invoice) {
    return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
  }

  if (!(await canAccessAgency(user, invoice.agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  try {
    const payment = await createPayment({
      tenantId: user.tenantId,
      invoiceId,
      amount,
      method,
      paidAt,
      reference: body.reference,
      notes: body.notes,
    });
    return NextResponse.json({ payment }, { status: 201 });
  } catch (error) {
    if (error instanceof PaymentInvoiceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof InvalidPaymentAmountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvoiceCancelledError || error instanceof PaymentExceedsRemainingBalanceError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    console.error("Erreur lors de la création du paiement :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
