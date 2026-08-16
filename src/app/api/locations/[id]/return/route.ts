import { NextResponse } from "next/server";
import type { PaymentMethod } from "@prisma/client";
import { getSessionUser, canAccessLocationAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getLocationById } from "@/lib/locations";
import { PAYMENT_METHODS } from "@/lib/location-payment";
import {
  returnLocation,
  type ReturnDamageInput,
  type MixedPaymentLineInput,
  LocationReturnNotFoundError,
  LocationNotActiveForReturnError,
  LocationReturnConflictError,
  MissingReturnOdometerError,
  InvalidReturnOdometerError,
  MissingReturnFuelLevelError,
  InvalidReturnFuelLevelError,
  InvalidReturnTimeError,
  LocationHasNoInvoiceError,
  VehicleNotFoundForReturnError,
  PaymentInvoiceNotFoundError,
  InvoiceCancelledError,
  InvoiceNotFinalizedError,
  InvalidPaymentAmountError,
  PaymentExceedsRemainingBalanceError,
  DamageNotFoundError,
  DamageLocationMismatchError,
  DamageAlreadyInvoicedError,
  DamageNotBillableError,
  NoDamagesToInvoiceError,
  DamageInvoiceNotFoundError,
  DamageInvoiceCancelledError,
  InvalidDamageInvoicePaymentAmountError,
  DamageInvoicePaymentExceedsBalanceError,
  InvalidDamageAmountError,
  InvalidDamageNatureError,
} from "@/lib/location-return";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface PaymentLineBody {
  method?: unknown;
  amount?: unknown;
}

interface DamageBody {
  nature?: unknown;
  description?: unknown;
  billableAmount?: unknown;
}

interface ReturnBody {
  endOdometer?: unknown;
  endFuelLevel?: unknown;
  actualReturnAt?: unknown;
  paymentLines?: unknown;
  damages?: unknown;
  damageInvoicePaymentLines?: unknown;
}

type ParseResult<T> = { value: T } | { error: string };

/** Ne fait confiance à aucune forme reçue du client — chaque champ est revalidé ici avant
 * d'atteindre returnLocation (src/lib/location-return.ts), qui revalide ensuite lui-même tout
 * ce qui concerne les règles métier (montants, soldes). Cette fonction ne fait que garantir la
 * forme/le typage attendus par le service, jamais les règles métier elles-mêmes (pas de
 * duplication de logique). */
function parsePaymentLines(raw: unknown): ParseResult<MixedPaymentLineInput[]> {
  if (!Array.isArray(raw)) {
    return { error: "paymentLines doit être un tableau." };
  }
  const lines: MixedPaymentLineInput[] = [];
  for (const item of raw as PaymentLineBody[]) {
    if (typeof item !== "object" || item === null) {
      return { error: "Chaque ligne de paiement doit être un objet." };
    }
    const { method, amount } = item;
    if (typeof method !== "string" || !PAYMENT_METHODS.includes(method as PaymentMethod)) {
      return { error: "Mode de paiement invalide." };
    }
    if (typeof amount !== "number") {
      return { error: "Montant de paiement invalide." };
    }
    lines.push({ method: method as PaymentMethod, amount });
  }
  return { value: lines };
}

function parseDamages(raw: unknown): ParseResult<ReturnDamageInput[]> {
  if (!Array.isArray(raw)) {
    return { error: "damages doit être un tableau." };
  }
  const damages: ReturnDamageInput[] = [];
  for (const item of raw as DamageBody[]) {
    if (typeof item !== "object" || item === null) {
      return { error: "Chaque dégât doit être un objet." };
    }
    const { nature, description, billableAmount } = item;
    if (typeof nature !== "string") {
      return { error: "La nature du dégât est obligatoire." };
    }
    if (description !== undefined && typeof description !== "string") {
      return { error: "La description du dégât doit être une chaîne." };
    }
    if (billableAmount !== undefined && billableAmount !== null && typeof billableAmount !== "number") {
      return { error: "Le montant facturable du dégât doit être un nombre." };
    }

    damages.push({
      nature,
      description: description as string | undefined,
      billableAmount: billableAmount as number | null | undefined,
    });
  }
  return { value: damages };
}

