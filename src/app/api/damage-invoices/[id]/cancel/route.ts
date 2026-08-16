import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import {
  getDamageInvoiceById,
  cancelDamageInvoice,
  DamageInvoiceAlreadyCancelledError,
  DamageInvoiceConflictError,
  CorrectionReasonRequiredError,
} from "@/lib/damage-invoices";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface CancelDamageInvoiceBody {
  reason?: string;
}

/**
 * Sprint 33 (DOMAINRULES.md section 48) — annulation d'une facture de dégâts, avec
 * réversibilité financière complète (chaque Payment ACTIVE lié passe à REFUNDED, compensation de
 * caisse liée à l'écriture d'origine) — même principe que POST /api/invoices/[id]/admin-cancel
 * (adminCancelInvoice) et POST /api/locations/[id]/admin-cancel (adminCancelValidatedLocation).
 * Motif obligatoire, conservé dans l'audit (même que CorrectionReasonRequiredError).
 */
export async function POST(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "damage_invoices.cancel"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const invoice = await getDamageInvoiceById(user.tenantId, id);
  if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) {
    return NextResponse.json({ error: "Facture de dégâts introuvable." }, { status: 404 });
  }

  let body: CancelDamageInvoiceBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (typeof body.reason !== "string" || !body.reason.trim()) {
    return NextResponse.json({ error: "Un motif est obligatoire pour annuler une facture de dégâts." }, { status: 400 });
  }

  try {
    const result = await cancelDamageInvoice(user.tenantId, id, {
      reason: body.reason,
      performedByUserId: user.id,
    });
    if (!result) {
      return NextResponse.json({ error: "Facture de dégâts introuvable." }, { status: 404 });
    }

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "damage_invoice.cancelled",
      resource: "DamageInvoice",
      resourceId: id,
      metadata: {
        reason: body.reason,
        reversedPaymentCount: result.reversedPaymentCount,
        reversedAmountTotal: result.reversedAmountTotal,
        refundedWithoutCashEntryCount: result.refundedWithoutCashEntryCount,
      },
    });

    return NextResponse.json({ damageInvoice: result.invoice });
  } catch (error) {
    if (error instanceof CorrectionReasonRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DamageInvoiceAlreadyCancelledError || error instanceof DamageInvoiceConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de l'annulation de la facture de dégâts :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
