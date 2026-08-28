import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { getVehicleById, reactivateVehicle, VehicleNotDeactivatedError } from "@/lib/vehicles";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Réactivation administrative d'un véhicule désactivé (sprint "statut opérationnel
 * automatique", 2026-08-28) — réservée ADMIN, même principe que deactivate/route.ts. Le
 * véhicule redevient utilisable pour de nouvelles opérations ; son statut opérationnel reste
 * entièrement calculé (src/lib/vehicle-status.ts), jamais modifié par cette route.
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
  const existing = await getVehicleById(user.tenantId, id);
  if (!existing || !(await canAccessAgency(user, existing.agencyId))) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }

  try {
    const vehicle = await reactivateVehicle(user.tenantId, id);
    if (!vehicle) {
      return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
    }

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "vehicle.reactivated",
      resource: "Vehicle",
      resourceId: id,
      metadata: { licensePlate: vehicle.licensePlate, previousReason: existing.deactivatedReason },
    });

    return NextResponse.json({ vehicle });
  } catch (error) {
    if (error instanceof VehicleNotDeactivatedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la réactivation du véhicule :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
