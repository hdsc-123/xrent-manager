import { NextResponse } from "next/server";
import type { PaymentMethod } from "@prisma/client";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { PAYMENT_METHODS } from "@/lib/location-payment";
import {
  getDamageInvoiceById,
  createDamageInvoicePayments,
  type DamagePaymentLine,
  DamageInvoiceNotFoundError,
  DamageInvoiceCancelledError,
  DamageInvoicePaymentExceedsBalanceError,
  InvalidDamageInvoicePaymentAmountError,
} from "@/lib/damage-invoices";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface PaymentLineBody {
  method?: unknown;
  amount?: unknown;
}

interface CreateDamageInvoicePaymentBody {
  method?: PaymentMethod;
  amount?: number;
  lines?: PaymentLineBody[];
  reference?: string;
  notes?: string;
}

function parseLines(raw: unknown): { value: DamagePaymentLine[] } | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: "lines doit être un tableau." };
  }
  const lines: DamagePaymentLine[] = [];
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

/**
 * Sprint 33 (DOMAINRULES.md section 48) — encaissement d'un paiement contre une DamageInvoice
 * (espèces/carte/mixte selon le nombre de lignes), hors du flux de retour (voir POST
 * /api/locations/[id]/return pour un paiement intégré au retour, même service réutilisé,
 * createDamageInvoicePayments). Remplace l'ancienne route POST /api/damages/[id]/payments
 * (Sprint 32, retirée) — un paiement de dégât n'est plus jamais possible sans DamageInvoice.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "damage_invoices.payment.create"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const invoice = await getDamageInvoiceById(user.tenantId, id);
  if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) {
    return NextResponse.json({ error: "Facture de dégâts introuvable." }, { status: 404 });
  }

  let body: CreateDamageInvoicePaymentBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  let lines: DamagePaymentLine[];
  if (body.lines !== undefined) {
    const parsed = parseLines(body.lines);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    lines = parsed.value;
  } else {
    if (typeof body.method !== "string" || !PAYMENT_METHODS.includes(body.method)) {
      return NextResponse.json({ error: "Mode de paiement invalide." }, { status: 400 });
    }
    if (typeof body.amount !== "number") {
      return NextResponse.json({ error: "amount est requis." }, { status: 400 });
    }
    lines = [{ method: body.method, amount: body.amount }];
  }

  try {
    const payments = await createDamageInvoicePayments({
      tenantId: user.tenantId,
      damageInvoiceId: invoice.id,
      lines,
      reference: body.reference,
      notes: body.notes,
    });

    for (const payment of payments) {
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "damage_invoice.payment_created",
        resource: "Payment",
        resourceId: payment.id,
        metadata: { damageInvoiceId: invoice.id, amount: payment.amount, method: payment.method },
      });
    }

    return NextResponse.json({ payments }, { status: 201 });
  } catch (error) {
    if (error instanceof DamageInvoiceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof InvalidDamageInvoicePaymentAmountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DamageInvoiceCancelledError || error instanceof DamageInvoicePaymentExceedsBalanceError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de l'encaissement du paiement de la facture de dégâts :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
