import { NextResponse } from "next/server";
import type { IdType } from "@prisma/client";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicleById } from "@/lib/vehicles";
import { getClientById, createClient, updateClient, findDuplicateClient } from "@/lib/clients";
import {
  getReservationById,
  markReservationConverted,
  canTransition,
  InvalidReservationStatusTransitionError,
} from "@/lib/reservations";
import {
  createLocation,
  InvalidDateRangeError,
  VehicleNotFoundError,
  ClientNotFoundError,
  VehicleNotAvailableError,
  MissingPriceError,
} from "@/lib/locations";
import { createInvoice } from "@/lib/invoices";
import { processLocationPayment, validatePaymentInput, type PaymentInput } from "@/lib/location-payment";
import { logAction } from "@/lib/audit";

const ID_TYPES: IdType[] = ["CIN", "PASSEPORT", "CARTE_SEJOUR"];

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface ConvertClientInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  country?: string;
  idNumber?: string;
  idType?: IdType;
  licenseNumber?: string;
  licenseIssueDate?: string;
  licenseExpiryDate?: string;
}

interface ConvertBody {
  vehicleId?: string;
  startDate?: string;
  endDate?: string;
  deposit?: number;
  /** Prix/jour réel (centimes) — voir DOMAINRULES.md section 5/7. Optionnel : retombe sur le
   * prix informatif du véhicule choisi s'il en a un ; sinon 400 (voir MissingPriceError). */
  pricePerDay?: number;
  notes?: string;
  client?: ConvertClientInput;
  useExistingClientId?: string;
  forceCreateClient?: boolean;
  payment?: PaymentInput;
}

