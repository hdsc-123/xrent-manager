import { NextResponse } from "next/server";
import type { VehicleTransferStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSessionUser, canAccessAgency, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_AUTHENTICATED_JSON_BODY_BYTES } from "@/lib/request-guards";
import {
  getVehicleTransfers,
  createVehicleTransfer,
  type VehicleTransferFilters,
  VehicleTransferVehicleNotFoundError,
  VehicleTransferAgencyNotFoundError,
  SameAgencyTransferError,
  VehicleNotAvailableForTransferError,
  InvalidFuelLevelError,
} from "@/lib/vehicle-transfers";
import { getVehicleById } from "@/lib/vehicles";
import { VehicleDeactivatedError } from "@/lib/vehicle-status";
import { logAction } from "@/lib/audit";

const TRANSFER_STATUSES: VehicleTransferStatus[] = ["IN_TRANSIT", "COMPLETED", "CANCELLED"];

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "vehicle_transfers.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const agencyIdParam = searchParams.get("agencyId") ?? undefined;
  const vehicleIdParam = searchParams.get("vehicleId") ?? undefined;
  const statusParam = searchParams.get("status") ?? undefined;

  if (statusParam && !TRANSFER_STATUSES.includes(statusParam as VehicleTransferStatus)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }
  if (agencyIdParam && !(await canAccessAgency(user, agencyIdParam))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  const filters: VehicleTransferFilters = {
    agencyId: agencyIdParam,
    vehicleId: vehicleIdParam,
    status: statusParam as VehicleTransferStatus | undefined,
  };

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const transfers = await getVehicleTransfers(user.tenantId, filters);

  // Un MEMBER ne voit que les transferts touchant une agence à laquelle il est rattaché
  // (départ ou arrivée) — même principe que vehicles/locations (SECURITY.md section 2).
  const visibleTransfers =
    accessibleAgencyIds === null || agencyIdParam
      ? transfers
      : transfers.filter(
          (transfer) =>
            accessibleAgencyIds.includes(transfer.fromAgencyId) ||
            accessibleAgencyIds.includes(transfer.toAgencyId)
        );

  return NextResponse.json({ transfers: visibleTransfers });
}

interface CreateVehicleTransferBody {
  vehicleId?: string;
  toAgencyId?: string;
  fromCity?: string;
  toCity?: string;
  departureDate?: string;
  startOdometer?: number;
  startFuelLevel?: number;
  responsibleUserId?: string;
  reason?: string;
  notes?: string;
}

export async function POST(request: Request) {
  if (isRequestBodyTooLarge(request, MAX_AUTHENTICATED_JSON_BODY_BYTES)) {
    return requestBodyTooLargeResponse(MAX_AUTHENTICATED_JSON_BODY_BYTES);
  }

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "vehicle_transfers.create"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  let body: CreateVehicleTransferBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { vehicleId, toAgencyId, responsibleUserId } = body;
  if (!vehicleId || !toAgencyId || !responsibleUserId) {
    return NextResponse.json(
      { error: "vehicleId, toAgencyId et responsibleUserId sont requis." },
      { status: 400 }
    );
  }

  const departureDate = body.departureDate ? new Date(body.departureDate) : undefined;
  if (departureDate && Number.isNaN(departureDate.getTime())) {
    return NextResponse.json({ error: "departureDate doit être une date ISO valide." }, { status: 400 });
  }

  if (
    (body.startOdometer !== undefined && (!Number.isInteger(body.startOdometer) || body.startOdometer < 0)) ||
    (body.startFuelLevel !== undefined && !Number.isInteger(body.startFuelLevel))
  ) {
    return NextResponse.json({ error: "startOdometer/startFuelLevel invalides." }, { status: 400 });
  }

  // Le responsable désigné doit être un user réel du même tenant (jamais un id arbitraire).
  const responsible = await prisma.user.findFirst({ where: { id: responsibleUserId, tenantId: user.tenantId } });
  if (!responsible) {
    return NextResponse.json({ error: "responsibleUserId introuvable pour ce tenant." }, { status: 400 });
  }

  // fromAgencyId est dérivé du véhicule (jamais fourni par le client, voir createVehicleTransfer)
  // — seul l'accès à l'agence de DÉPART est exigé pour lancer un transfert (SECURITY.md
  // section 4). Correctif Sprint 19 (DOMAINRULES.md section 37, bug réel) : exiger aussi
  // l'accès à l'agence d'ARRIVÉE ici empêchait un employé d'une agence satellite d'envoyer un
  // véhicule vers une agence à laquelle il n'est pas rattaché (ex. le siège) — alors que c'est
  // précisément le cas d'usage du module. L'agence d'arrivée reste vérifiée à la réception
  // (PATCH .../validate, réservé à un user ayant accès à toAgencyId — voir ce fichier).
  const vehicle = await getVehicleById(user.tenantId, vehicleId);
  if (!vehicle) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }
  if (!(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Accès refusé à l'agence de départ." }, { status: 403 });
  }

  try {
    const transfer = await createVehicleTransfer({
      tenantId: user.tenantId,
      vehicleId,
      toAgencyId,
      fromCity: body.fromCity,
      toCity: body.toCity,
      departureDate,
      startOdometer: body.startOdometer,
      startFuelLevel: body.startFuelLevel,
      responsibleUserId,
      reason: body.reason,
      notes: body.notes,
    });

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "vehicle_transfer.created",
      resource: "VehicleTransfer",
      resourceId: transfer.id,
      metadata: { vehicleId: transfer.vehicleId, fromAgencyId: transfer.fromAgencyId, toAgencyId: transfer.toAgencyId },
    });
    return NextResponse.json({ transfer }, { status: 201 });
  } catch (error) {
    if (error instanceof VehicleTransferVehicleNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof VehicleTransferAgencyNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof SameAgencyTransferError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof VehicleNotAvailableForTransferError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidFuelLevelError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof VehicleDeactivatedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    console.error("Erreur lors de la création du transfert :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
