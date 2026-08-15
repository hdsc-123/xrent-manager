import { NextResponse } from "next/server";
import type { Prisma, ReservationStatus } from "@prisma/client";
import { getSessionUser, canAccessReservationAgencies, canEditReservationAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import {
  getReservationById,
  updateReservation,
  deleteReservation,
  getKnownAgencyNames,
  InvalidReservationDateRangeError,
  InvalidReservationStatusTransitionError,
  ReservationLockedError,
  ReservationNotDeletableError,
} from "@/lib/reservations";
import { logAction } from "@/lib/audit";

const RESERVATION_STATUSES: ReservationStatus[] = ["PENDING", "CONFIRMED", "CONVERTED", "CANCELLED", "NO_SHOW"];
const MONEY_FIELDS = ["totalPrice", "pricePerDay", "gpsPrice", "babySeatPrice", "extraDriverPrice"] as const;
const INT_FIELDS = ["daysCount", "mileage", "includedKm"] as const;

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "reservations.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const reservation = await getReservationById(user.tenantId, id);
  if (!reservation || !(await canAccessReservationAgencies(user, reservation))) {
    return NextResponse.json({ error: "Réservation introuvable." }, { status: 404 });
  }

  return NextResponse.json({ reservation });
}

interface PatchReservationBody {
  voucherNumber?: string;
  confirmationNumber?: string;
  receivedAt?: string;
  source?: string;
  clientFirstName?: string;
  clientLastName?: string;
  startDate?: string;
  startTime?: string;
  endDate?: string;
  endTime?: string;
  daysCount?: number;
  flightNumber?: string;
  currency?: string;
  totalPrice?: number;
  pricePerDay?: number;
  vehicleCategory?: string;
  pickupAgency?: string;
  dropoffAgency?: string;
  hasGps?: boolean;
  gpsPrice?: number;
  hasBabySeat?: boolean;
  babySeatPrice?: number;
  hasExtraDriver?: boolean;
  extraDriverPrice?: number;
  optionsCurrency?: string;
  mileage?: number;
  includedKm?: number;
  clientPhone?: string;
  notes?: string;
  status?: ReservationStatus;
}

/**
 * Sprint 24 : confirmer/annuler/marquer No Show une réservation ne sont plus couverts par
 * reservations.edit (la même clé que la modification de champ) — chaque transition de statut
 * vérifie désormais sa propre clé dédiée. La conversion en contrat reste hors de cette route
 * (POST .../convert, reservations.convert, inchangé) ; toute autre valeur de body.status
 * (CONVERTED, ou un statut inchangé) retombe sur reservations.edit, comportement antérieur
 * conservé pour ne pas régresser sur un cas non demandé par ce sprint.
 */
