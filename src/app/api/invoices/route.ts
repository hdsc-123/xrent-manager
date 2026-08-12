import { NextResponse } from "next/server";
import type { InvoiceStatus } from "@prisma/client";
import { getSessionUser, canAccessAgency, getAccessibleAgencyIds } from "@/lib/authz";
import { getLocationById } from "@/lib/locations";
import {
  getInvoices,
  createInvoice,
  type InvoiceFilters,
  InvoiceLocationNotFoundError,
  InvalidInvoiceAmountError,
} from "@/lib/invoices";
import { logAction } from "@/lib/audit";

const INVOICE_STATUSES: InvoiceStatus[] = ["DRAFT", "SENT", "PARTIALLY_PAID", "PAID", "CANCELLED"];

export async function GET(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get("status") ?? undefined;
  const agencyId = searchParams.get("agencyId") ?? undefined;
  const clientId = searchParams.get("clientId") ?? undefined;
  const locationId = searchParams.get("locationId") ?? undefined;
  const fromParam = searchParams.get("from") ?? undefined;
  const toParam = searchParams.get("to") ?? undefined;

  if (statusParam && !INVOICE_STATUSES.includes(statusParam as InvoiceStatus)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }

  if (agencyId && !(await canAccessAgency(user, agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  const filters: InvoiceFilters = {
    status: statusParam as InvoiceStatus | undefined,
    agencyId,
    clientId,
    locationId,
    from: fromParam ? new Date(fromParam) : undefined,
    to: toParam ? new Date(toParam) : undefined,
  };

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const invoices = await getInvoices(user.tenantId, filters);

  const visibleInvoices =
    accessibleAgencyIds === null || agencyId
      ? invoices
      : invoices.filter((invoice) => accessibleAgencyIds.includes(invoice.agencyId));

  return NextResponse.json({ invoices: visibleInvoices });
}

interface CreateInvoiceBody {
  locationId?: string;
  taxRate?: number;
  discountAmount?: number;
  dueDate?: string;
  notes?: string;
}

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  let body: CreateInvoiceBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { locationId } = body;
  if (!locationId) {
    return NextResponse.json({ error: "locationId est requis." }, { status: 400 });
  }

  let dueDate: Date | undefined;
  if (body.dueDate) {
    dueDate = new Date(body.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      return NextResponse.json({ error: "dueDate doit être une date ISO valide." }, { status: 400 });
    }
  }

  // L'agence de la facture est dérivée de la Location côté serveur, jamais fournie par
  // le client (même principe que POST /api/locations pour Vehicle → Agency).
  const location = await getLocationById(user.tenantId, locationId);
  if (!location) {
    return NextResponse.json({ error: "Location introuvable." }, { status: 404 });
  }

  if (!(await canAccessAgency(user, location.agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  try {
    const invoice = await createInvoice({
      tenantId: user.tenantId,
      locationId,
      taxRate: body.taxRate,
      discountAmount: body.discountAmount,
      dueDate,
      notes: body.notes,
    });
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "invoice.created",
      resource: "Invoice",
      resourceId: invoice.id,
      metadata: { number: invoice.number, locationId: invoice.locationId },
    });
    return NextResponse.json({ invoice }, { status: 201 });
  } catch (error) {
    if (error instanceof InvoiceLocationNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof InvalidInvoiceAmountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("Erreur lors de la création de la facture :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
