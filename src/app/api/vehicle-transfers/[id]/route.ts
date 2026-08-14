import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicleTransferById } from "@/lib/vehicle-transfers";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Un transfert est accessible si l'appelant a accès à l'agence de départ OU d'arrivée. */
async function canAccessTransfer(
  user: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>,
  transfer: { fromAgencyId: string; toAgencyId: string }
): Promise<boolean> {
  return (await canAccessAgency(user, transfer.fromAgencyId)) || (await canAccessAgency(user, transfer.toAgencyId));
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "vehicle_transfers.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const transfer = await getVehicleTransferById(user.tenantId, id);

  if (!transfer || !(await canAccessTransfer(user, transfer))) {
    return NextResponse.json({ error: "Transfert introuvable." }, { status: 404 });
  }

  return NextResponse.json({ transfer });
}
