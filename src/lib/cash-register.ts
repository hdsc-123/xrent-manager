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

/** Sprint 26D (Finding D1) : motif obligatoire pour toute compensation (correction de
 * paiement, remboursement) — jamais exigé pour une écriture manuelle ordinaire
 * (createCashEntry). */
export class CorrectionReasonRequiredError extends Error {
  constructor() {
    super("Un motif est obligatoire pour toute correction affectant le montant, le moyen ou le remboursement d'un paiement.");
    this.name = "CorrectionReasonRequiredError";
  }
}

/** Sprint 19 : une écriture issue d'un paiement (contractId renseigné, voir
 * recordPaymentCashEntry dans src/lib/payments.ts) reste définitivement append-only —
 * seules les écritures manuelles (contractId absent, créées directement via ce module)
 * peuvent être modifiées/supprimées, voir updateCashEntry/deleteCashEntry ci-dessous. */
export class CashEntryNotEditableError extends Error {
  constructor() {
    super("Cette écriture est liée à un paiement et ne peut pas être modifiée ni supprimée.");
    this.name = "CashEntryNotEditableError";
  }
}

/** Sprint 25B (correction, DOMAINRULES.md/SECURITY.md — isolation par agence) : une écriture
 * manuelle rattachée à une agence hors du périmètre accessible à l'appelant (voir
 * getAccessibleAgencyIds, src/lib/authz.ts) ne peut être ni modifiée ni supprimée par un
 * non-ADMIN, même si elle appartient au même tenant et même s'il détient
 * cash_register.edit/delete — jusqu'ici seuls le tenant et la permission étaient vérifiés,
 * jamais l'agence de l'écriture ciblée (SECURITY.md section 2). Message générique, sans
 * détail sur l'agence réelle de l'écriture. */
export class CashEntryAgencyAccessDeniedError extends Error {
  constructor() {
    super("Accès refusé à cette agence.");
    this.name = "CashEntryAgencyAccessDeniedError";
  }
}

/** Exportée (Sprint 17) pour src/lib/data-reset.ts — après une purge complète des CashEntry
 * d'un tenant, le solde recalculé est trivialement 0 (previousBalance/currentBalance), ce qui
 * permet de le poser directement dans la même transaction Prisma que la purge plutôt que
 * d'appeler recomputeCashRegisterBalance (non transactionnelle) après coup. */
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function startOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/**
 * Récupère la caisse du tenant, en la créant si elle n'existe pas encore (un seul
 * CashRegister par tenant, @@unique tenantId).
 *
 * `tx` optionnel (Sprint 26A, Finding A) — défaut au client Prisma global, comportement
 * inchangé pour tout appel sans transaction partagée. Limite documentée (même principe que
 * `createLocation`/`createInvoice`, src/lib/locations.ts/invoices.ts) : le rattrapage sur
 * collision (P2002, uniquement en cas de toute première écriture de caisse d'un tenant
 * créée par deux requêtes concurrentes) n'est retenté qu'en dehors d'une transaction
 * partagée explicite — une transaction Postgres ne permet pas de rattraper une erreur de
 * contrainte et de continuer d'écrire sans SAVEPOINT.
 */