function requiredPermissionForStatusChange(status: ReservationStatus | undefined): string {
  switch (status) {
    case "CONFIRMED":
      return "reservations.confirm";
    case "CANCELLED":
      return "reservations.cancel";
    case "NO_SHOW":
      return "reservations.no_show";
    default:
      return "reservations.edit";
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  let body: PatchReservationBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.status !== undefined && !RESERVATION_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }

  const requiredPermission = requiredPermissionForStatusChange(body.status);
  if (!(await can(user, requiredPermission))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;

  const existingReservation = await getReservationById(user.tenantId, id);
  if (!existingReservation || !(await canAccessReservationAgencies(user, existingReservation))) {
    return NextResponse.json({ error: "Réservation introuvable." }, { status: 404 });
  }
  // Sprint 19 (DOMAINRULES.md section 37) : seule l'agence de départ peut modifier/convertir
  // une réservation — l'agence d'arrivée (visible ci-dessus via canAccessReservationAgencies)
  // ne peut que la consulter.
  if (!(await canEditReservationAgency(user, existingReservation))) {
    return NextResponse.json({ error: "Seule l'agence de départ peut modifier cette réservation." }, { status: 403 });
  }

  for (const field of MONEY_FIELDS) {
    const value = body[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      return NextResponse.json(
        { error: `${field} doit être un entier positif ou nul (centimes).` },
        { status: 400 }
      );
    }
  }
  for (const field of INT_FIELDS) {
    const value = body[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      return NextResponse.json({ error: `${field} doit être un entier positif ou nul.` }, { status: 400 });
    }
  }

  const startDate = body.startDate ? new Date(body.startDate) : undefined;
  const endDate = body.endDate ? new Date(body.endDate) : undefined;
  if ((startDate && Number.isNaN(startDate.getTime())) || (endDate && Number.isNaN(endDate.getTime()))) {
    return NextResponse.json({ error: "startDate/endDate doivent être des dates ISO valides." }, { status: 400 });
  }
  const receivedAt = body.receivedAt ? new Date(body.receivedAt) : undefined;
  if (receivedAt && Number.isNaN(receivedAt.getTime())) {
    return NextResponse.json({ error: "receivedAt doit être une date ISO valide." }, { status: 400 });
  }

  // Villes/agences (Sprint 17) : même règle que POST /api/reservations, jusqu'ici absente de
  // PATCH — une valeur qui serait refusée à la création pouvait être écrite silencieusement
  // via l'édition. Voir src/lib/reservations.ts getKnownAgencyNames.
  if (body.pickupAgency || body.dropoffAgency) {
    const knownAgencyNames = await getKnownAgencyNames(user.tenantId);
    if (knownAgencyNames.size > 0) {
      if (body.pickupAgency && !knownAgencyNames.has(body.pickupAgency.trim().toLowerCase())) {
        return NextResponse.json(
          { error: `Ville de départ inconnue : "${body.pickupAgency}" (aucune agence correspondante)` },
          { status: 400 }
        );
      }
      if (body.dropoffAgency && !knownAgencyNames.has(body.dropoffAgency.trim().toLowerCase())) {
        return NextResponse.json(
          { error: `Ville de retour inconnue : "${body.dropoffAgency}" (aucune agence correspondante)` },
          { status: 400 }
        );
      }
    }
  }

  try {
    const reservation = await updateReservation(user.tenantId, id, {
      voucherNumber: body.voucherNumber,
      confirmationNumber: body.confirmationNumber,
      receivedAt,
      source: body.source,
      clientFirstName: body.clientFirstName,
      clientLastName: body.clientLastName,
      startDate,
      startTime: body.startTime,
      endDate,
      endTime: body.endTime,
      daysCount: body.daysCount,
      flightNumber: body.flightNumber,
      currency: body.currency,
      totalPrice: body.totalPrice,
      pricePerDay: body.pricePerDay,
      vehicleCategory: body.vehicleCategory,
      pickupAgency: body.pickupAgency,
      dropoffAgency: body.dropoffAgency,
      hasGps: body.hasGps,
      gpsPrice: body.gpsPrice,
      hasBabySeat: body.hasBabySeat,
      babySeatPrice: body.babySeatPrice,
      hasExtraDriver: body.hasExtraDriver,
      extraDriverPrice: body.extraDriverPrice,
      optionsCurrency: body.optionsCurrency,
      mileage: body.mileage,
      includedKm: body.includedKm,
      clientPhone: body.clientPhone,
      notes: body.notes,
      status: body.status,
    });

    if (!reservation) {
      return NextResponse.json({ error: "Réservation introuvable." }, { status: 404 });
    }

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: body.status ? "reservation.status_changed" : "reservation.updated",
      resource: "Reservation",
      resourceId: reservation.id,
      metadata: { changes: body } as unknown as Prisma.InputJsonValue,
    });

    return NextResponse.json({ reservation });
  } catch (error) {
    if (error instanceof InvalidReservationDateRangeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidReservationStatusTransitionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ReservationLockedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la modification de la réservation :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "reservations.delete"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;

  const existingReservation = await getReservationById(user.tenantId, id);
  if (!existingReservation || !(await canAccessReservationAgencies(user, existingReservation))) {
    return NextResponse.json({ error: "Réservation introuvable." }, { status: 404 });
  }
  if (!(await canEditReservationAgency(user, existingReservation))) {
    return NextResponse.json({ error: "Seule l'agence de départ peut supprimer cette réservation." }, { status: 403 });
  }

  try {
    const deleted = await deleteReservation(user.tenantId, id);
    if (!deleted) {
      return NextResponse.json({ error: "Réservation introuvable." }, { status: 404 });
    }
  } catch (error) {
    if (error instanceof ReservationNotDeletableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la suppression de la réservation :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "reservation.deleted",
    resource: "Reservation",
    resourceId: id,
  });

  return NextResponse.json({ success: true });
}
