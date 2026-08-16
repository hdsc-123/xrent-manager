import { NextResponse } from "next/server";
import type { LocationStatus } from "@prisma/client";
import { getSessionUser, canAccessAgency, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicleById } from "@/lib/vehicles";
import {
  getLocations,
  createLocation,
  type LocationFilters,
  InvalidDateRangeError,
  VehicleNotFoundError,
  ClientNotFoundError,
  VehicleNotAvailableError,
  VehicleUnavailableForLocationError,
  MissingPriceError,
  InvalidFuelLevelError,
  MissingDriverLicenseExpiryError,
  DriverLicenseExpiredError,
  MissingDriverBirthDateError,
  InvalidDriverBirthDateError,
  DriverUnderMinimumAgeError,
} from "@/lib/locations";
import { createInvoice } from "@/lib/invoices";
import { processLocationPayment, validatePaymentInput, type PaymentInput } from "@/lib/location-payment";
import { logAction } from "@/lib/audit";

const LOCATION_STATUSES: LocationStatus[] = ["PENDING", "CONFIRMED", "ACTIVE", "COMPLETED", "CANCELLED"];

export async function GET(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "locations.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const vehicleId = searchParams.get("vehicleId") ?? undefined;
  const clientId = searchParams.get("clientId") ?? undefined;
  const agencyId = searchParams.get("agencyId") ?? undefined;
  const statusParam = searchParams.get("status") ?? undefined;
  const fromParam = searchParams.get("from") ?? undefined;
  const toParam = searchParams.get("to") ?? undefined;

  if (statusParam && !LOCATION_STATUSES.includes(statusParam as LocationStatus)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }

  if (agencyId && !(await canAccessAgency(user, agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  const filters: LocationFilters = {
    vehicleId,
    clientId,
    agencyId,
    status: statusParam as LocationStatus | undefined,
    from: fromParam ? new Date(fromParam) : undefined,
    to: toParam ? new Date(toParam) : undefined,
  };

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const locations = await getLocations(user.tenantId, filters);

  const visibleLocations =
    accessibleAgencyIds === null || agencyId
      ? locations
      : locations.filter((location) => accessibleAgencyIds.includes(location.agencyId));

  return NextResponse.json({ locations: visibleLocations });
}

interface CreateLocationBody {
  vehicleId?: string;
  clientId?: string;
  startDate?: string;
  endDate?: string;
  status?: LocationStatus;
  notes?: string;
  startOdometer?: number;
  endOdometer?: number;
  /** Sprint 23 — jauge de carburant départ/retour (0-100). */
  startFuelLevel?: number;
  endFuelLevel?: number;
  deposit?: number;
  /** Prix/jour réel (centimes) — voir DOMAINRULES.md section 5/7. Optionnel : retombe sur le
   * prix informatif du véhicule s'il en a un ; sinon 400 (voir MissingPriceError). */
  pricePerDay?: number;
  payment?: PaymentInput;
}

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "locations.create"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  let body: CreateLocationBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { vehicleId, clientId, startDate, endDate } = body;

  if (!vehicleId || !clientId || !startDate || !endDate) {
    return NextResponse.json(
      { error: "vehicleId, clientId, startDate et endDate sont requis." },
      { status: 400 }
    );
  }

  if (body.status && body.status !== "PENDING" && body.status !== "CONFIRMED") {
    return NextResponse.json(
      { error: "status ne peut être que PENDING ou CONFIRMED à la création." },
      { status: 400 }
    );
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return NextResponse.json(
      { error: "startDate et endDate doivent être des dates ISO valides." },
      { status: 400 }
    );
  }

  // L'agence de la location est dérivée du véhicule côté serveur, jamais fournie par le
  // client, pour empêcher toute incohérence véhicule/agence (SECURITY.md section 4).
  const vehicle = await getVehicleById(user.tenantId, vehicleId);
  if (!vehicle) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }

  if (!(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  for (const field of ["startOdometer", "endOdometer", "deposit"] as const) {
    const fieldValue = body[field];
    if (fieldValue !== undefined && (!Number.isInteger(fieldValue) || fieldValue < 0)) {
      return NextResponse.json({ error: `${field} doit être un entier positif ou nul.` }, { status: 400 });
    }
  }

  if (body.pricePerDay !== undefined && (!Number.isInteger(body.pricePerDay) || body.pricePerDay <= 0)) {
    return NextResponse.json({ error: "pricePerDay doit être un entier positif (centimes)." }, { status: 400 });
  }

  const paymentError = validatePaymentInput(body.payment);
  if (paymentError) {
    return NextResponse.json({ error: paymentError }, { status: 400 });
  }

  try {
    const location = await createLocation({
      tenantId: user.tenantId,
      agencyId: vehicle.agencyId,
      vehicleId,
      clientId,
      startDate: start,
      endDate: end,
      status: body.status,
      notes: body.notes,
      startOdometer: body.startOdometer,
      endOdometer: body.endOdometer,
      startFuelLevel: body.startFuelLevel,
      endFuelLevel: body.endFuelLevel,
      deposit: body.deposit,
      pricePerDay: body.pricePerDay,
    });
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "location.created",
      resource: "Location",
      resourceId: location.id,
      metadata: { vehicleId: location.vehicleId, clientId: location.clientId, status: location.status },
    });

    // Génération automatique d'une facture DRAFT à la création de la location (Sprint 12B).
    // Résiliente par choix : un échec de génération de facture (ex. collision de numérotation
    // après réessais, voir src/lib/invoices.ts) ne doit jamais faire échouer la création de la
    // location elle-même — la facture reste créable manuellement ensuite (POST /api/invoices,
    // déjà existant depuis le Sprint 6), même principe de résilience que logAction (src/lib/audit.ts).
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

    // Paiement intégré au formulaire de location (Sprint 13A) — logique partagée avec la
    // conversion réservation → contrat (Sprint 13D, voir src/lib/location-payment.ts).
    let payments: Awaited<ReturnType<typeof processLocationPayment>>["payments"] = [];
    let paymentSaveError: string | null = null;
    if (invoice && body.payment && !body.payment.deferred) {
      const result = await processLocationPayment({
        tenantId: user.tenantId,
        userId: user.id,
        invoice,
        payment: body.payment,
      });
      invoice = result.invoice;
      payments = result.payments;
      paymentSaveError = result.paymentError;
    }

    return NextResponse.json({ location, invoice, payments, paymentError: paymentSaveError }, { status: 201 });
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
    // Sprint 28 (Finding E) : véhicule MAINTENANCE/TRANSFERRING/ON_TRIP — s'applique à tout
    // appelant, y compris ADMIN (aucun override possible, contrairement à LocationLockedError).
    if (error instanceof VehicleUnavailableForLocationError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof MissingPriceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Sprint 29 (DOMAINRULES.md section 44, point 16) : permis du client principal absent ou
    // expirant avant la date de retour — même statut/forme de réponse que MissingPriceError.
    if (error instanceof MissingDriverLicenseExpiryError || error instanceof DriverLicenseExpiredError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Sprint 30 (DOMAINRULES.md section 45, point 7) : âge réel du conducteur (client principal
    // uniquement ici — secondDriverId n'est pas exposé par cette route, voir DOMAINRULES.md).
    if (
      error instanceof MissingDriverBirthDateError ||
      error instanceof InvalidDriverBirthDateError ||
      error instanceof DriverUnderMinimumAgeError
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidFuelLevelError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("Erreur lors de la création de la location :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
