import { NextResponse } from "next/server";
import type { CashEntryType, PaymentMethod } from "@prisma/client";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import {
  getOrCreateCashRegister,
  recomputeCashRegisterBalance,
  createCashEntry,
  getCashEntries,
  getDailyBreakdown,
  InvalidCashEntryAmountError,
} from "@/lib/cash-register";
import { logAction } from "@/lib/audit";

const CASH_ENTRY_TYPES: CashEntryType[] = ["ENTRY", "EXPENSE"];
const PAYMENT_METHODS: PaymentMethod[] = ["CASH", "CARD", "BANK_TRANSFER", "CHECK", "OTHER"];

/** Solde (recalculé), répartition entrées/dépenses par jour sur les 30 derniers jours, 10 dernières opérations. */
export async function GET(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "cash_register.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const daysParam = Number(searchParams.get("days") ?? "30");
  const days = Number.isInteger(daysParam) && daysParam > 0 ? daysParam : 30;

  await getOrCreateCashRegister(user.tenantId);
  const summary = await recomputeCashRegisterBalance(user.tenantId);

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const [dailyBreakdown, recentOperations] = await Promise.all([
    getDailyBreakdown(user.tenantId, from, to),
    getCashEntries(user.tenantId, { take: 10 }),
  ]);

  return NextResponse.json({ summary, dailyBreakdown, recentOperations });
}

interface CreateCashEntryBody {
  type?: CashEntryType;
  category?: string;
  amount?: number;
  description?: string;
  contractId?: string;
  clientName?: string;
  paymentMethod?: PaymentMethod;
}

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  let body: CreateCashEntryBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { type, amount } = body;
  if (!type || amount === undefined) {
    return NextResponse.json({ error: "type et amount sont requis." }, { status: 400 });
  }

  if (!CASH_ENTRY_TYPES.includes(type)) {
    return NextResponse.json({ error: "type invalide (ENTRY ou EXPENSE)." }, { status: 400 });
  }

  const requiredPermission = type === "ENTRY" ? "cash_register.create_entry" : "cash_register.create_expense";
  if (!(await can(user, requiredPermission))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  if (body.paymentMethod && !PAYMENT_METHODS.includes(body.paymentMethod)) {
    return NextResponse.json({ error: "paymentMethod invalide." }, { status: 400 });
  }

  try {
    const entry = await createCashEntry({
      tenantId: user.tenantId,
      type,
      category: body.category,
      amount,
      description: body.description,
      contractId: body.contractId,
      clientName: body.clientName,
      paymentMethod: body.paymentMethod,
    });
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: type === "ENTRY" ? "cashEntry.created" : "cashExpense.created",
      resource: "CashEntry",
      resourceId: entry.id,
      metadata: { type: entry.type, category: entry.category, amount: entry.amount },
    });
    return NextResponse.json({ entry }, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidCashEntryAmountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("Erreur lors de la création de l'écriture de caisse :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
