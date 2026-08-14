import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import {
  getVehicleTripById,
  returnVehicleTrip,
  VehicleTripNotEditableError,
  InvalidVehicleTripOdometerError,
  InvalidFuelLevelError,
  MissingFuelLevelError,
} from "@/lib/vehicle-trips";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface ReturnBody {
  returnDate?: string;
  endOdometer?: number;
  endFuelLevel?: number;
  remarks?: string;
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "vehicle_trips.return"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const trip = await getVehicleTripById(user.tenantId, id);
  if (!trip || !(await canAccessAgency(user, trip.agencyId))) {
    return NextResponse.json({ error: "Bon de déplacement introuvable." }, { status: 404 });
  }

  let body: ReturnBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.endOdometer === undefined) {
    return NextResponse.json({ error: "endOdometer est requis." }, { status: 400 });
  }
  // Sprint 19 (DOMAINRULES.md section 37) : carburant retour désormais obligatoire, même
  // logique que le transfert entre agences.
  if (body.endFuelLevel === undefined) {
    return NextResponse.json({ error: "endFuelLevel est requis." }, { status: 400 });
  }

  const returnDate = body.returnDate ? new Date(body.returnDate) : undefined;
  if (returnDate && Number.isNaN(returnDate.getTime())) {
    return NextResponse.json({ error: "returnDate doit être une date ISO valide." }, { status: 400 });
  }

  try {
    const updated = await returnVehicleTrip(user.tenantId, trip.id, {
      returnDate,
      endOdometer: body.endOdometer,
      endFuelLevel: body.endFuelLevel,
      remarks: body.remarks,
    });

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "vehicle_trip.returned",
      resource: "VehicleTrip",
      resourceId: trip.id,
      metadata: { vehicleId: trip.vehicleId, endOdometer: body.endOdometer },
    });

    return NextResponse.json({ trip: updated });
  } catch (error) {
    if (error instanceof VehicleTripNotEditableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidVehicleTripOdometerError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidFuelLevelError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof MissingFuelLevelError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("Erreur lors du retour du bon de déplacement :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