/**
 * Sprint 32 (DOMAINRULES.md section 32) — clôture d'un contrat par son retour : orchestration
 * transactionnelle complète (kilométrage/carburant, date/heure réelle, solde locatif, dégâts,
 * passage du véhicule à AVAILABLE) déléguée entièrement à returnLocation
 * (src/lib/location-return.ts) — cette route ne fait que vérifier l'authentification/les
 * permissions/la portée agence et valider la forme du corps de requête, jamais de logique
 * métier dupliquée ici. Distincte du PATCH générique /api/locations/[id] (transition de statut
 * simple, toujours disponible par ailleurs, non modifié ce sprint).
 *
 * Sprint 33 (DOMAINRULES.md section 48) : `damages[].payment` retiré — un dégât facturable saisi
 * ici est toujours regroupé automatiquement dans une DamageInvoice unique (createDamageInvoice),
 * dont le solde s'encaisse via le nouveau champ `damageInvoicePaymentLines` (un seul paiement
 * pour l'ensemble des dégâts facturables de cette soumission), strictement séparé de
 * `paymentLines` (solde locatif).
 *
 * vehicleId n'est jamais accepté dans le corps de requête : toujours dérivé côté serveur de la
 * Location (locations.ts → location.vehicleId, puis returnLocation lui-même) — "le véhicule
 * correspond au contrat" est garanti par construction, jamais par une vérification a posteriori
 * d'un identifiant fourni par le client.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "locations.complete"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const location = await getLocationById(user.tenantId, id);
  if (!location || !(await canAccessLocationAgency(user, location))) {
    return NextResponse.json({ error: "Contrat introuvable." }, { status: 404 });
  }

  let body: ReturnBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (
    body.endOdometer !== undefined &&
    body.endOdometer !== null &&
    typeof body.endOdometer !== "number"
  ) {
    return NextResponse.json({ error: "endOdometer doit être un nombre." }, { status: 400 });
  }
  if (
    body.endFuelLevel !== undefined &&
    body.endFuelLevel !== null &&
    typeof body.endFuelLevel !== "number"
  ) {
    return NextResponse.json({ error: "endFuelLevel doit être un nombre." }, { status: 400 });
  }

  // Sprint 32 : jamais un simple indicateur d'interface — canOverrideReturnTime est calculée
  // ici, côté serveur, et returnLocation applique lui-même la règle (ignore toute valeur
  // personnalisée sans cette permission), même en cas d'appel direct hors de cette route.
  const canOverrideReturnTime = await can(user, "locations.return_time.edit");

  let actualReturnAt: Date | undefined;
  if (body.actualReturnAt !== undefined) {
    if (typeof body.actualReturnAt !== "string") {
      return NextResponse.json({ error: "actualReturnAt doit être une date ISO valide." }, { status: 400 });
    }
    actualReturnAt = new Date(body.actualReturnAt);
    if (Number.isNaN(actualReturnAt.getTime())) {
      return NextResponse.json({ error: "actualReturnAt doit être une date ISO valide." }, { status: 400 });
    }
  }

  let paymentLines: MixedPaymentLineInput[] | undefined;
  if (body.paymentLines !== undefined) {
    const parsed = parsePaymentLines(body.paymentLines);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    paymentLines = parsed.value;
  }

  let damages: ReturnDamageInput[] | undefined;
  if (body.damages !== undefined) {
    const parsed = parseDamages(body.damages);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    damages = parsed.value;
  }

  // Sprint 33 (DOMAINRULES.md section 48) : locations.complete autorise le retour lui-même
  // (inchangé), mais déclarer un/des dégât(s) et générer leur DamageInvoice restent des actions
  // à part entière, vérifiées séparément — même principe que POST /api/damages (isBillable).
  if (damages && damages.length > 0 && !(await can(user, "damages.create"))) {
    return NextResponse.json({ error: "Accès refusé (déclaration de dégâts)." }, { status: 403 });
  }
  const hasBillableDamage = (damages ?? []).some(
    (damage) => typeof damage.billableAmount === "number" && damage.billableAmount > 0
  );
  if (hasBillableDamage && !(await can(user, "damage_invoices.create"))) {
    return NextResponse.json({ error: "Accès refusé (facturation des dégâts)." }, { status: 403 });
  }

  let damageInvoicePaymentLines: MixedPaymentLineInput[] | undefined;
  if (body.damageInvoicePaymentLines !== undefined) {
    const parsed = parsePaymentLines(body.damageInvoicePaymentLines);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    damageInvoicePaymentLines = parsed.value;
  }

  try {
    const result = await returnLocation({
      tenantId: user.tenantId,
      userId: user.id,
      locationId: location.id,
      endOdometer: body.endOdometer as number | null | undefined,
      endFuelLevel: body.endFuelLevel as number | null | undefined,
      actualReturnAt,
      canOverrideReturnTime,
      paymentLines,
      damages,
      damageInvoicePaymentLines,
    });

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "location.returned",
      resource: "Location",
      resourceId: location.id,
      metadata: {
        endOdometer: result.location.endOdometer,
        endFuelLevel: result.location.endFuelLevel,
        actualReturnAt: result.location.actualReturnAt,
        paymentsCount: result.payments.length,
        damagesCount: result.damages.length,
        damageInvoiceId: result.damageInvoice?.id ?? null,
        damagePaymentsCount: result.damagePayments.length,
      },
    });

    if (result.returnTimeOverridden) {
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "location.return_time_overridden",
        resource: "Location",
        resourceId: location.id,
        metadata: { actualReturnAt: result.location.actualReturnAt },
      });
    }

    for (const payment of result.payments) {
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "payment.created",
        resource: "Payment",
        resourceId: payment.id,
        metadata: { invoiceId: payment.invoiceId, amount: payment.amount, method: payment.method, auto: true },
      });
    }
    for (const damage of result.damages) {
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "damage.created",
        resource: "Damage",
        resourceId: damage.id,
        metadata: {
          locationId: damage.locationId,
          vehicleId: damage.vehicleId,
          nature: damage.nature,
          billableAmount: damage.billableAmount,
          auto: true,
        },
      });
    }
    if (result.damageInvoice) {
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "damage_invoice.created",
        resource: "DamageInvoice",
        resourceId: result.damageInvoice.id,
        metadata: {
          number: result.damageInvoice.number,
          locationId: result.damageInvoice.locationId,
          totalAmount: result.damageInvoice.totalAmount,
          auto: true,
        },
      });
    }
    for (const payment of result.damagePayments) {
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "damage_invoice.payment_created",
        resource: "Payment",
        resourceId: payment.id,
        metadata: { damageInvoiceId: payment.damageInvoiceId, amount: payment.amount, method: payment.method, auto: true },
      });
    }

    return NextResponse.json({
      location: result.location,
      vehicle: result.vehicle,
      payments: result.payments,
      damages: result.damages,
      damageInvoice: result.damageInvoice,
      damagePayments: result.damagePayments,
    });
  } catch (error) {
    if (error instanceof LocationReturnNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof VehicleNotFoundForReturnError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof LocationNotActiveForReturnError || error instanceof LocationReturnConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (
      error instanceof MissingReturnOdometerError ||
      error instanceof InvalidReturnOdometerError ||
      error instanceof MissingReturnFuelLevelError ||
      error instanceof InvalidReturnFuelLevelError ||
      error instanceof InvalidReturnTimeError ||
      error instanceof InvalidPaymentAmountError ||
      error instanceof InvalidDamageAmountError ||
      error instanceof InvalidDamageNatureError ||
      error instanceof InvalidDamageInvoicePaymentAmountError
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (
      error instanceof PaymentInvoiceNotFoundError ||
      error instanceof DamageNotFoundError ||
      error instanceof DamageInvoiceNotFoundError
    ) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (
      error instanceof LocationHasNoInvoiceError ||
      error instanceof InvoiceCancelledError ||
      error instanceof InvoiceNotFinalizedError ||
      error instanceof PaymentExceedsRemainingBalanceError ||
      error instanceof DamageLocationMismatchError ||
      error instanceof DamageAlreadyInvoicedError ||
      error instanceof DamageNotBillableError ||
      error instanceof NoDamagesToInvoiceError ||
      error instanceof DamageInvoiceCancelledError ||
      error instanceof DamageInvoicePaymentExceedsBalanceError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    console.error("Erreur lors du retour du contrat :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
