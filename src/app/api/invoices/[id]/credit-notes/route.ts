import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import {
  getInvoiceById,
  createCreditNote,
  getTotalCreditedAmount,
  CreditNoteReasonRequiredError,
  CreditNoteSourceNotFoundError,
  CreditNoteSourceTypeNotEligibleError,
  CreditNoteSourceStatusNotEligibleError,
  CreditNoteExceedsRemainingCreditError,
  InvalidInvoiceAmountError,
} from "@/lib/invoices";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface CreateCreditNoteBody {
  amount?: number;
  reason?: string;
  notes?: string;
}

/**
 * Sprint 13E tâche 3, sous-phase 2c1 — crée un avoir (CREDIT_NOTE) référençant la facture
 * source `id`. Réservé ADMIN, dérivé uniquement de `user.role` côté route (jamais une
 * permission granulaire — même principe que POST /api/invoices/[id]/admin-cancel,
 * SECURITY.md section 4). `locationId` n'est jamais lu depuis le corps de requête : dérivé
 * exclusivement de la facture source déjà chargée et vérifiée ci-dessous (tenant + agence),
 * jamais fourni par le client.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Réservé aux administrateurs." }, { status: 403 });
  }

  let body: CreateCreditNoteBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (typeof body.reason !== "string" || !body.reason.trim()) {
    return NextResponse.json({ error: "Un motif est obligatoire pour créer un avoir." }, { status: 400 });
  }
  if (typeof body.amount !== "number") {
    return NextResponse.json(
      { error: "amount doit être un entier fini strictement positif (plus petite unité monétaire)." },
      { status: 400 }
    );
  }

  const { id } = await params;
  const existing = await getInvoiceById(user.tenantId, id);
  if (!existing) {
    return NextResponse.json({ error: "Facture source introuvable." }, { status: 404 });
  }
  if (!(await canAccessAgency(user, existing.agencyId))) {
    return NextResponse.json({ error: "Facture source introuvable." }, { status: 404 });
  }

  try {
    const alreadyCreditedBefore = await getTotalCreditedAmount(existing.id);

    const creditNote = await createCreditNote({
      tenantId: user.tenantId,
      locationId: existing.locationId,
      originalInvoiceId: id,
      amount: body.amount,
      reason: body.reason,
      notes: body.notes,
    });

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "invoice.credit_note_created",
      resource: "Invoice",
      resourceId: creditNote.id,
      metadata: {
        originalInvoiceId: existing.id,
        sourceType: existing.type,
        sourceStatus: existing.status,
        originalTotal: existing.totalAmount,
        alreadyCreditedBefore,
        creditNoteAmount: creditNote.totalAmount,
        remainingCreditAfter: existing.totalAmount - alreadyCreditedBefore - creditNote.totalAmount,
        reason: creditNote.reason,
        agencyId: existing.agencyId,
      } as unknown as Prisma.InputJsonValue,
    });

    return NextResponse.json({ invoice: creditNote }, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidInvoiceAmountError || error instanceof CreditNoteReasonRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof CreditNoteSourceNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (
      error instanceof CreditNoteSourceTypeNotEligibleError ||
      error instanceof CreditNoteSourceStatusNotEligibleError ||
      error instanceof CreditNoteExceedsRemainingCreditError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la création de l'avoir :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
