import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicleTransferById, cancelVehicleTransfer, VehicleTransferNotEditableError } from "@/lib/vehicle-transfers";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "vehicle_transfers.cancel"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const transfer = await getVehicleTransferById(user.tenantId, id);
  const accessible =
    transfer &&
    ((await canAccessAgency(user, transfer.fromAgencyId)) || (await canAccessAgency(user, transfer.toAgencyId)));
  if (!transfer || !accessible) {
    return NextResponse.json({ error: "Transfert introuvable." }, { status: 404 });
  }

  try {
    const updated = await cancelVehicleTransfer(user.tenantId, transfer.id);

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "vehicle_transfer.cancelled",
      resource: "VehicleTransfer",
      resourceId: transfer.id,
      metadata: { vehicleId: transfer.vehicleId },
    });

    return NextResponse.json({ transfer: updated });
  } catch (error) {
    if (error instanceof VehicleTransferNotEditableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    console.error("Erreur lors de l'annulation du transfert :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
