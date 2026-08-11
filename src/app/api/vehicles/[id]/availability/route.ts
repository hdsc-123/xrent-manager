import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { getVehicleById, checkAvailability } from "@/lib/vehicles";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const vehicle = await getVehicleById(user.tenantId, id);

  if (!vehicle || !(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const startParam = searchParams.get("start");
  const endParam = searchParams.get("end");

  if (!startParam || !endParam) {
    return NextResponse.json({ error: "start et end (dates ISO) sont requis." }, { status: 400 });
  }

  const start = new Date(startParam);
  const end = new Date(endParam);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return NextResponse.json({ error: "start et end doivent être des dates ISO valides." }, { status: 400 });
  }

  if (end <= start) {
    return NextResponse.json({ error: "end doit être postérieure à start." }, { status: 400 });
  }

  const result = await checkAvailability(user.tenantId, vehicle.id, start, end);

  return NextResponse.json(result);
}