export async function getOrCreateCashRegister(
  tenantId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<CashRegister> {
  const existing = await tx.cashRegister.findUnique({ where: { tenantId } });
  if (existing) {
    return existing;
  }

  try {
    return await tx.cashRegister.create({
      data: { tenantId, currentMonth: monthKey(new Date()) },
    });
  } catch (error) {
    if (tx === prisma && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return tx.cashRegister.findUniqueOrThrow({ where: { tenantId } });
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
  /** Sprint 19 (DOMAINRULES.md section 37) : répartition espèces/carte des entrées du mois —
   * paymentMethod est déjà stocké par écriture (voir createPayment → recordPaymentCashEntry,
   * src/lib/payments.ts, qui crée une CashEntry par ligne de paiement, y compris pour un
   * paiement mixte) ; seule l'agrégation manquait jusqu'ici. Ignore les entrées sans
   * paymentMethod (versements manuels sans mode renseigné) et tout mode autre que CASH/CARD
   * (virement/chèque/autre) — non comptés dans ni l'un ni l'autre. */
  monthCash: number;
  monthCard: number;
}

/**
 * Sprint 25A (correction, décision métier confirmée par le propriétaire du projet — revient
 * sur la décision Sprint 19/22/24 qui gardait `Agency.cashStartingBalance` purement informatif,
 * jamais mêlé au solde réel) : somme des soldes de départ des agences du périmètre demandé
 * (toutes les agences du tenant si `agencyIds` est `null` — vue ADMIN ; uniquement les agences
 * listées sinon — vue scopée). Intégrée une seule fois, dans `previousBalance` (le report), au
 * point le plus ancien de la chaîne — jamais réinjectée dans `currentBalance`, qui continue de
 * se dériver de `previousBalance` seul, pour ne jamais compter le solde de départ deux fois.
 */
async function getAgencyStartingBalanceSum(
  tenantId: string,
  agencyIds: string[] | null,
  tx: Prisma.TransactionClient = prisma
): Promise<number> {
  const agg = await tx.agency.aggregate({
    where: { tenantId, ...(agencyIds ? { id: { in: agencyIds } } : {}) },
    _sum: { cashStartingBalance: true },
  });
  return agg._sum.cashStartingBalance ?? 0;
}

/**
 * Recalcule entièrement previousBalance/currentMonth/currentBalance à partir des CashEntry
 * réels (jamais un compteur incrémenté) et des soldes de départ des agences du tenant (Sprint
 * 25A, voir getAgencyStartingBalanceSum) : previousBalance = Σ Agency.cashStartingBalance +
 * solde avant le 1er du mois en cours, monthEntries/monthExpenses = somme des écritures du
 * mois en cours, currentBalance = previousBalance + monthEntries - monthExpenses (= solde
 * final). Un remboursement (ex. compensation d'annulation, category "ANNULATION_CONTRAT",
 * src/lib/locations.ts) ou une correction manuelle (POST /api/cash-register, catégorie libre)
 * sont déjà des CashEntry ENTRY/EXPENSE ordinaires — comptées ici sans traitement séparé, sans
 * risque de double comptage avec le solde de départ. Appelée après chaque création d'écriture,
 * même principe que recomputeInvoiceStatus (src/lib/payments.ts).
 *
 * `tx` optionnel (Sprint 26A, Finding A) — défaut au client Prisma global, comportement et
 * formule inchangés pour tout appel sans transaction partagée. Aucune modification de la
 * formule de calcul elle-même (Sprint 25A) dans ce correctif.
 */
export async function recomputeCashRegisterBalance(
  tenantId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<CashRegisterSummary> {
  const register = await getOrCreateCashRegister(tenantId, tx);
  const now = new Date();
  const monthStart = startOfMonthUtc(now);

  const [startingBalanceSum, priorEntries, priorExpenses, monthEntriesAgg, monthExpensesAgg, monthCashAgg, monthCardAgg] =
    await Promise.all([
      getAgencyStartingBalanceSum(tenantId, null, tx),
      tx.cashEntry.aggregate({
        where: { tenantId, type: "ENTRY", createdAt: { lt: monthStart } },
        _sum: { amount: true },
      }),
      tx.cashEntry.aggregate({
        where: { tenantId, type: "EXPENSE", createdAt: { lt: monthStart } },
        _sum: { amount: true },
      }),
      tx.cashEntry.aggregate({
        where: { tenantId, type: "ENTRY", createdAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      tx.cashEntry.aggregate({
        where: { tenantId, type: "EXPENSE", createdAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      tx.cashEntry.aggregate({
        where: { tenantId, type: "ENTRY", paymentMethod: "CASH", createdAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      tx.cashEntry.aggregate({
        where: { tenantId, type: "ENTRY", paymentMethod: "CARD", createdAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
    ]);

  const previousBalance = startingBalanceSum + (priorEntries._sum.amount ?? 0) - (priorExpenses._sum.amount ?? 0);
  const monthEntries = monthEntriesAgg._sum.amount ?? 0;
  const monthExpenses = monthExpensesAgg._sum.amount ?? 0;
  const currentMonth = monthKey(now);
  const currentBalance = previousBalance + monthEntries - monthExpenses;

  await tx.cashRegister.update({
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
    monthCash: monthCashAgg._sum.amount ?? 0,
    monthCard: monthCardAgg._sum.amount ?? 0,
  };
}

/**
 * Sprint 24 (correction) : équivalent en lecture seule de recomputeCashRegisterBalance
 * ci-dessus, restreint aux écritures des agences fournies (voir getAccessibleAgencyIds,
 * src/lib/authz.ts). N'écrit jamais dans CashRegister (qui reste le solde tenant-wide,
 * consulté tel quel par un ADMIN — décision Sprint 19 reconduite, DOMAINRULES.md section 23) :
 * un non-ADMIN restreint à une ou plusieurs agences doit voir *son* solde/mois/répartition
 * espèces-carte, pas celui de tout le tenant — jusqu'ici la page Caisse affichait le même
 * total tenant-wide à tout titulaire de cash_register.view, quel que soit son périmètre réel
 * (SECURITY.md section 2).
 */
export async function getCashRegisterSummaryForAgencies(
  tenantId: string,
  agencyIds: string[]
): Promise<CashRegisterSummary> {
  const register = await getOrCreateCashRegister(tenantId);
  const now = new Date();
  const monthStart = startOfMonthUtc(now);
  const agencyFilter = { agencyId: { in: agencyIds } };

  const [startingBalanceSum, priorEntries, priorExpenses, monthEntriesAgg, monthExpensesAgg, monthCashAgg, monthCardAgg] =
    await Promise.all([
      getAgencyStartingBalanceSum(tenantId, agencyIds),
      prisma.cashEntry.aggregate({
        where: { tenantId, type: "ENTRY", createdAt: { lt: monthStart }, ...agencyFilter },
        _sum: { amount: true },
      }),
      prisma.cashEntry.aggregate({
        where: { tenantId, type: "EXPENSE", createdAt: { lt: monthStart }, ...agencyFilter },
        _sum: { amount: true },
      }),
      prisma.cashEntry.aggregate({
        where: { tenantId, type: "ENTRY", createdAt: { gte: monthStart }, ...agencyFilter },
        _sum: { amount: true },
      }),
      prisma.cashEntry.aggregate({
        where: { tenantId, type: "EXPENSE", createdAt: { gte: monthStart }, ...agencyFilter },
        _sum: { amount: true },
      }),
      prisma.cashEntry.aggregate({
        where: { tenantId, type: "ENTRY", paymentMethod: "CASH", createdAt: { gte: monthStart }, ...agencyFilter },
        _sum: { amount: true },
      }),
      prisma.cashEntry.aggregate({
        where: { tenantId, type: "ENTRY", paymentMethod: "CARD", createdAt: { gte: monthStart }, ...agencyFilter },
        _sum: { amount: true },
      }),
    ]);

  const previousBalance = startingBalanceSum + (priorEntries._sum.amount ?? 0) - (priorExpenses._sum.amount ?? 0);
  const monthEntries = monthEntriesAgg._sum.amount ?? 0;
  const monthExpenses = monthExpensesAgg._sum.amount ?? 0;
  const currentBalance = previousBalance + monthEntries - monthExpenses;

  return {
    currentBalance,
    currentMonth: monthKey(now),
    previousBalance,
    monthEntries,
    monthExpenses,
    finalBalance: currentBalance,
    currency: register.currency,
    monthCash: monthCashAgg._sum.amount ?? 0,
    monthCard: monthCardAgg._sum.amount ?? 0,
  };
}

export interface CreateCashEntryInput {
  tenantId: string;
  type: CashEntryType;
  category?: string;
  amount: number;
  description?: string;
  /** Sprint 22 — agence d'origine (voir le commentaire du champ dans prisma/schema.prisma) :
   * dérivée automatiquement pour une écriture issue d'un paiement (recordPaymentCashEntry,
   * src/lib/payments.ts), choisie explicitement pour une écriture manuelle. */
  agencyId?: string;
  contractId?: string;
  /** Numéro de contrat (Sprint 14B) — dénormalisé, voir CashEntry.contractNumber. */
  contractNumber?: string | null;
  clientName?: string;
  paymentMethod?: PaymentMethod;
  createdAt?: Date;
  /** Sprint 26D (Finding D1) — voir le commentaire du champ dans prisma/schema.prisma :
   * renseigné uniquement pour l'écriture originale d'un Payment (recordPaymentCashEntry,
   * src/lib/payments.ts), jamais pour une écriture manuelle. */
  paymentId?: string;
}

/**
 * Écriture de caisse append-only : pas de update/delete (même principe que Alert, DOMAINRULES
 * section 19).
 *
 * `tx` optionnel (Sprint 26A, Finding A) — défaut au client Prisma global, comportement
 * inchangé pour tout appel sans transaction partagée (POST /api/cash-register, etc.).
 */
export async function createCashEntry(
  data: CreateCashEntryInput,
  tx: Prisma.TransactionClient = prisma
): Promise<CashEntry> {
  if (!Number.isInteger(data.amount) || data.amount <= 0) {
    throw new InvalidCashEntryAmountError("amount doit être un entier positif (plus petite unité monétaire).");
  }

  const register = await getOrCreateCashRegister(data.tenantId, tx);

  const entry = await tx.cashEntry.create({
    data: {
      tenantId: data.tenantId,
      cashRegisterId: register.id,
      type: data.type,
      category: data.category,
      amount: data.amount,
      currency: register.currency,
      description: data.description,
      agencyId: data.agencyId,
      contractId: data.contractId,
      contractNumber: data.contractNumber,
      clientName: data.clientName,
      paymentMethod: data.paymentMethod,
      paymentId: data.paymentId,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });

  await recomputeCashRegisterBalance(data.tenantId, tx);
  return entry;
}

export interface CreateCorrectionCashEntryInput {
  tenantId: string;
  /** L'écriture originale que cette compensation corrige — jamais modifiée elle-même
   * (append-only, DOMAINRULES.md section 23). */
  parentEntryId: string;
  paymentId: string;
  type: CashEntryType;
  amount: number;
  paymentMethod: PaymentMethod;
  category: string;
  description?: string;
  reason: string;
  performedByUserId: string;
  agencyId?: string;
  contractId?: string;
  contractNumber?: string | null;
  clientName?: string;
}

/**
 * Sprint 26D (Finding D1) : crée une CashEntry de compensation liée à une écriture
 * originale (parentEntryId) et à son Payment (paymentId) — jamais une modification ou
 * une suppression de l'originale, qui reste la source de vérité immuable. Contrairement
 * à createCashEntry (écritures manuelles), motif et agent sont ici obligatoires : une
 * compensation sans motif ou sans agent identifié n'a pas de sens métier (elle doit
 * toujours être traçable jusqu'à la correction/l'annulation qui l'a produite).
 */
export async function createCorrectionCashEntry(
  data: CreateCorrectionCashEntryInput,
  tx: Prisma.TransactionClient = prisma
): Promise<CashEntry> {
  if (!Number.isInteger(data.amount) || data.amount <= 0) {
    throw new InvalidCashEntryAmountError("amount doit être un entier positif (plus petite unité monétaire).");
  }
  if (!data.reason.trim()) {
    throw new CorrectionReasonRequiredError();
  }

  const register = await getOrCreateCashRegister(data.tenantId, tx);

  const entry = await tx.cashEntry.create({
    data: {
      tenantId: data.tenantId,
      cashRegisterId: register.id,
      type: data.type,
      category: data.category,
      amount: data.amount,
      currency: register.currency,
      description: data.description,
      agencyId: data.agencyId,
      contractId: data.contractId,
      contractNumber: data.contractNumber,
      clientName: data.clientName,
      paymentMethod: data.paymentMethod,
      paymentId: data.paymentId,
      parentEntryId: data.parentEntryId,
      reason: data.reason.trim(),
      performedByUserId: data.performedByUserId,
    },
  });

  await recomputeCashRegisterBalance(data.tenantId, tx);
  return entry;
}

export interface UpdateCashEntryInput {
  category?: string;
  amount?: number;
  description?: string;
}

/** Sprint 19 : modifie une écriture manuelle (contractId absent) — 404 (null) si introuvable
 * dans le tenant, CashEntryNotEditableError (409, voir la route) si elle est liée à un
 * paiement. Recalcule toujours le solde après coup, même principe que createCashEntry.
 *
 * Sprint 25B : `accessibleAgencyIds` (voir getAccessibleAgencyIds, src/lib/authz.ts) — `null`
 * pour un ADMIN (aucune restriction, comportement inchangé), sinon la liste des agences
 * accessibles à l'appelant. Vérifié avant CashEntryNotEditableError ci-dessous (contrôle
 * d'autorisation avant règle métier, même ordre que le reste du projet). Une écriture sans
 * agence (`agencyId: null`) est refusée à tout non-ADMIN — même règle déjà appliquée par les
 * vues scopées en lecture (getCashEntries/getCashRegisterSummaryForAgencies, dont le filtre
 * `agencyId: { in: accessibleAgencyIds } }` n'inclut jamais `null`) — seul un ADMIN y accède. */
export async function updateCashEntry(
  tenantId: string,
  entryId: string,
  data: UpdateCashEntryInput,
  accessibleAgencyIds: string[] | null
): Promise<CashEntry | null> {
  const existing = await prisma.cashEntry.findFirst({ where: { id: entryId, tenantId } });
  if (!existing) {
    return null;
  }
  if (
    accessibleAgencyIds !== null &&
    (existing.agencyId === null || !accessibleAgencyIds.includes(existing.agencyId))
  ) {
    throw new CashEntryAgencyAccessDeniedError();
  }
  if (existing.contractId) {
    throw new CashEntryNotEditableError();
  }
  if (data.amount !== undefined && (!Number.isInteger(data.amount) || data.amount <= 0)) {
    throw new InvalidCashEntryAmountError("amount doit être un entier positif (plus petite unité monétaire).");
  }

  const updated = await prisma.cashEntry.update({
    where: { id: entryId },
    data: {
      ...(data.category !== undefined ? { category: data.category } : {}),
      ...(data.amount !== undefined ? { amount: data.amount } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
    },
  });

  await recomputeCashRegisterBalance(tenantId);
  return updated;
}

/** Sprint 19 : supprime une écriture manuelle (contractId absent) — mêmes garanties que
 * updateCashEntry ci-dessus (false si introuvable, CashEntryNotEditableError si liée à un
 * paiement). Recalcule toujours le solde après coup.
 *
 * Sprint 25B : `accessibleAgencyIds`, même contrat que updateCashEntry ci-dessus (`null` = ADMIN
 * sans restriction ; une écriture sans agence est refusée à tout non-ADMIN). */
export async function deleteCashEntry(
  tenantId: string,
  entryId: string,
  accessibleAgencyIds: string[] | null
): Promise<boolean> {
  const existing = await prisma.cashEntry.findFirst({ where: { id: entryId, tenantId } });
  if (!existing) {
    return false;
  }
  if (
    accessibleAgencyIds !== null &&
    (existing.agencyId === null || !accessibleAgencyIds.includes(existing.agencyId))
  ) {
    throw new CashEntryAgencyAccessDeniedError();
  }
  if (existing.contractId) {
    throw new CashEntryNotEditableError();
  }

  await prisma.cashEntry.delete({ where: { id: entryId } });
  await recomputeCashRegisterBalance(tenantId);
  return true;
}

export interface CashEntryFilters {
  type?: CashEntryType;
  category?: string;
  from?: Date;
  to?: Date;
  take?: number;
  /** Sprint 24 : restreint aux écritures rattachées à l'une de ces agences (voir
   * getAccessibleAgencyIds, src/lib/authz.ts) — un non-ADMIN ne doit voir que le périmètre de
   * son agence/ville/groupe, jamais la caisse d'agences auxquelles il n'est pas rattaché.
   * Une écriture manuelle sans agencyId (non attribuée) n'est incluse dans aucun périmètre
   * scopé — cohérent avec getUnattributedCashAmount ci-dessous. `undefined`/absent = aucune
   * restriction (ADMIN). */
  agencyIds?: string[];
}

export async function getCashEntries(tenantId: string, filters: CashEntryFilters = {}): Promise<CashEntry[]> {
  return prisma.cashEntry.findMany({
    where: {
      tenantId,
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.agencyIds ? { agencyId: { in: filters.agencyIds } } : {}),
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
  /** Sprint 19 (DOMAINRULES.md section 37) : sous-répartition des entrées (type ENTRY
   * uniquement) par mode de règlement — espèces/carte, pour un rapprochement de caisse
   * physique cohérent jour par jour. Un mode autre que CASH/CARD (virement/chèque/autre/absent)
   * n'est compté dans aucun des deux, mais reste inclus dans `entries` ci-dessus. */
  cash: number;
  card: number;
}

/**
 * Répartition entrées/dépenses par jour, sur la période demandée (par défaut les 30 derniers
 * jours) — pour le graphique du tableau de bord Caisse. Sprint 24 : `agencyIds` restreint aux
 * écritures des agences accessibles à l'appelant (voir CashEntryFilters.agencyIds ci-dessus) —
 * `undefined`/absent = aucune restriction (ADMIN).
 */
export async function getDailyBreakdown(
  tenantId: string,
  from: Date,
  to: Date,
  agencyIds?: string[]
): Promise<DailyBreakdownEntry[]> {
  const entries = await prisma.cashEntry.findMany({
    where: {
      tenantId,
      createdAt: { gte: from, lte: to },
      ...(agencyIds ? { agencyId: { in: agencyIds } } : {}),
    },
    select: { type: true, amount: true, createdAt: true, paymentMethod: true },
  });

  const byDay = new Map<string, DailyBreakdownEntry>();
  for (const entry of entries) {
    const date = entry.createdAt.toISOString().slice(0, 10);
    const bucket = byDay.get(date) ?? { date, entries: 0, expenses: 0, cash: 0, card: 0 };
    if (entry.type === "ENTRY") {
      bucket.entries += entry.amount;
      if (entry.paymentMethod === "CASH") bucket.cash += entry.amount;
      else if (entry.paymentMethod === "CARD") bucket.card += entry.amount;
    } else {
      bucket.expenses += entry.amount;
    }
    byDay.set(date, bucket);
  }

  return Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export interface AgencyCashBalance {
  agencyId: string;
  agencyName: string;
  /** Agency.cashStartingBalance — informatif jusqu'au Sprint 19, désormais intégré ci-dessous. */
  startingBalance: number;
  entries: number;
  expenses: number;
  /** startingBalance + entries - expenses — solde réel dérivé pour cette agence. */
  balance: number;
  currency: string;
}

/**
 * Sprint 22 (DOMAINRULES.md section 23, révisée) : solde réel par agence, calculé sans
 * restructurer CashRegister (qui reste un singleton par tenant, décision reconduite au
 * Sprint 19) — startingBalance + Σ CashEntry.amount (ENTRY) - Σ CashEntry.amount (EXPENSE),
 * filtrées par CashEntry.agencyId. `agencyIds` restreint le calcul aux agences accessibles à
 * l'appelant (voir getAccessibleAgencyIds, src/lib/authz.ts) — null = toutes les agences du
 * tenant (ADMIN).
 */
export async function getCashBalanceByAgency(
  tenantId: string,
  agencyIds: string[] | null
): Promise<AgencyCashBalance[]> {
  const register = await getOrCreateCashRegister(tenantId);

  const agencies = await prisma.agency.findMany({
    where: { tenantId, ...(agencyIds ? { id: { in: agencyIds } } : {}) },
    select: { id: true, name: true, cashStartingBalance: true },
    orderBy: { name: "asc" },
  });

  const [entriesByAgency, expensesByAgency] = await Promise.all([
    prisma.cashEntry.groupBy({
      by: ["agencyId"],
      where: { tenantId, type: "ENTRY", agencyId: { not: null } },
      _sum: { amount: true },
    }),
    prisma.cashEntry.groupBy({
      by: ["agencyId"],
      where: { tenantId, type: "EXPENSE", agencyId: { not: null } },
      _sum: { amount: true },
    }),
  ]);

  const entriesMap = new Map(entriesByAgency.map((entry) => [entry.agencyId, entry._sum.amount ?? 0]));
  const expensesMap = new Map(expensesByAgency.map((entry) => [entry.agencyId, entry._sum.amount ?? 0]));

  return agencies.map((agency) => {
    const entries = entriesMap.get(agency.id) ?? 0;
    const expenses = expensesMap.get(agency.id) ?? 0;
    return {
      agencyId: agency.id,
      agencyName: agency.name,
      startingBalance: agency.cashStartingBalance,
      entries,
      expenses,
      balance: agency.cashStartingBalance + entries - expenses,
      currency: register.currency,
    };
  });
}

/**
 * Sprint 22 : part des entrées/dépenses jamais attribuée à une agence (écritures manuelles
 * créées avant ce sprint, ou saisies sans agence choisie) — l'écart entre le solde global
 * (recomputeCashRegisterBalance) et la somme des soldes par agence ci-dessus vient
 * nécessairement de là, jamais d'une erreur de calcul (les deux dérivent des mêmes CashEntry).
 * Affiché tel quel plutôt que masqué, pour que l'écart reste explicable.
 */
export async function getUnattributedCashAmount(
  tenantId: string
): Promise<{ entries: number; expenses: number; currency: string }> {
  const register = await getOrCreateCashRegister(tenantId);
  const [entriesAgg, expensesAgg] = await Promise.all([
    prisma.cashEntry.aggregate({
      where: { tenantId, type: "ENTRY", agencyId: null },
      _sum: { amount: true },
    }),
    prisma.cashEntry.aggregate({
      where: { tenantId, type: "EXPENSE", agencyId: null },
      _sum: { amount: true },
    }),
  ]);

  return {
    entries: entriesAgg._sum.amount ?? 0,
    expenses: expensesAgg._sum.amount ?? 0,
    currency: register.currency,
  };
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
