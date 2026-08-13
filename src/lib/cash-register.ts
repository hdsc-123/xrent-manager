import type { CashEntry, CashEntryType, CashRegister, ExpenseCategory, PaymentMethod } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export class InvalidCashEntryAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCashEntryAmountError";
  }
}

export class ExpenseCategoryNameInUseError extends Error {
  constructor() {
    super("Une catégorie de dépense avec ce nom existe déjà.");
    this.name = "ExpenseCategoryNameInUseError";
  }
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function startOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** Récupère la caisse du tenant, en la créant si elle n'existe pas encore (un seul CashRegister par tenant, @@unique tenantId). */
export async function getOrCreateCashRegister(tenantId: string): Promise<CashRegister> {
  const existing = await prisma.cashRegister.findUnique({ where: { tenantId } });
  if (existing) {
    return existing;
  }

  try {
    return await prisma.cashRegister.create({
      data: { tenantId, currentMonth: monthKey(new Date()) },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return prisma.cashRegister.findUniqueOrThrow({ where: { tenantId } });
    }
    throw error;
  }
}

export interface CashRegisterSummary {
  currentBalance: number;
  currentMonth: string;
  previousBalance: number;
  monthEntries: number;
  monthExpenses: number;
  finalBalance: number;
  currency: string;
}

/**
 * Recalcule entièrement previousBalance/currentMonth/currentBalance à partir des CashEntry
 * réels (jamais un compteur incrémenté) : previousBalance = solde avant le 1er du mois en
 * cours, monthEntries/monthExpenses = somme des écritures du mois en cours, currentBalance =
 * previousBalance + monthEntries - monthExpenses (= solde final). Appelée après chaque
 * création d'écriture, même principe que recomputeInvoiceStatus (src/lib/payments.ts).
 */
export async function recomputeCashRegisterBalance(tenantId: string): Promise<CashRegisterSummary> {
  const register = await getOrCreateCashRegister(tenantId);
  const now = new Date();
  const monthStart = startOfMonthUtc(now);

  const [priorEntries, priorExpenses, monthEntriesAgg, monthExpensesAgg] = await Promise.all([
    prisma.cashEntry.aggregate({
      where: { tenantId, type: "ENTRY", createdAt: { lt: monthStart } },
      _sum: { amount: true },
    }),
    prisma.cashEntry.aggregate({
      where: { tenantId, type: "EXPENSE", createdAt: { lt: monthStart } },
      _sum: { amount: true },
    }),
    prisma.cashEntry.aggregate({
      where: { tenantId, type: "ENTRY", createdAt: { gte: monthStart } },
      _sum: { amount: true },
    }),
    prisma.cashEntry.aggregate({
      where: { tenantId, type: "EXPENSE", createdAt: { gte: monthStart } },
      _sum: { amount: true },
    }),
  ]);

  const previousBalance = (priorEntries._sum.amount ?? 0) - (priorExpenses._sum.amount ?? 0);
  const monthEntries = monthEntriesAgg._sum.amount ?? 0;
  const monthExpenses = monthExpensesAgg._sum.amount ?? 0;
  const currentMonth = monthKey(now);
  const currentBalance = previousBalance + monthEntries - monthExpenses;

  await prisma.cashRegister.update({
    where: { id: register.id },
    data: { previousBalance, currentMonth, currentBalance },
  });

  return {
    currentBalance,
    currentMonth,
    previousBalance,
    monthEntries,
    monthExpenses,
    finalBalance: currentBalance,
    currency: register.currency,
  };
}

export interface CreateCashEntryInput {
  tenantId: string;
  type: CashEntryType;
  category?: string;
  amount: number;
  description?: string;
  contractId?: string;
  /** Numéro de contrat (Sprint 14B) — dénormalisé, voir CashEntry.contractNumber. */
  contractNumber?: string | null;
  clientName?: string;
  paymentMethod?: PaymentMethod;
  createdAt?: Date;
}

/** Écriture de caisse append-only : pas de update/delete (même principe que Alert, DOMAINRULES section 19). */
export async function createCashEntry(data: CreateCashEntryInput): Promise<CashEntry> {
  if (!Number.isInteger(data.amount) || data.amount <= 0) {
    throw new InvalidCashEntryAmountError("amount doit être un entier positif (plus petite unité monétaire).");
  }

  const register = await getOrCreateCashRegister(data.tenantId);

  const entry = await prisma.cashEntry.create({
    data: {
      tenantId: data.tenantId,
      cashRegisterId: register.id,
      type: data.type,
      category: data.category,
      amount: data.amount,
      currency: register.currency,
      description: data.description,
      contractId: data.contractId,
      contractNumber: data.contractNumber,
      clientName: data.clientName,
      paymentMethod: data.paymentMethod,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });

  await recomputeCashRegisterBalance(data.tenantId);
  return entry;
}

export interface CashEntryFilters {
  type?: CashEntryType;
  category?: string;
  from?: Date;
  to?: Date;
  take?: number;
}

export async function getCashEntries(tenantId: string, filters: CashEntryFilters = {}): Promise<CashEntry[]> {
  return prisma.cashEntry.findMany({
    where: {
      tenantId,
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    },
    ...(filters.take ? { take: filters.take } : {}),
    orderBy: { createdAt: "desc" },
  });
}

export interface DailyBreakdownEntry {
  date: string;
  entries: number;
  expenses: number;
}

/** Répartition entrées/dépenses par jour, sur la période demandée (par défaut les 30 derniers jours) — pour le graphique du tableau de bord Caisse. */
export async function getDailyBreakdown(tenantId: string, from: Date, to: Date): Promise<DailyBreakdownEntry[]> {
  const entries = await prisma.cashEntry.findMany({
    where: { tenantId, createdAt: { gte: from, lte: to } },
    select: { type: true, amount: true, createdAt: true },
  });

  const byDay = new Map<string, DailyBreakdownEntry>();
  for (const entry of entries) {
    const date = entry.createdAt.toISOString().slice(0, 10);
    const bucket = byDay.get(date) ?? { date, entries: 0, expenses: 0 };
    if (entry.type === "ENTRY") {
      bucket.entries += entry.amount;
    } else {
      bucket.expenses += entry.amount;
    }
    byDay.set(date, bucket);
  }

  return Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export async function getExpenseCategories(tenantId: string): Promise<ExpenseCategory[]> {
  return prisma.expenseCategory.findMany({ where: { tenantId }, orderBy: { name: "asc" } });
}

export interface CreateExpenseCategoryInput {
  tenantId: string;
  name: string;
  color?: string;
}

export async function createExpenseCategory(data: CreateExpenseCategoryInput): Promise<ExpenseCategory> {
  try {
    return await prisma.expenseCategory.create({
      data: { tenantId: data.tenantId, name: data.name, color: data.color },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ExpenseCategoryNameInUseError();
    }
    throw error;
  }
}
