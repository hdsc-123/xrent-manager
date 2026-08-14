import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicleTripById, cancelVehicleTrip, VehicleTripNotEditableError } from "@/lib/vehicle-trips";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "vehicle_trips.cancel"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const trip = await getVehicleTripById(user.tenantId, id);
  if (!trip || !(await canAccessAgency(user, trip.agencyId))) {
    return NextResponse.json({ error: "Bon de déplacement introuvable." }, { status: 404 });
  }

  try {
    const updated = await cancelVehicleTrip(user.tenantId, trip.id);

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "vehicle_trip.cancelled",
      resource: "VehicleTrip",
      resourceId: trip.id,
      metadata: { vehicleId: trip.vehicleId },
    });

    return NextResponse.json({ trip: updated });
  } catch (error) {
    if (error instanceof VehicleTripNotEditableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    console.error("Erreur lors de l'annulation du bon de déplacement :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
