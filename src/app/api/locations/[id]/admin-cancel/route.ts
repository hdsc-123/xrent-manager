import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import {
  getLocationById,
  adminCancelValidatedLocation,
  LocationNotAdminCancellableError,
  LocationStatusConflictError,
} from "@/lib/locations";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
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
export async function POST(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Réservé aux administrateurs." }, { status: 403 });
  }

  const { id } = await params;
  const existing = await getLocationById(user.tenantId, id);
  if (!existing) {
    return NextResponse.json({ error: "Location introuvable." }, { status: 404 });
  }

  try {
    const result = await adminCancelValidatedLocation(user.tenantId, id);
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
        currency: existing.currency,
      },
    });

    return NextResponse.json({
      location: result.location,
      cancelledInvoiceCount: result.cancelledInvoiceIds.length,
      reversedPaymentCount: result.reversedPaymentCount,
      reversedAmountTotal: result.reversedAmountTotal,
    });
  } catch (error) {
    if (error instanceof LocationNotAdminCancellableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof LocationStatusConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de l'annulation administrateur du contrat :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
