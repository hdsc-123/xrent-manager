import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicleById, getVehicleLastKnownState } from "@/lib/vehicles";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Sprint 19 (DOMAINRULES.md section 37) : dernier kilométrage/carburant connus d'un véhicule
 * (retour de sa dernière Location/VehicleTransfer/VehicleTrip), pour pré-remplir automatiquement
 * le départ d'un nouveau transfert/bon de déplacement — voir getVehicleLastKnownState,
 * src/lib/vehicles.ts. */
export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "vehicles.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const vehicle = await getVehicleById(user.tenantId, id);

  if (!vehicle || !(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }

  const state = await getVehicleLastKnownState(user.tenantId, vehicle.id);
  return NextResponse.json(state);
}
