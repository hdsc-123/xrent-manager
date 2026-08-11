import { NextResponse } from "next/server";
import type { LocationStatus } from "@prisma/client";
import { getSessionUser, canAccessAgency, getAccessibleAgencyIds } from "@/lib/authz";
import { getVehicleById } from "@/lib/vehicles";
import {
  getLocations,
  createLocation,
  type LocationFilters,
  InvalidDateRangeError,
  VehicleNotFoundError,
  ClientNotFoundError,
  VehicleNotAvailableError,
} from "@/lib/locations";

const LOCATION_STATUSES: LocationStatus[] = ["PENDING", "CONFIRMED", "ACTIVE", "COMPLETED", "CANCELLED"];

export async function GET(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const vehicleId = searchParams.get("vehicleId") ?? undefined;
  const clientId = searchParams.get("clientId") ?? undefined;
  const agencyId = searchParams.get("agencyId") ?? undefined;
  const statusParam = searchParams.get("status") ?? undefined;
  const fromParam = searchParams.get("from") ?? undefined;
  const toParam = searchParams.get("to") ?? undefined;

  if (statusParam && !LOCATION_STATUSES.includes(statusParam as LocationStatus)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }

  if (agencyId && !(await canAccessAgency(user, agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  const filters: LocationFilters = {
    vehicleId,
    clientId,
    agencyId,
    status: statusParam as LocationStatus | undefined,
    from: fromParam ? new Date(fromParam) : undefined,
    to: toParam ? new Date(toParam) : undefined,
  };

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const locations = await getLocations(user.tenantId, filters);

  const visibleLocations =
    accessibleAgencyIds === null || agencyId
      ? locations
      : locations.filter((location) => accessibleAgencyIds.includes(location.agencyId));

  return NextResponse.json({ locations: visibleLocations });
}

interface CreateLocationBody {
  vehicleId?: string;
  clientId?: string;
  startDate?: string;
  endDate?: string;
  status?: LocationStatus;
  notes?: string;
}

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  let body: CreateLocationBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { vehicleId, clientId, startDate, endDate } = body;

  if (!vehicleId || !clientId || !startDate || !endDate) {
    return NextResponse.json(
      { error: "vehicleId, clientId, startDate et endDate sont requis." },
      { status: 400 }
    );
  }

  if (body.status && body.status !== "PENDING" && body.status !== "CONFIRMED") {
    return NextResponse.json(
      { error: "status ne peut être que PENDING ou CONFIRMED à la création." },
      { status: 400 }
    );
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return NextResponse.json(
      { error: "startDate et endDate doivent être des dates ISO valides." },
      { status: 400 }
    );
  }

  // L'agence de la location est dérivée du véhicule côté serveur, jamais fournie par le
  // client, pour empêcher toute incohérence véhicule/agence (SECURITY.md section 4).
  const vehicle = await getVehicleById(user.tenantId, vehicleId);
  if (!vehicle) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }

  if (!(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  try {
    const location = await createLocation({
      tenantId: user.tenantId,
      agencyId: vehicle.agencyId,
      vehicleId,
      clientId,
      startDate: start,
      endDate: end,
      status: body.status,
      notes: body.notes,
    });
    return NextResponse.json({ location }, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidDateRangeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof VehicleNotFoundError || error instanceof ClientNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof VehicleNotAvailableError) {
      return NextResponse.json(
        { error: error.message, conflictingLocations: error.conflictingLocations },
        { status: 409 }
      );
    }

    console.error("Erreur lors de la création de la location :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
