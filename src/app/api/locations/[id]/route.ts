import { NextResponse } from "next/server";
import type { LocationStatus, Prisma } from "@prisma/client";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import {
  getLocationById,
  updateLocation,
  deleteLocation,
  InvalidDateRangeError,
  VehicleNotAvailableError,
  InvalidStatusTransitionError,
  LocationNotDeletableError,
} from "@/lib/locations";
import { logAction } from "@/lib/audit";

const LOCATION_STATUSES: LocationStatus[] = ["PENDING", "CONFIRMED", "ACTIVE", "COMPLETED", "CANCELLED"];

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const location = await getLocationById(user.tenantId, id);

  if (!location || !(await canAccessAgency(user, location.agencyId))) {
    return NextResponse.json({ error: "Location introuvable." }, { status: 404 });
  }

  return NextResponse.json({ location });
}

interface UpdateLocationBody {
  status?: LocationStatus;
  startDate?: string;
  endDate?: string;
  notes?: string;
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const location = await getLocationById(user.tenantId, id);

  if (!location || !(await canAccessAgency(user, location.agencyId))) {
    return NextResponse.json({ error: "Location introuvable." }, { status: 404 });
  }

  let body: UpdateLocationBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.status && !LOCATION_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }

  const startDate = body.startDate ? new Date(body.startDate) : undefined;
  const endDate = body.endDate ? new Date(body.endDate) : undefined;

  if ((startDate && Number.isNaN(startDate.getTime())) || (endDate && Number.isNaN(endDate.getTime()))) {
    return NextResponse.json({ error: "startDate/endDate doivent être des dates ISO valides." }, { status: 400 });
  }

  try {
    const updated = await updateLocation(user.tenantId, location.id, {
      status: body.status,
      startDate,
      endDate,
      notes: body.notes,
    });
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: body.status && body.status !== location.status ? "location.status_changed" : "location.updated",
      resource: "Location",
      resourceId: location.id,
      metadata: { from: location.status, changes: body } as unknown as Prisma.InputJsonValue,
    });
    return NextResponse.json({ location: updated });
  } catch (error) {
    if (error instanceof InvalidDateRangeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidStatusTransitionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof VehicleNotAvailableError) {
      return NextResponse.json(
        { error: error.message, conflictingLocations: error.conflictingLocations },
        { status: 409 }
      );
    }

    console.error("Erreur lors de la modification de la location :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const location = await getLocationById(user.tenantId, id);

  if (!location || !(await canAccessAgency(user, location.agencyId))) {
    return NextResponse.json({ error: "Location introuvable." }, { status: 404 });
  }

  try {
    await deleteLocation(user.tenantId, location.id);
  } catch (error) {
    if (error instanceof LocationNotDeletableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "location.deleted",
    resource: "Location",
    resourceId: location.id,
    metadata: { status: location.status },
  });

  return NextResponse.json({ success: true });
}
