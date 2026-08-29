import { NextResponse } from "next/server";
import type { InvoiceStatus } from "@prisma/client";
import { getSessionUser, canAccessAgency, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getLocationById } from "@/lib/locations";
import {
  getInvoices,
  getOrCreateMainInvoice,
  getOrCreateSupplementInvoice,
  getOrCreateExtensionInvoice,
  type InvoiceFilters,
  InvoiceLocationNotFoundError,
  InvalidInvoiceAmountError,
  InvalidSupplementKeyError,
  InvalidExtensionEndDateError,
} from "@/lib/invoices";
import { logAction } from "@/lib/audit";

// Sprint 13E tâche 3, corrigé sous-phase 2c2-D : CREDIT_NOTE volontairement absente de cette
// liste de filtre — un avoir se filtre par ?status=CREDIT_NOTE tout de même accepté ci-dessous
// serait incohérent avec cette liste ; en pratique CREDIT_NOTE est visible dans /dashboard/invoices
// sans filtre dédié (liste non filtrée par défaut), et créé exclusivement via
// POST /api/invoices/[id]/credit-notes (createCreditNote, 2c1), jamais via ce endpoint générique.
const INVOICE_STATUSES: InvoiceStatus[] = ["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "VOID"];

export async function GET(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "invoices.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get("status") ?? undefined;
  const agencyId = searchParams.get("agencyId") ?? undefined;
  const clientId = searchParams.get("clientId") ?? undefined;
  const locationId = searchParams.get("locationId") ?? undefined;
  const fromParam = searchParams.get("from") ?? undefined;
  const toParam = searchParams.get("to") ?? undefined;

  if (statusParam && !INVOICE_STATUSES.includes(statusParam as InvoiceStatus)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }

  if (agencyId && !(await canAccessAgency(user, agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  const from = fromParam ? new Date(fromParam) : undefined;
  if (from && Number.isNaN(from.getTime())) {
    return NextResponse.json({ error: "from doit être une date ISO valide." }, { status: 400 });
  }
  const to = toParam ? new Date(toParam) : undefined;
  if (to && Number.isNaN(to.getTime())) {
    return NextResponse.json({ error: "to doit être une date ISO valide." }, { status: 400 });
  }

  const filters: InvoiceFilters = {
    status: statusParam as InvoiceStatus | undefined,
    agencyId,
    clientId,
    locationId,
    from,
    to,
  };

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const invoices = await getInvoices(user.tenantId, filters);

  const visibleInvoices =
    accessibleAgencyIds === null || agencyId
      ? invoices
      : invoices.filter((invoice) => accessibleAgencyIds.includes(invoice.agencyId));

  return NextResponse.json({ invoices: visibleInvoices });
}

interface CreateInvoiceBody {
  locationId?: string;
  // Sprint 13E tâche 3, sous-phase 2b : type optionnel, défaut RENTAL (comportement existant
  // strictement conservé pour toute requête qui ne le fournit pas). CREDIT_NOTE volontairement
  // non acceptée ici (createCreditNote non implémentée à ce stade).
  type?: string;
  taxRate?: number;
  discountAmount?: number;
  dueDate?: string;
  notes?: string;
  // SUPPLEMENT uniquement — clé métier d'idempotence.
  supplementKey?: string;
  // EXTENSION uniquement — date de retour cible, clé métier d'idempotence.
  extensionEndDate?: string;
  // SUPPLEMENT/EXTENSION uniquement — montant explicite, jamais calculé côté serveur.
  amount?: number;
}

/** Normalise les erreurs métier de src/lib/invoices.ts en réponses HTTP — jamais une erreur
 * technique brute exposée à l'appelant. Partagée par les trois branches (RENTAL/SUPPLEMENT/
 * EXTENSION) de POST ci-dessous pour ne pas tripler le même mappage. */
function mapInvoiceCreationError(error: unknown): NextResponse {
  if (error instanceof InvoiceLocationNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (
    error instanceof InvalidInvoiceAmountError ||
    error instanceof InvalidSupplementKeyError ||
    error instanceof InvalidExtensionEndDateError
  ) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  console.error("Erreur lors de la création de la facture :", error);
  return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
}

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "invoices.create"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  let body: CreateInvoiceBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { locationId } = body;
  if (!locationId) {
    return NextResponse.json({ error: "locationId est requis." }, { status: 400 });
  }

  const type = body.type ?? "RENTAL";
  if (type !== "RENTAL" && type !== "SUPPLEMENT" && type !== "EXTENSION") {
    return NextResponse.json(
      { error: "type invalide : RENTAL, SUPPLEMENT ou EXTENSION attendu." },
      { status: 400 }
    );
  }

  if (type === "RENTAL" && (body.supplementKey !== undefined || body.extensionEndDate !== undefined || body.amount !== undefined)) {
    return NextResponse.json(
      { error: "supplementKey/extensionEndDate/amount ne sont pas applicables à type RENTAL." },
      { status: 400 }
    );
  }
  if (type === "SUPPLEMENT" && body.extensionEndDate !== undefined) {
    return NextResponse.json({ error: "extensionEndDate n'est pas applicable à type SUPPLEMENT." }, { status: 400 });
  }
  if (type === "EXTENSION" && body.supplementKey !== undefined) {
    return NextResponse.json({ error: "supplementKey n'est pas applicable à type EXTENSION." }, { status: 400 });
  }
  if (type === "SUPPLEMENT" && (typeof body.supplementKey !== "string" || body.supplementKey.trim() === "")) {
    return NextResponse.json({ error: "supplementKey est requis pour type SUPPLEMENT." }, { status: 400 });
  }
  if (type === "EXTENSION" && !body.extensionEndDate) {
    return NextResponse.json({ error: "extensionEndDate est requis pour type EXTENSION." }, { status: 400 });
  }
  if ((type === "SUPPLEMENT" || type === "EXTENSION") && body.amount === undefined) {
    return NextResponse.json({ error: "amount est requis pour type SUPPLEMENT/EXTENSION." }, { status: 400 });
  }

  let dueDate: Date | undefined;
  if (body.dueDate) {
    dueDate = new Date(body.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      return NextResponse.json({ error: "dueDate doit être une date ISO valide." }, { status: 400 });
    }
  }

  let extensionEndDate: Date | undefined;
  if (type === "EXTENSION") {
    extensionEndDate = new Date(body.extensionEndDate as string);
    if (Number.isNaN(extensionEndDate.getTime())) {
      return NextResponse.json({ error: "extensionEndDate doit être une date ISO valide." }, { status: 400 });
    }
  }

  // L'agence de la facture est dérivée de la Location côté serveur, jamais fournie par
  // le client (même principe que POST /api/locations pour Vehicle → Agency).
  const location = await getLocationById(user.tenantId, locationId);
  if (!location) {
    return NextResponse.json({ error: "Location introuvable." }, { status: 404 });
  }

  if (!(await canAccessAgency(user, location.agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  if (type === "RENTAL") {
    try {
      // Sprint 13E tâche 3 : getOrCreateMainInvoice (au lieu de createInvoice directement) — au
      // plus une facture RENTAL active par Location (verrou + index unique partiel, voir
      // src/lib/invoices.ts). Un second appel sur une Location déjà pourvue d'une facture RENTAL
      // active ne crée plus de doublon : la facture existante est retournée telle quelle (200),
      // jamais une nouvelle ligne (201 réservé à une création réelle).
      const { invoice, created } = await getOrCreateMainInvoice(user.tenantId, locationId, {
        taxRate: body.taxRate,
        discountAmount: body.discountAmount,
        dueDate,
        notes: body.notes,
      });
      if (created) {
        await logAction({
          tenantId: user.tenantId,
          userId: user.id,
          action: "invoice.created",
          resource: "Invoice",
          resourceId: invoice.id,
          metadata: { number: invoice.number, locationId: invoice.locationId },
        });
      }
      return NextResponse.json({ invoice }, { status: created ? 201 : 200 });
    } catch (error) {
      return mapInvoiceCreationError(error);
    }
  }

  if (type === "SUPPLEMENT") {
    try {
      // Sprint 13E tâche 3, sous-phase 2b : jamais acheminée par getOrCreateMainInvoice, jamais
      // soumise à la contrainte « une seule facture active » propre à RENTAL — idempotente par
      // (locationId, supplementKey) uniquement (voir src/lib/invoices.ts).
      const { invoice, created } = await getOrCreateSupplementInvoice(
        user.tenantId,
        locationId,
        body.supplementKey as string,
        {
          amount: body.amount as number,
          taxRate: body.taxRate,
          discountAmount: body.discountAmount,
          dueDate,
          notes: body.notes,
        }
      );
      if (created) {
        await logAction({
          tenantId: user.tenantId,
          userId: user.id,
          action: "invoice.created",
          resource: "Invoice",
          resourceId: invoice.id,
          metadata: { number: invoice.number, locationId: invoice.locationId, type: "SUPPLEMENT", supplementKey: invoice.supplementKey },
        });
      }
      return NextResponse.json({ invoice }, { status: created ? 201 : 200 });
    } catch (error) {
      return mapInvoiceCreationError(error);
    }
  }

  // type === "EXTENSION"
  try {
    // Sprint 13E tâche 3, sous-phase 2b : jamais acheminée par getOrCreateMainInvoice, jamais
    // soumise à la contrainte « une seule facture active » propre à RENTAL — idempotente par
    // (locationId, extensionEndDate) uniquement, clé provisoire et minimale (voir
    // DOMAINRULES.md section 17 et src/lib/invoices.ts).
    const { invoice, created } = await getOrCreateExtensionInvoice(
      user.tenantId,
      locationId,
      extensionEndDate as Date,
      {
        amount: body.amount as number,
        taxRate: body.taxRate,
        discountAmount: body.discountAmount,
        dueDate,
        notes: body.notes,
      }
    );
    if (created) {
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "invoice.created",
        resource: "Invoice",
        resourceId: invoice.id,
        metadata: { number: invoice.number, locationId: invoice.locationId, type: "EXTENSION", extensionEndDate: invoice.extensionEndDate },
      });
    }
    return NextResponse.json({ invoice }, { status: created ? 201 : 200 });
  } catch (error) {
    return mapInvoiceCreationError(error);
  }
}
