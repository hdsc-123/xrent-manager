import { NextResponse } from "next/server";
import type { InvoiceStatus } from "@prisma/client";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import {
  getInvoiceById,
  updateInvoice,
  deleteInvoice,
  InvalidInvoiceAmountError,
  InvoiceNotEditableError,
  InvalidInvoiceStatusTransitionError,
  InvoiceNotDeletableError,
} from "@/lib/invoices";

const INVOICE_STATUSES: InvoiceStatus[] = ["DRAFT", "SENT", "PARTIALLY_PAID", "PAID", "CANCELLED"];

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const invoice = await getInvoiceById(user.tenantId, id);

  if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) {
    return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
  }

  return NextResponse.json({ invoice });
}

interface UpdateInvoiceBody {
  status?: InvoiceStatus;
  taxRate?: number;
  discountAmount?: number;
  dueDate?: string | null;
  notes?: string;
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const invoice = await getInvoiceById(user.tenantId, id);

  if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) {
    return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
  }

  let body: UpdateInvoiceBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.status && !INVOICE_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }

  let dueDate: Date | null | undefined;
  if (body.dueDate === null) {
    dueDate = null;
  } else if (body.dueDate) {
    dueDate = new Date(body.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      return NextResponse.json({ error: "dueDate doit être une date ISO valide." }, { status: 400 });
    }
  }

  try {
    const updated = await updateInvoice(user.tenantId, invoice.id, {
      status: body.status,
      taxRate: body.taxRate,
      discountAmount: body.discountAmount,
      dueDate,
      notes: body.notes,
    });
    return NextResponse.json({ invoice: updated });
  } catch (error) {
    if (error instanceof InvalidInvoiceAmountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvoiceNotEditableError || error instanceof InvalidInvoiceStatusTransitionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    console.error("Erreur lors de la modification de la facture :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const invoice = await getInvoiceById(user.tenantId, id);

  if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) {
    return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
  }

  try {
    await deleteInvoice(user.tenantId, invoice.id);
  } catch (error) {
    if (error instanceof InvoiceNotDeletableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  return NextResponse.json({ success: true });
}
