import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicleTripById } from "@/lib/vehicle-trips";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "vehicle_trips.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const trip = await getVehicleTripById(user.tenantId, id);

  if (!trip || !(await canAccessAgency(user, trip.agencyId))) {
    return NextResponse.json({ error: "Bon de déplacement introuvable." }, { status: 404 });
  }

  return NextResponse.json({ trip });
}
