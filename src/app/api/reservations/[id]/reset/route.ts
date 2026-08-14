import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import {
  getReservationById,
  resetReservationToPending,
  ReservationNotResettableError,
  ReservationResetRequiresCancelledContractError,
} from "@/lib/reservations";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Sprint 23 (DOMAINRULES.md section 39) — réinitialise une réservation terminale
 * (CONVERTED/CANCELLED/NO_SHOW) à PENDING. Réservé ADMIN, dérivé uniquement de `user.role`
 * côté route (jamais une permission granulaire, même principe que le reset de données —
 * SECURITY.md section 4 — ou l'admin override des contrats, DOMAINRULES.md section 37) :
 * tenant-scopé via getReservationById, jamais un id arbitraire d'un autre tenant.
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
  const existing = await getReservationById(user.tenantId, id);
  if (!existing) {
    return NextResponse.json({ error: "Réservation introuvable." }, { status: 404 });
  }

  try {
    const reservation = await resetReservationToPending(user.tenantId, id);
    if (!reservation) {
      return NextResponse.json({ error: "Réservation introuvable." }, { status: 404 });
    }

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "reservation.admin_reset",
      resource: "Reservation",
      resourceId: reservation.id,
      metadata: { from: existing.status },
    });

    return NextResponse.json({ reservation });
  } catch (error) {
    if (error instanceof ReservationResetRequiresCancelledContractError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ReservationNotResettableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la réinitialisation de la réservation :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