/**
 * Convertit une réservation en contrat (Location + Invoice + Payment(s)) — Sprint 13D,
 * refonte complète du flux (voir DOMAINRULES.md section 26). Le formulaire de conversion
 * (`/dashboard/reservations/[id]/convert`) pré-remplit ses champs depuis la réservation, mais
 * l'utilisateur vérifie/complète les infos client, choisit le véhicule et l'agence réels
 * (dérivée du véhicule, jamais fournie séparément par le client — voir plus bas) et renseigne
 * le paiement, exactement comme le formulaire de création directe de location (Sprint 13A,
 * src/lib/location-payment.ts, réutilisé tel quel).
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
  if (!body.startDate || !body.endDate) {
    return NextResponse.json({ error: "startDate et endDate sont requis." }, { status: 400 });
  }
  const startDate = new Date(body.startDate);
  const endDate = new Date(body.endDate);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return NextResponse.json({ error: "startDate et endDate doivent être des dates ISO valides." }, { status: 400 });
  }

  if (body.deposit !== undefined && (!Number.isInteger(body.deposit) || body.deposit < 0)) {
    return NextResponse.json({ error: "deposit doit être un entier positif ou nul." }, { status: 400 });
  }

  if (body.pricePerDay !== undefined && (!Number.isInteger(body.pricePerDay) || body.pricePerDay <= 0)) {
    return NextResponse.json({ error: "pricePerDay doit être un entier positif (centimes)." }, { status: 400 });
  }

  const clientInput = body.client ?? {};
  if (!body.useExistingClientId && (!clientInput.firstName || !clientInput.lastName)) {
    return NextResponse.json({ error: "client.firstName et client.lastName sont requis." }, { status: 400 });
  }
  if (clientInput.idType && !ID_TYPES.includes(clientInput.idType)) {
    return NextResponse.json({ error: "client.idType invalide." }, { status: 400 });
  }

  const paymentError = validatePaymentInput(body.payment);
  if (paymentError) {
    return NextResponse.json({ error: paymentError }, { status: 400 });
  }

  const vehicle = await getVehicleById(user.tenantId, body.vehicleId);
  if (!vehicle) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }
  if (!(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  // Résolution du client (même logique de doublons que POST /api/clients, voir
  // DOMAINRULES.md section 9) — sur les valeurs saisies/vérifiées dans le formulaire de
  // conversion, pas sur les champs bruts (possiblement incomplets) de la réservation importée.
  let clientId: string;
  if (body.useExistingClientId) {
    const existingClient = await getClientById(user.tenantId, body.useExistingClientId);
    if (!existingClient) {
      return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
    }

    const derivedName =
      clientInput.firstName || clientInput.lastName
        ? [clientInput.firstName ?? existingClient.firstName, clientInput.lastName ?? existingClient.lastName]
            .filter(Boolean)
            .join(" ")
            .trim() || undefined
        : undefined;

    await updateClient(user.tenantId, existingClient.id, {
      ...(derivedName ? { name: derivedName } : {}),
      ...(clientInput.firstName !== undefined ? { firstName: clientInput.firstName } : {}),
      ...(clientInput.lastName !== undefined ? { lastName: clientInput.lastName } : {}),
      ...(clientInput.email !== undefined ? { email: clientInput.email } : {}),
      ...(clientInput.phone !== undefined ? { phone: clientInput.phone } : {}),
      ...(clientInput.address !== undefined ? { address: clientInput.address } : {}),
      ...(clientInput.city !== undefined ? { city: clientInput.city } : {}),
      ...(clientInput.country !== undefined ? { country: clientInput.country } : {}),
      ...(clientInput.idNumber !== undefined ? { idNumber: clientInput.idNumber } : {}),
      ...(clientInput.idType !== undefined ? { idType: clientInput.idType } : {}),
      ...(clientInput.licenseNumber !== undefined ? { licenseNumber: clientInput.licenseNumber } : {}),
      ...(clientInput.licenseIssueDate !== undefined
        ? { licenseIssueDate: new Date(clientInput.licenseIssueDate) }
        : {}),
      ...(clientInput.licenseExpiryDate !== undefined
        ? { licenseExpiryDate: new Date(clientInput.licenseExpiryDate) }
        : {}),
    });
    clientId = existingClient.id;
  } else {
    const duplicate = await findDuplicateClient(user.tenantId, {
      email: clientInput.email,
      phone: clientInput.phone,
      idNumber: clientInput.idNumber,
      licenseNumber: clientInput.licenseNumber,
      firstName: clientInput.firstName,
      lastName: clientInput.lastName,
    });

    if (duplicate && !body.forceCreateClient) {
      return NextResponse.json(
        { duplicate: { client: duplicate.client, matchType: duplicate.matchType, field: duplicate.field } },
        { status: 409 }
      );
    }

    const name = `${clientInput.firstName} ${clientInput.lastName}`.trim();
    const notes = duplicate
      ? `Créé malgré une correspondance possible avec ${duplicate.client.name} (conversion de la réservation ${reservation.voucherNumber}).`
      : undefined;

    const newClient = await createClient({
      tenantId: user.tenantId,
      name,
      firstName: clientInput.firstName,
      lastName: clientInput.lastName,
      email: clientInput.email,
      phone: clientInput.phone,
      address: clientInput.address,
      city: clientInput.city,
      country: clientInput.country,
      idNumber: clientInput.idNumber,
      idType: clientInput.idType,
      licenseNumber: clientInput.licenseNumber,
      licenseIssueDate: clientInput.licenseIssueDate ? new Date(clientInput.licenseIssueDate) : undefined,
      licenseExpiryDate: clientInput.licenseExpiryDate ? new Date(clientInput.licenseExpiryDate) : undefined,
      notes,
    });
    clientId = newClient.id;
  }

  try {
    // L'agence du contrat est dérivée du véhicule choisi côté serveur, jamais d'un champ
    // agencyId fourni par le client — même règle que POST /api/locations (SECURITY.md
    // section 4) : le sélecteur d'agence du formulaire de conversion ne sert qu'à filtrer
    // la liste de véhicules proposée, pas à fixer l'agence indépendamment du véhicule choisi.
    const location = await createLocation({
      tenantId: user.tenantId,
      agencyId: vehicle.agencyId,
      vehicleId: vehicle.id,
      clientId,
      startDate,
      endDate,
      notes: body.notes ?? reservation.notes ?? undefined,
      deposit: body.deposit,
      pricePerDay: body.pricePerDay,
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

    // Paiement intégré au formulaire de conversion (même logique que POST /api/locations,
    // Sprint 13A — src/lib/location-payment.ts).
    let payments: Awaited<ReturnType<typeof processLocationPayment>>["payments"] = [];
    let paymentSaveError: string | null = null;
    if (invoice && body.payment && !body.payment.deferred) {
      const client = await getClientById(user.tenantId, clientId);
      const result = await processLocationPayment({
        tenantId: user.tenantId,
        userId: user.id,
        locationId: location.id,
        invoice,
        clientName: client?.name,
        payment: body.payment,
      });
      invoice = result.invoice;
      payments = result.payments;
      paymentSaveError = result.paymentError;
    }

    return NextResponse.json(
      { reservation: updatedReservation, location, invoice, payments, paymentError: paymentSaveError },
      { status: 201 }
    );
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
    if (error instanceof MissingPriceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Erreur lors de la conversion de la réservation :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
