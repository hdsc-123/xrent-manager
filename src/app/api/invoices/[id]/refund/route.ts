import { NextResponse } from "next/server";
import type { PaymentMethod } from "@prisma/client";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_AUTHENTICATED_JSON_BODY_BYTES } from "@/lib/request-guards";
import {
  getInvoiceById,
  refundCreditNote,
  CreditNoteRefundReasonRequiredError,
  CreditNoteNotFoundError,
  InvoiceIsNotCreditNoteError,
  CreditNoteSourceMissingError,
  CreditNoteSourceVoidError,
  CreditNoteExceedsRefundableAmountError,
  InvalidInvoiceAmountError,
} from "@/lib/invoices";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface RefundCreditNoteBody {
  amount?: number;
  reason?: string;
  paymentMethod?: string;
}

const VALID_PAYMENT_METHODS = ["CASH", "CARD", "BANK_TRANSFER", "CHECK", "OTHER"];

/**
 * Sprint 13E tâche 3, sous-phase 2c2-C — rembourse tout ou partie d'un avoir déjà émis. `id`
 * (paramètre de route) désigne directement l'avoir (CREDIT_NOTE) à rembourser, jamais sa facture
 * source — même convention que POST /api/invoices/[id]/admin-cancel ou .../versions (chaque
 * facture est adressée par son propre id, jamais nichée sous une autre) : un déviation
 * délibérée par rapport à un chemin `.../credit-notes/refund` qui laisserait ambigu QUEL avoir
 * est visé si une même source en porte plusieurs.
 *
 * Réservé ADMIN strict, dérivé uniquement de `user.role` côté route (jamais une permission
 * granulaire — même principe que POST /api/invoices/[id]/admin-cancel et
 * POST /api/invoices/[id]/credit-notes, SECURITY.md section 4). `tenantId`/`agencyId` toujours
 * dérivés côté serveur depuis l'avoir déjà chargé et vérifié, jamais fournis par le client.
 */
export async function POST(request: Request, { params }: RouteParams) {
  if (isRequestBodyTooLarge(request, MAX_AUTHENTICATED_JSON_BODY_BYTES)) {
    return requestBodyTooLargeResponse(MAX_AUTHENTICATED_JSON_BODY_BYTES);
  }

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Réservé aux administrateurs." }, { status: 403 });
  }

  let body: RefundCreditNoteBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (typeof body.reason !== "string" || !body.reason.trim()) {
    return NextResponse.json({ error: "Un motif est obligatoire pour rembourser un avoir." }, { status: 400 });
  }
  if (typeof body.amount !== "number") {
    return NextResponse.json(
      { error: "amount doit être un entier fini strictement positif (plus petite unité monétaire)." },
      { status: 400 }
    );
  }
  if (body.paymentMethod !== undefined && !VALID_PAYMENT_METHODS.includes(body.paymentMethod)) {
    return NextResponse.json({ error: "paymentMethod invalide." }, { status: 400 });
  }

  const { id } = await params;
  const existing = await getInvoiceById(user.tenantId, id);
  if (!existing) {
    return NextResponse.json({ error: "Avoir introuvable." }, { status: 404 });
  }
  if (existing.type !== "CREDIT_NOTE") {
    return NextResponse.json({ error: "Seul un avoir (CREDIT_NOTE) peut faire l'objet d'un remboursement." }, { status: 404 });
  }
  // Structurellement identique à l'agence de la facture source (dérivée sans jamais être
  // fournie par le client, voir createCreditNote/2c1) — vérifiée pour cohérence, même si un
  // ADMIN passe toujours ce contrôle pour son propre tenant (canAccessAgency).
  if (!(await canAccessAgency(user, existing.agencyId))) {
    return NextResponse.json({ error: "Avoir introuvable." }, { status: 404 });
  }

  try {
    const result = await refundCreditNote({
      tenantId: user.tenantId,
      creditNoteId: id,
      amount: body.amount,
      reason: body.reason,
      performedByUserId: user.id,
      paymentMethod: body.paymentMethod as PaymentMethod | undefined,
    });

    return NextResponse.json(
      { creditNote: result.creditNote, cashEntry: result.cashEntry },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof InvalidInvoiceAmountError || error instanceof CreditNoteRefundReasonRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof CreditNoteNotFoundError || error instanceof CreditNoteSourceMissingError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (
      error instanceof InvoiceIsNotCreditNoteError ||
      error instanceof CreditNoteSourceVoidError ||
      error instanceof CreditNoteExceedsRefundableAmountError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors du remboursement de l'avoir :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
