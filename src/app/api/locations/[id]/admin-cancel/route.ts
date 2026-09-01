import { NextResponse } from "next/server";
import type { PaymentMethod } from "@prisma/client";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_AUTHENTICATED_JSON_BODY_BYTES } from "@/lib/request-guards";
import {
  getLocationById,
  adminCancelValidatedLocation,
  LocationNotAdminCancellableError,
  LocationStatusConflictError,
  CorrectionReasonRequiredError,
} from "@/lib/locations";
import { logAction } from "@/lib/audit";

const PAYMENT_METHODS: PaymentMethod[] = ["CASH", "CARD", "BANK_TRANSFER", "CHECK", "OTHER"];

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface AdminCancelBody {
  /** Sprint 26D (Finding D1) : motif obligatoire — porté par chaque CashEntry de
   * compensation de remboursement et par le journal d'audit ci-dessous. */
  reason?: string;
  /** Sprint 26D (Finding D1) : moyen de remboursement forcé, réservé à
   * payments.override_refund_method — jamais accepté silencieusement sans cette permission. */
  overrideRefundMethod?: PaymentMethod;
}

/**
 * Sprint 23 (DOMAINRULES.md section 39) — annule un contrat déjà validé (CONFIRMED/ACTIVE/
 * COMPLETED) avec réversibilité financière complète : factures annulées, écritures de caisse
 * de compensation. Réservé ADMIN, dérivé uniquement de `user.role` côté route (jamais une
 * permission granulaire — même principe que le reset de données/l'admin override des
 * contrats, SECURITY.md section 4, DOMAINRULES.md section 37) ; tenant-scopé via
 * getLocationById, jamais un id arbitraire d'un autre tenant. Distincte de la transition
 * `PATCH /api/locations/[id] { status: "CANCELLED" }` (toujours refusée pour un contrat déjà
 * validé, voir LocationCancellationRequiresAdminError) — c'est la seule route qui le permette.
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

  let body: AdminCancelBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const reason = body.reason?.trim();
  if (!reason) {
    return NextResponse.json({ error: "Un motif est obligatoire pour annuler un contrat validé." }, { status: 400 });
  }

  if (body.overrideRefundMethod !== undefined) {
    if (!PAYMENT_METHODS.includes(body.overrideRefundMethod)) {
      return NextResponse.json({ error: "overrideRefundMethod invalide." }, { status: 400 });
    }
    // Sprint 26D (Finding D1) : action exceptionnelle — par défaut, le remboursement reprend
    // toujours le moyen du paiement d'origine (voir adminCancelValidatedLocation), jamais
    // modifiable sans cette permission dédiée.
    if (!(await can(user, "payments.override_refund_method"))) {
      return NextResponse.json({ error: "Accès refusé (moyen de remboursement)." }, { status: 403 });
    }
  }

  const { id } = await params;
  const existing = await getLocationById(user.tenantId, id);
  if (!existing) {
    return NextResponse.json({ error: "Location introuvable." }, { status: 404 });
  }

  try {
    const result = await adminCancelValidatedLocation(user.tenantId, id, {
      reason,
      performedByUserId: user.id,
      overrideRefundMethod: body.overrideRefundMethod,
    });
    if (!result) {
      return NextResponse.json({ error: "Location introuvable." }, { status: 404 });
    }

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "location.admin_cancelled",
      resource: "Location",
      resourceId: id,
      metadata: {
        from: existing.status,
        cancelledInvoiceIds: result.cancelledInvoiceIds,
        reversedPaymentCount: result.reversedPaymentCount,
        reversedAmountTotal: result.reversedAmountTotal,
        refundedWithoutCashEntryCount: result.refundedWithoutCashEntryCount,
        currency: existing.currency,
        reason,
      },
    });

    // Sprint 26D (Finding D1) : journalisation dédiée, distincte de location.admin_cancelled
    // ci-dessus, pour chaque remboursement dont le moyen a été forcé — ancien moyen, nouveau
    // moyen, agent, date (createdAt du log) et motif, comme exigé pour l'usage de
    // payments.override_refund_method.
    for (const refund of result.refunds) {
      if (refund.appliedMethod && refund.appliedMethod !== refund.originalMethod) {
        await logAction({
          tenantId: user.tenantId,
          userId: user.id,
          action: "payment.refund_method_overridden",
          resource: "Payment",
          resourceId: refund.paymentId,
          metadata: {
            previousMethod: refund.originalMethod,
            newMethod: refund.appliedMethod,
            reason,
          },
        });
      }
    }

    return NextResponse.json({
      location: result.location,
      cancelledInvoiceCount: result.cancelledInvoiceIds.length,
      reversedPaymentCount: result.reversedPaymentCount,
      reversedAmountTotal: result.reversedAmountTotal,
      refundedWithoutCashEntryCount: result.refundedWithoutCashEntryCount,
    });
  } catch (error) {
    if (
      error instanceof LocationNotAdminCancellableError ||
      error instanceof LocationStatusConflictError ||
      error instanceof CorrectionReasonRequiredError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de l'annulation administrateur du contrat :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
