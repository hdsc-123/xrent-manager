import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import {
  getVehicleById,
  deactivateVehicle,
  VehicleAlreadyDeactivatedError,
  DeactivationReasonRequiredError,
} from "@/lib/vehicles";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface DeactivateBody {
  reason?: string;
}

/**
 * Désactivation administrative d'un véhicule (sprint "statut opérationnel automatique",
 * 2026-08-28) — remplace l'ancien `VehicleStatus.INACTIVE`, réservée ADMIN (contrôle de rôle
 * strict côté route, jamais une permission granulaire — même principe que
 * POST /api/locations/[id]/admin-cancel, DOMAINRULES.md section 43). Motif obligatoire,
 * toujours journalisé. Orthogonale au statut opérationnel calculé (src/lib/vehicle-status.ts) :
 * bloque toute nouvelle Location/Maintenance/VehicleTransfer/VehicleTrip quel que soit ce
 * statut, sans jamais le modifier lui-même.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Réservé aux administrateurs." }, { status: 403 });
  }

  let body: DeactivateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { id } = await params;
  const existing = await getVehicleById(user.tenantId, id);
  if (!existing || !(await canAccessAgency(user, existing.agencyId))) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }

  try {
    const vehicle = await deactivateVehicle(user.tenantId, id, body.reason ?? "", user.id);
    if (!vehicle) {
      return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
    }

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "vehicle.deactivated",
      resource: "Vehicle",
      resourceId: id,
      metadata: { licensePlate: vehicle.licensePlate, reason: vehicle.deactivatedReason },
    });

    return NextResponse.json({ vehicle });
  } catch (error) {
    if (error instanceof DeactivationReasonRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof VehicleAlreadyDeactivatedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la désactivation du véhicule :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
