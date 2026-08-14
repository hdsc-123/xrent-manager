import { NextResponse } from "next/server";
import type { ReservationStatus } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import {
  getReservations,
  createReservation,
  generateDirectVoucherNumber,
  getKnownAgencyNames,
  type ReservationFilters,
  InvalidReservationDateRangeError,
} from "@/lib/reservations";
import { logAction } from "@/lib/audit";

const RESERVATION_STATUSES: ReservationStatus[] = ["PENDING", "CONFIRMED", "CONVERTED", "CANCELLED"];

const MONEY_FIELDS = ["totalPrice", "pricePerDay", "gpsPrice", "babySeatPrice", "extraDriverPrice"] as const;
const INT_FIELDS = ["daysCount", "mileage", "includedKm"] as const;

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "reservations.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get("status") ?? undefined;
  const sourceParam = searchParams.get("source") ?? undefined;
  const searchParam = searchParams.get("search") ?? undefined;
  const fromParam = searchParams.get("from") ?? undefined;
  const toParam = searchParams.get("to") ?? undefined;
  const pickupAgencyParam = searchParams.get("pickupAgency") ?? undefined;
  const dropoffAgencyParam = searchParams.get("dropoffAgency") ?? undefined;
  const vehicleCategoryParam = searchParams.get("vehicleCategory") ?? undefined;

  if (statusParam && !RESERVATION_STATUSES.includes(statusParam as ReservationStatus)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }

  const filters: ReservationFilters = {
    status: statusParam as ReservationStatus | undefined,
    source: sourceParam,
    search: searchParam,
    from: fromParam ? new Date(fromParam) : undefined,
    to: toParam ? new Date(toParam) : undefined,
    pickupAgency: pickupAgencyParam,
    dropoffAgency: dropoffAgencyParam,
    vehicleCategory: vehicleCategoryParam,
    // Sprint 19 (DOMAINRULES.md section 37) : visibilité scopée par agence de départ/retour
    // pour un MEMBER — voir getReservations, src/lib/reservations.ts.
    accessibleAgencyIds: await getAccessibleAgencyIds(user),
  };

  const reservations = await getReservations(user.tenantId, filters);
  return NextResponse.json({ reservations });
}

interface CreateReservationBody {
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

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "reservations.create"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  let body: CreateReservationBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { clientFirstName, clientLastName, startDate, endDate } = body;
  if (!clientFirstName || !clientLastName || !startDate || !endDate) {
    return NextResponse.json(
      { error: "clientFirstName, clientLastName, startDate et endDate sont requis." },
      { status: 400 }
    );
  }

  // voucherNumber est saisi manuellement pour une réservation BROKER, mais généré
  // automatiquement (Dir-0001, Dir-0002...) pour une réservation DIRECT (Sprint 13C).
  let voucherNumber = body.voucherNumber;
  if (!voucherNumber) {
    if (body.source === "DIRECT") {
      voucherNumber = await generateDirectVoucherNumber(user.tenantId);
    } else {
      return NextResponse.json({ error: "voucherNumber est requis." }, { status: 400 });
    }
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return NextResponse.json(
      { error: "startDate et endDate doivent être des dates ISO valides." },
      { status: 400 }
    );
  }

  const receivedAt = body.receivedAt ? new Date(body.receivedAt) : undefined;
  if (receivedAt && Number.isNaN(receivedAt.getTime())) {
    return NextResponse.json({ error: "receivedAt doit être une date ISO valide." }, { status: 400 });
  }

  if (body.status && body.status !== "PENDING" && body.status !== "CONFIRMED") {
    return NextResponse.json(
      { error: "status ne peut être que PENDING ou CONFIRMED à la création." },
      { status: 400 }
    );
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

  // Villes/agences (Sprint 14A) : mêmes règles que l'import Excel — doit correspondre à une
  // agence réelle du tenant (ville ou nom, insensible à la casse), voir
  // src/lib/reservations.ts getKnownAgencyNames/parseReservationImportRow.
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
    const reservation = await createReservation({
      tenantId: user.tenantId,
      voucherNumber,
      confirmationNumber: body.confirmationNumber,
      receivedAt,
      source: body.source,
      clientFirstName,
      clientLastName,
      startDate: start,
      startTime: body.startTime,
      endDate: end,
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

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "reservation.created",
      resource: "Reservation",
      resourceId: reservation.id,
      metadata: { voucherNumber: reservation.voucherNumber, status: reservation.status },
    });

    return NextResponse.json({ reservation }, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidReservationDateRangeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Erreur lors de la création de la réservation :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
