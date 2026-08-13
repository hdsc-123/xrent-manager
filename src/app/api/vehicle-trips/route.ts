import { NextResponse } from "next/server";
import type { VehicleTripStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSessionUser, canAccessAgency, getAccessibleAgencyIds } from "@/lib/authz";
import {
  getVehicleTrips,
  createVehicleTrip,
  type VehicleTripFilters,
  VehicleTripVehicleNotFoundError,
  VehicleNotAvailableForTripError,
  InvalidStartOdometerError,
  InvalidFuelLevelError,
} from "@/lib/vehicle-trips";
import { getVehicleById } from "@/lib/vehicles";
import { logAction } from "@/lib/audit";

const TRIP_STATUSES: VehicleTripStatus[] = ["IN_PROGRESS", "COMPLETED", "CANCELLED"];

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const agencyIdParam = searchParams.get("agencyId") ?? undefined;
  const vehicleIdParam = searchParams.get("vehicleId") ?? undefined;
  const statusParam = searchParams.get("status") ?? undefined;

  if (statusParam && !TRIP_STATUSES.includes(statusParam as VehicleTripStatus)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }
  if (agencyIdParam && !(await canAccessAgency(user, agencyIdParam))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  const filters: VehicleTripFilters = {
    agencyId: agencyIdParam,
    vehicleId: vehicleIdParam,
    status: statusParam as VehicleTripStatus | undefined,
  };

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const trips = await getVehicleTrips(user.tenantId, filters);

  const visibleTrips =
    accessibleAgencyIds === null || agencyIdParam
      ? trips
      : trips.filter((trip) => accessibleAgencyIds.includes(trip.agencyId));

  return NextResponse.json({ trips: visibleTrips });
}

interface CreateVehicleTripBody {
  vehicleId?: string;
  employeeUserId?: string;
  reason?: string;
  destination?: string;
  departureDate?: string;
  startOdometer?: number;
  startFuelLevel?: number;
  remarks?: string;
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  let body: CreateVehicleTripBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { vehicleId, employeeUserId, reason, destination } = body;
  if (!vehicleId || !employeeUserId || !reason || !destination || body.startOdometer === undefined) {
    return NextResponse.json(
      { error: "vehicleId, employeeUserId, reason, destination et startOdometer sont requis." },
      { status: 400 }
    );
  }

  const departureDate = body.departureDate ? new Date(body.departureDate) : undefined;
  if (departureDate && Number.isNaN(departureDate.getTime())) {
    return NextResponse.json({ error: "departureDate doit être une date ISO valide." }, { status: 400 });
  }

  const employee = await prisma.user.findFirst({ where: { id: employeeUserId, tenantId: user.tenantId } });
  if (!employee) {
    return NextResponse.json({ error: "employeeUserId introuvable pour ce tenant." }, { status: 400 });
  }

  const vehicle = await getVehicleById(user.tenantId, vehicleId);
  if (!vehicle) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }
  if (!(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  try {
    const trip = await createVehicleTrip({
      tenantId: user.tenantId,
      vehicleId,
      employeeUserId,
      reason,
      destination,
      departureDate,
      startOdometer: body.startOdometer,
      startFuelLevel: body.startFuelLevel,
      remarks: body.remarks,
    });

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "vehicle_trip.created",
      resource: "VehicleTrip",
      resourceId: trip.id,
      metadata: { vehicleId: trip.vehicleId, destination: trip.destination },
    });

    return NextResponse.json({ trip }, { status: 201 });
  } catch (error) {
    if (error instanceof VehicleTripVehicleNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof VehicleNotAvailableForTripError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidStartOdometerError || error instanceof InvalidFuelLevelError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("Erreur lors de la création du bon de déplacement :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
