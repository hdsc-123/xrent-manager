import { NextResponse } from "next/server";
import type { VehicleStatus, Prisma } from "@prisma/client";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import {
  getVehicleById,
  updateVehicle,
  deleteVehicle,
  VehicleHasLocationsError,
} from "@/lib/vehicles";
import { logAction } from "@/lib/audit";

const VEHICLE_STATUSES: VehicleStatus[] = ["AVAILABLE", "RENTED", "MAINTENANCE", "INACTIVE"];

interface RouteParams {
  params: Promise<{ id: string }>;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const vehicle = await getVehicleById(user.tenantId, id);

  if (!vehicle || !(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }

  return NextResponse.json({ vehicle });
}

interface UpdateVehicleBody {
  agencyId?: string;
  name?: string;
  licensePlate?: string;
  make?: string;
  model?: string;
  year?: number;
  category?: string;
  status?: VehicleStatus;
  pricePerDay?: number;
  currency?: string;
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const vehicle = await getVehicleById(user.tenantId, id);

  if (!vehicle || !(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }

  let body: UpdateVehicleBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.pricePerDay !== undefined && (!Number.isInteger(body.pricePerDay) || body.pricePerDay <= 0)) {
    return NextResponse.json(
      { error: "pricePerDay doit être un entier positif (centimes)." },
      { status: 400 }
    );
  }

  if (body.year !== undefined && (!Number.isInteger(body.year) || body.year < 1900)) {
    return NextResponse.json({ error: "year invalide." }, { status: 400 });
  }

  if (body.status && !VEHICLE_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }

  if (body.agencyId && !(await canAccessAgency(user, body.agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  try {
    const updated = await updateVehicle(user.tenantId, vehicle.id, body);
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "vehicle.updated",
      resource: "Vehicle",
      resourceId: vehicle.id,
      metadata: { changes: body } as unknown as Prisma.InputJsonValue,
    });
    return NextResponse.json({ vehicle: updated });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "Cette immatriculation est déjà utilisée pour ce tenant." },
        { status: 409 }
      );
    }

    console.error("Erreur lors de la modification du véhicule :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const vehicle = await getVehicleById(user.tenantId, id);

  if (!vehicle || !(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }

  try {
    await deleteVehicle(user.tenantId, vehicle.id);
  } catch (error) {
    if (error instanceof VehicleHasLocationsError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "vehicle.deleted",
    resource: "Vehicle",
    resourceId: vehicle.id,
    metadata: { licensePlate: vehicle.licensePlate },
  });

  return NextResponse.json({ success: true });
}
