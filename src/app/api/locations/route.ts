import { NextResponse } from "next/server";
import type { LocationStatus, PaymentMethod } from "@prisma/client";
import { getSessionUser, canAccessAgency, getAccessibleAgencyIds } from "@/lib/authz";
import { getVehicleById } from "@/lib/vehicles";
import { getClientById } from "@/lib/clients";
import {
  getLocations,
  createLocation,
  type LocationFilters,
  InvalidDateRangeError,
  VehicleNotFoundError,
  ClientNotFoundError,
  VehicleNotAvailableError,
} from "@/lib/locations";
import { createInvoice, getInvoiceById } from "@/lib/invoices";
import { createPayment } from "@/lib/payments";
import { createCashEntry } from "@/lib/cash-register";
import { logAction } from "@/lib/audit";

const LOCATION_STATUSES: LocationStatus[] = ["PENDING", "CONFIRMED", "ACTIVE", "COMPLETED", "CANCELLED"];
const PAYMENT_METHODS: PaymentMethod[] = ["CASH", "CARD", "BANK_TRANSFER", "CHECK", "OTHER"];

/**
 * Section paiement du formulaire de création de location (Sprint 13A). deferred = "paiement
 * au retour" (aucun Payment créé, la facture DRAFT auto-générée reste telle quelle) ; mixed =
 * 2 lignes méthode+montant plutôt qu'une seule ; partial (non mixte uniquement) = un montant
 * inférieur au total facturé (sinon le total facturé est réglé intégralement). Chaque montant
 * réellement réglé passe par createPayment (src/lib/payments.ts, inchangé) : le calcul du
 * statut de facture (SENT/PARTIALLY_PAID/PAID) est donc déjà entièrement géré par la logique
 * existante (recomputeInvoiceStatus, Sprint 6) — aucune duplication de cette règle ici.
 */
interface PaymentInput {
  deferred?: boolean;
  mixed?: boolean;
  partial?: boolean;
  method?: PaymentMethod;
  amount?: number;
  method1?: PaymentMethod;
  amount1?: number;
  method2?: PaymentMethod;
  amount2?: number;
}

function validatePaymentInput(payment: PaymentInput | undefined): string | null {
  if (!payment || payment.deferred) {
    return null;
  }

  if (payment.mixed) {
    const lines = [
      { method: payment.method1, amount: payment.amount1 },
      { method: payment.method2, amount: payment.amount2 },
    ].filter((line) => line.amount !== undefined && line.amount > 0);

    if (lines.length === 0) {
      return "Le paiement mixte nécessite au moins un montant renseigné.";
    }
    for (const line of lines) {
      if (!line.method || !PAYMENT_METHODS.includes(line.method)) {
        return "Mode de paiement invalide dans le paiement mixte.";
      }
      if (!Number.isInteger(line.amount) || (line.amount as number) <= 0) {
        return "Chaque montant du paiement mixte doit être un entier positif.";
      }
    }
    return null;
  }

  if (!payment.method || !PAYMENT_METHODS.includes(payment.method)) {
    return "Mode de paiement invalide.";
  }

  if (payment.partial) {
    if (!Number.isInteger(payment.amount) || (payment.amount as number) <= 0) {
      return "Le montant payé doit être un entier positif.";
    }
  }

  return null;
}

export async function GET(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
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
  deposit?: number;
  payment?: PaymentInput;
}

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
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
      deposit: body.deposit,
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

    // Paiement intégré au formulaire de location (Sprint 13A) : "paiement au retour" ne crée
    // aucun Payment (la facture DRAFT auto-générée ci-dessus reste telle quelle) ; sinon, un ou
    // deux Payment sont créés (createPayment, Sprint 6, inchangé — refuse déjà tout montant
    // dépassant le solde restant dû, et recalcule automatiquement amountPaid/status de la
    // facture). Chaque Payment réussi alimente aussi la Caisse (createCashEntry) : un contrat
    // réglé à la création doit apparaître comme une entrée de caisse au même titre qu'une
    // entrée manuelle. Résilient par choix, même principe que la génération de facture
    // ci-dessus : un échec ne doit jamais faire échouer la création de la location elle-même
    // (le paiement reste enregistrable manuellement ensuite via /dashboard/invoices/[id]).
    const payments: Awaited<ReturnType<typeof createPayment>>[] = [];
    let paymentSaveError: string | null = null;
    if (invoice && body.payment && !body.payment.deferred) {
      const lines = body.payment.mixed
        ? [
            { method: body.payment.method1, amount: body.payment.amount1 },
            { method: body.payment.method2, amount: body.payment.amount2 },
          ].filter(
            (line): line is { method: PaymentMethod; amount: number } =>
              line.amount !== undefined && line.amount > 0 && line.method !== undefined
          )
        : [
            {
              method: body.payment.method as PaymentMethod,
              amount: body.payment.partial ? (body.payment.amount as number) : invoice.totalAmount,
            },
          ];

      const client = await getClientById(user.tenantId, clientId);
      try {
        for (const line of lines) {
          const payment = await createPayment({
            tenantId: user.tenantId,
            invoiceId: invoice.id,
            amount: line.amount,
            method: line.method,
          });
          payments.push(payment);
          await logAction({
            tenantId: user.tenantId,
            userId: user.id,
            action: "payment.created",
            resource: "Payment",
            resourceId: payment.id,
            metadata: { invoiceId: payment.invoiceId, amount: payment.amount, method: payment.method, auto: true },
          });

          const cashEntry = await createCashEntry({
            tenantId: user.tenantId,
            type: "ENTRY",
            category: "VERSEMENT",
            amount: payment.amount,
            description: `Paiement location #${location.id.slice(-8)}`,
            contractId: location.id,
            clientName: client?.name,
            paymentMethod: payment.method,
          });
          await logAction({
            tenantId: user.tenantId,
            userId: user.id,
            action: "cashEntry.created",
            resource: "CashEntry",
            resourceId: cashEntry.id,
            metadata: { type: cashEntry.type, amount: cashEntry.amount, contractId: location.id, auto: true },
          });
        }
      } catch (error) {
        paymentSaveError =
          error instanceof Error ? error.message : "Erreur lors de l'enregistrement du paiement.";
        console.error("Erreur lors de l'enregistrement du paiement intégré à la location :", error);
      }

      // createPayment (ci-dessus) a déjà recalculé amountPaid/status en base (recomputeInvoiceStatus,
      // src/lib/payments.ts) ; la variable locale `invoice` doit être relue pour refléter ce nouveau
      // statut dans la réponse, sinon le client afficherait à tort la facture comme DRAFT.
      if (payments.length > 0) {
        invoice = await getInvoiceById(user.tenantId, invoice.id);
      }
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

    console.error("Erreur lors de la création de la location :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
