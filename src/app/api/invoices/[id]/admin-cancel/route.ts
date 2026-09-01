import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_AUTHENTICATED_JSON_BODY_BYTES } from "@/lib/request-guards";
import {
  getInvoiceById,
  adminCancelInvoice,
  InvoiceNotAdminCancellableError,
  InvoiceAdminCancelConflictError,
  CorrectionReasonRequiredError,
} from "@/lib/invoices";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface AdminCancelInvoiceBody {
  /** Sprint 28 (Finding D2) : motif obligatoire — porté par chaque CashEntry de compensation
   * et par le journal d'audit ci-dessous. */
  reason?: string;
}

/**
 * Sprint 28 (Finding D2) — annule une facture PARTIALLY_PAID avec réversibilité financière
 * complète (compensation de caisse par Payment ACTIVE, Payment marqué REFUNDED). Réservé
 * ADMIN, dérivé uniquement de `user.role` côté route (jamais une permission granulaire — même
 * principe que POST /api/locations/[id]/admin-cancel, SECURITY.md section 4) ; tenant-scopé via
 * getInvoiceById, jamais un id arbitraire d'un autre tenant. Distincte de la transition
 * `PATCH /api/invoices/[id] { status: "VOID" }` (toujours refusée pour une facture
 * PARTIALLY_PAID, voir InvoiceCancellationRequiresAdminError) — c'est la seule route qui le
 * permette.
 */
export async function POST(request: Request, { params }: RouteParams) {
  if (isRequestBodyTooLarge(request, MAX_AUTHENTICATED_JSON_BODY_BYTES)) {
    return requestBodyTooLargeResponse(MAX_AUTHENTICATED_JSON_BODY_BYTES);
  }

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Réservé aux administrateurs." }, { status: 403 });
  }

  let body: AdminCancelInvoiceBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const reason = body.reason?.trim();
  if (!reason) {
    return NextResponse.json({ error: "Un motif est obligatoire pour annuler une facture PARTIALLY_PAID." }, { status: 400 });
  }

  const { id } = await params;
  const existing = await getInvoiceById(user.tenantId, id);
  if (!existing) {
    return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
  }
  // Sprint technique 4 : contrôle défensif ajouté pour rester cohérent avec les routes
  // soeurs (POST .../credit-notes, POST .../refund) — sans effet aujourd'hui puisque cette
  // route est déjà réservée ADMIN et que canAccessAgency autorise toujours un ADMIN sur son
  // propre tenant, mais évite qu'un futur cantonnement d'ADMIN par agence ne réintroduise un
  // IDOR silencieux ici.
  if (!(await canAccessAgency(user, existing.agencyId))) {
    return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
  }

  try {
    const result = await adminCancelInvoice(user.tenantId, id, {
      reason,
      performedByUserId: user.id,
    });
    if (!result) {
      return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
    }

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "invoice.admin_cancelled",
      resource: "Invoice",
      resourceId: id,
      metadata: {
        from: existing.status,
        reversedPaymentCount: result.reversedPaymentCount,
        reversedAmountTotal: result.reversedAmountTotal,
        refundedWithoutCashEntryCount: result.refundedWithoutCashEntryCount,
        currency: existing.currency,
        reason,
      },
    });

    return NextResponse.json({
      invoice: result.invoice,
      reversedPaymentCount: result.reversedPaymentCount,
      reversedAmountTotal: result.reversedAmountTotal,
      refundedWithoutCashEntryCount: result.refundedWithoutCashEntryCount,
    });
  } catch (error) {
    if (
      error instanceof InvoiceNotAdminCancellableError ||
      error instanceof InvoiceAdminCancelConflictError ||
      error instanceof CorrectionReasonRequiredError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de l'annulation administrateur de la facture :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
