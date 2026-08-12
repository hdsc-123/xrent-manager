import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicleById } from "@/lib/vehicles";
import { getClientById, createClient, updateClient, findDuplicateClient } from "@/lib/clients";
import {
  getReservationById,
  markReservationConverted,
  combineDateAndTime,
  canTransition,
  InvalidReservationStatusTransitionError,
} from "@/lib/reservations";
import {
  createLocation,
  InvalidDateRangeError,
  VehicleNotFoundError,
  ClientNotFoundError,
  VehicleNotAvailableError,
} from "@/lib/locations";
import { createInvoice } from "@/lib/invoices";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface ConvertBody {
  vehicleId?: string;
  useExistingClientId?: string;
  forceCreateClient?: boolean;
  startOdometer?: number;
  endOdometer?: number;
  deposit?: number;
}

/**
 * Convertit une réservation en contrat (Location) : résout/crée le client (détection de
 * doublons, même flux que POST /api/clients — voir DuplicateCheck.tsx), dérive l'agence du
 * véhicule choisi par l'utilisateur (pickupAgency/vehicleCategory de la réservation restent
 * du texte libre non fiable, voir prisma/schema.prisma), crée la Location puis, de façon
 * résiliente, la facture — même répartition et même principe de résilience que
 * POST /api/locations (Sprint 12B).
 */
export async function POST(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "reservations.convert"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const reservation = await getReservationById(user.tenantId, id);
  if (!reservation) {
    return NextResponse.json({ error: "Réservation introuvable." }, { status: 404 });
  }

  // Vérifiée ici, avant toute création de Location, pour éviter de créer une Location
  // orpheline si la réservation est déjà CONVERTED/CANCELLED (markReservationConverted
  // revérifie de toute façon la transition juste avant d'écrire le statut).
  if (!canTransition(reservation.status, "CONVERTED")) {
    return NextResponse.json(
      { error: `Transition de statut invalide : ${reservation.status} → CONVERTED.` },
      { status: 409 }
    );
  }

  let body: ConvertBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (!body.vehicleId) {
    return NextResponse.json({ error: "vehicleId est requis." }, { status: 400 });
  }

  for (const field of ["startOdometer", "endOdometer", "deposit"] as const) {
    const value = body[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      return NextResponse.json({ error: `${field} doit être un entier positif ou nul.` }, { status: 400 });
    }
  }

  const vehicle = await getVehicleById(user.tenantId, body.vehicleId);
  if (!vehicle) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }
  if (!(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  // Résolution du client (même logique que POST /api/clients, voir DOMAINRULES.md section 9).
  let clientId: string;
  if (body.useExistingClientId) {
    const existingClient = await getClientById(user.tenantId, body.useExistingClientId);
    if (!existingClient) {
      return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
    }
    if (reservation.clientPhone && reservation.clientPhone !== existingClient.phone) {
      await updateClient(user.tenantId, existingClient.id, { phone: reservation.clientPhone });
    }
    clientId = existingClient.id;
  } else {
    const duplicate = await findDuplicateClient(user.tenantId, {
      phone: reservation.clientPhone ?? undefined,
      firstName: reservation.clientFirstName,
      lastName: reservation.clientLastName,
    });

    if (duplicate && !body.forceCreateClient) {
      return NextResponse.json(
        { duplicate: { client: duplicate.client, matchType: duplicate.matchType, field: duplicate.field } },
        { status: 409 }
      );
    }

    const name = `${reservation.clientFirstName} ${reservation.clientLastName}`.trim();
    const notes = duplicate
      ? `Créé malgré une correspondance possible avec ${duplicate.client.name} (conversion de la réservation ${reservation.voucherNumber}).`
      : undefined;

    const newClient = await createClient({
      tenantId: user.tenantId,
      name,
      firstName: reservation.clientFirstName,
      lastName: reservation.clientLastName,
      phone: reservation.clientPhone ?? undefined,
      notes,
    });
    clientId = newClient.id;
  }

  const startDate = combineDateAndTime(reservation.startDate, reservation.startTime ?? undefined);
  const endDate = combineDateAndTime(reservation.endDate, reservation.endTime ?? undefined);

  try {
    const location = await createLocation({
      tenantId: user.tenantId,
      agencyId: vehicle.agencyId,
      vehicleId: vehicle.id,
      clientId,
      startDate,
      endDate,
      notes: reservation.notes ?? undefined,
      startOdometer: body.startOdometer,
      endOdometer: body.endOdometer,
      deposit: body.deposit,
    });

    const updatedReservation = await markReservationConverted(user.tenantId, reservation.id, location.id);

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "reservation.converted",
      resource: "Reservation",
      resourceId: reservation.id,
      metadata: { locationId: location.id, clientId },
    });
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "location.created",
      resource: "Location",
      resourceId: location.id,
      metadata: { vehicleId: location.vehicleId, clientId: location.clientId, fromReservationId: reservation.id },
    });

    // Génération automatique de facture, résiliente — même principe que POST /api/locations
    // (Sprint 12B) : un échec ne doit jamais faire échouer la conversion elle-même.
    let invoice = null;
    try {
      invoice = await createInvoice({ tenantId: user.tenantId, locationId: location.id });
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "invoice.created",
        resource: "Invoice",
        resourceId: invoice.id,
        metadata: { number: invoice.number, locationId: invoice.locationId, auto: true },
      });
    } catch (error) {
      console.error("Erreur lors de la génération automatique de la facture :", error);
    }

    return NextResponse.json({ reservation: updatedReservation, location, invoice }, { status: 201 });
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
    if (error instanceof InvalidReservationStatusTransitionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la conversion de la réservation :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
