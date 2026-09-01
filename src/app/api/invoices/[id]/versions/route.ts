import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_AUTHENTICATED_JSON_BODY_BYTES } from "@/lib/request-guards";
import {
  getInvoiceById,
  versionInvoice,
  getInvoiceVersionHistory,
  InvoiceNotVersionableError,
  InvoiceVersionReasonRequiredError,
  InvoiceVersionConflictError,
} from "@/lib/invoices";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Sprint 26E : historique complet de la chaîne de versions (racine + toutes les versions),
 * trié par versionNumber croissant. */
export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "invoices.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const invoice = await getInvoiceById(user.tenantId, id);
  if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) {
    return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
  }

  const history = await getInvoiceVersionHistory(user.tenantId, id);
  return NextResponse.json({ history });
}

interface VersionInvoiceBody {
  reason?: string;
}

/**
 * Sprint 26E : versionnement documentaire — jamais un avoir. Réservé aux factures ISSUED sans
 * aucun Payment (voir versionInvoice, src/lib/invoices.ts). Motif obligatoire, journalisé avec
 * l'utilisateur et les deux factures concernées. Une seule création concurrente réussit
 * (201), les autres reçoivent 409 (InvoiceVersionConflictError).
 */
export async function POST(request: Request, { params }: RouteParams) {
  if (isRequestBodyTooLarge(request, MAX_AUTHENTICATED_JSON_BODY_BYTES)) {
    return requestBodyTooLargeResponse(MAX_AUTHENTICATED_JSON_BODY_BYTES);
  }

  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "invoices.version"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const invoice = await getInvoiceById(user.tenantId, id);
  if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) {
    return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
  }

  let body: VersionInvoiceBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const reason = body.reason?.trim();
  if (!reason) {
    return NextResponse.json(
      { error: "Un motif est obligatoire pour créer une nouvelle version d'une facture." },
      { status: 400 }
    );
  }

  try {
    const result = await versionInvoice(user.tenantId, id, { reason, performedByUserId: user.id });
    if (!result) {
      return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
    }

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "invoice.versioned",
      resource: "Invoice",
      resourceId: result.oldInvoice.id,
      metadata: {
        reasonCode: "FACTURE_VERSIONNEE",
        reason,
        oldInvoiceId: result.oldInvoice.id,
        oldNumber: result.oldInvoice.number,
        newInvoiceId: result.newInvoice.id,
        newNumber: result.newInvoice.number,
        versionNumber: result.newInvoice.versionNumber,
      },
    });

    return NextResponse.json({ invoice: result.newInvoice, replacedInvoice: result.oldInvoice }, { status: 201 });
  } catch (error) {
    if (error instanceof InvoiceNotVersionableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvoiceVersionConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvoiceVersionReasonRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("Erreur lors du versionnement de la facture :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
