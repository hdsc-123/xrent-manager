import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import {
  getVehicleTransferById,
  validateVehicleTransfer,
  VehicleTransferNotEditableError,
  InvalidVehicleTransferOdometerError,
  InvalidVehicleTransferDateRangeError,
  InvalidFuelLevelError,
} from "@/lib/vehicle-transfers";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface ValidateBody {
  arrivalDate?: string;
  endOdometer?: number;
  endFuelLevel?: number;
  notes?: string;
}

/**
 * Réception du véhicule à l'agence d'arrivée — réservée à un user ayant accès à l'agence
 * d'arrivée (c'est elle qui réceptionne, pas l'agence de départ).
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "vehicle_transfers.validate"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const transfer = await getVehicleTransferById(user.tenantId, id);
  if (!transfer || !(await canAccessAgency(user, transfer.toAgencyId))) {
    return NextResponse.json({ error: "Transfert introuvable." }, { status: 404 });
  }

  let body: ValidateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const arrivalDate = body.arrivalDate ? new Date(body.arrivalDate) : undefined;
  if (arrivalDate && Number.isNaN(arrivalDate.getTime())) {
    return NextResponse.json({ error: "arrivalDate doit être une date ISO valide." }, { status: 400 });
  }
  if (body.endOdometer !== undefined && (!Number.isInteger(body.endOdometer) || body.endOdometer < 0)) {
    return NextResponse.json({ error: "endOdometer doit être un entier positif ou nul." }, { status: 400 });
  }

  try {
    const updated = await validateVehicleTransfer(user.tenantId, transfer.id, {
      arrivalDate,
      endOdometer: body.endOdometer,
      endFuelLevel: body.endFuelLevel,
      notes: body.notes,
    });

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "vehicle_transfer.validated",
      resource: "VehicleTransfer",
      resourceId: transfer.id,
      metadata: { vehicleId: transfer.vehicleId, toAgencyId: transfer.toAgencyId },
    });

    return NextResponse.json({ transfer: updated });
  } catch (error) {
    if (error instanceof VehicleTransferNotEditableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidVehicleTransferOdometerError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidVehicleTransferDateRangeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidFuelLevelError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("Erreur lors de la validation du transfert :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
