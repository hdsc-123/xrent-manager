import type { Damage, DamageInvoice, Payment, PaymentMethod, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getLocationById } from "@/lib/locations";
import { getClientById } from "@/lib/clients";
import { lockDamageForUpdate, applyDamageInvoiceStatus, DamageNotFoundError } from "@/lib/damages";
import { createCashEntry, createCorrectionCashEntry, CorrectionReasonRequiredError } from "@/lib/cash-register";

export { DamageNotFoundError, CorrectionReasonRequiredError };

/**
 * Sprint 33 (DOMAINRULES.md section 48) — facturation séparée des dégâts, remplace le paiement
 * direct du Sprint 32 (`src/lib/damages.ts`, `createDamagePayments`, retiré). Une `DamageInvoice`
 * est toujours créée directement au statut `SENT` (jamais de brouillon éditable — son contenu est
 * un snapshot immuable, voir `DamageInvoiceLine`) : c'est le seul chemin de création possible,
 * déclenché automatiquement soit au retour d'un contrat (`returnLocation`,
 * `src/lib/location-return.ts`, une facture par soumission de retour regroupant tous les dégâts
 * facturables saisis), soit à la déclaration d'un dégât facturable hors retour (`POST
 * /api/damages`, une facture à une seule ligne). `amountPaid`/`status` sont dérivés de la somme
 * réelle des `Payment` liés (`recomputeDamageInvoiceStatus`), jamais réglés directement — même
 * principe que `Invoice.amountPaid`/`status` vis-à-vis de `Payment`
 * (`recomputeInvoiceStatus`, `src/lib/payments.ts`). Solde/paiements strictement séparés du
 * solde/des paiements locatifs : `Payment.invoiceId`/`damageInvoiceId` sont mutuellement
 * exclusifs (contrainte CHECK en base, voir prisma/schema.prisma).
 */

export class DamageInvoiceNotFoundError extends Error {
  constructor() {
    super("Facture de dégâts introuvable.");
    this.name = "DamageInvoiceNotFoundError";
  }
}

/** Un dégât passé à createDamageInvoice doit appartenir au même contrat que celui de la facture
 * — jamais un dégât d'un autre contrat regroupé par erreur/malveillance (IDOR). */
export class DamageLocationMismatchError extends Error {
  constructor() {
    super("Ce dégât n'appartient pas au contrat de cette facture.");
    this.name = "DamageLocationMismatchError";
  }
}

export class DamageAlreadyInvoicedError extends Error {
  constructor() {
    super("Ce dégât est déjà rattaché à une facture de dégâts.");
    this.name = "DamageAlreadyInvoicedError";
  }
}

export class DamageNotBillableError extends Error {
  constructor() {
    super("Ce dégât n'a pas de montant facturable strictement positif : aucune facture ne peut être générée.");
    this.name = "DamageNotBillableError";
  }
}

export class NoDamagesToInvoiceError extends Error {
  constructor() {
    super("Aucun dégât facturable fourni : impossible de générer une facture de dégâts.");
    this.name = "NoDamagesToInvoiceError";
  }
}

export class InvalidDamageInvoicePaymentAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDamageInvoicePaymentAmountError";
  }
}

export class DamageInvoicePaymentExceedsBalanceError extends Error {
  remainingBalance: number;

  constructor(remainingBalance: number) {
    super(`Le montant dépasse le solde restant de la facture de dégâts (${remainingBalance}).`);
    this.name = "DamageInvoicePaymentExceedsBalanceError";
    this.remainingBalance = remainingBalance;
  }
}

export class DamageInvoiceCancelledError extends Error {
  constructor() {
    super("Cette facture de dégâts est annulée : aucun paiement ne peut plus y être encaissé.");
    this.name = "DamageInvoiceCancelledError";
  }
}

export class DamageInvoiceAlreadyCancelledError extends Error {
  constructor() {
    super("Cette facture de dégâts est déjà annulée.");
    this.name = "DamageInvoiceAlreadyCancelledError";
  }
}

/** Sprint 33 : même principe que LocationStatusConflictError/InvoiceAdminCancelConflictError —
 * déclenchée par l'`updateMany` conditionné (défense en profondeur) quand une autre requête a
 * déjà modifié la facture entre la lecture et la réclamation atomique. */
export class DamageInvoiceConflictError extends Error {
  constructor() {
    super("Cette facture de dégâts a déjà été modifiée par un autre utilisateur. Actualisez la page puis réessayez.");
    this.name = "DamageInvoiceConflictError";
  }
}

export interface DamagePaymentLine {
  method: PaymentMethod;
  amount: number;
}

export interface DamageInvoiceFilters {
  agencyIds?: string[] | null;
  locationId?: string;
  clientId?: string;
  status?: DamageInvoice["status"];
  from?: Date;
  to?: Date;
}

export async function getDamageInvoices(tenantId: string, filters: DamageInvoiceFilters = {}): Promise<DamageInvoice[]> {
  return prisma.damageInvoice.findMany({
    where: {
      tenantId,
      ...(filters.agencyIds ? { agencyId: { in: filters.agencyIds } } : {}),
      ...(filters.locationId ? { locationId: filters.locationId } : {}),
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.from ? { issuedAt: { gte: filters.from } } : {}),
      ...(filters.to ? { issuedAt: { lte: filters.to } } : {}),
    },
    orderBy: { issuedAt: "desc" },
  });
}

export async function getDamageInvoiceById(
  tenantId: string,
  damageInvoiceId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<DamageInvoice | null> {
  return tx.damageInvoice.findFirst({ where: { id: damageInvoiceId, tenantId } });
}

export interface DamageInvoiceWithDetails extends DamageInvoice {
  lines: Array<{ id: string; nature: string; description: string | null; billableAmount: number; currency: string }>;
  payments: Payment[];
}

export async function getDamageInvoiceWithDetails(
  tenantId: string,
  damageInvoiceId: string
): Promise<DamageInvoiceWithDetails | null> {
  const invoice = await prisma.damageInvoice.findFirst({
    where: { id: damageInvoiceId, tenantId },
    include: { lines: true, payments: { orderBy: { paidAt: "asc" } } },
  });
  return invoice;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/** Compteur simple par tenant, basé sur COUNT() (même principe que generateInvoiceNumber,
 * src/lib/invoices.ts) — pas de table de séquence dédiée, réessai en cas de collision. */
async function generateDamageInvoiceSequence(tenantId: string, tx: Prisma.TransactionClient): Promise<string> {
  const prefix = "FACT-DEG-";
  const count = await tx.damageInvoice.count({ where: { tenantId, number: { startsWith: prefix } } });
  return `${prefix}${String(count + 1).padStart(5, "0")}`;
}

/** Savepoints fixes (jamais construits depuis une valeur utilisateur) — même patron que
 * CONTRACT_NUMBER_SAVEPOINTS, src/lib/locations.ts. */
const DAMAGE_INVOICE_NUMBER_SAVEPOINTS = [
  "damage_invoice_number_sp_0",
  "damage_invoice_number_sp_1",
  "damage_invoice_number_sp_2",
  "damage_invoice_number_sp_3",
  "damage_invoice_number_sp_4",
] as const;
const MAX_NUMBER_ATTEMPTS = DAMAGE_INVOICE_NUMBER_SAVEPOINTS.length;

export interface CreateDamageInvoiceInput {
  tenantId: string;
  locationId: string;
  /** Dégâts à regrouper dans cette facture — tous doivent appartenir à `locationId`, ne pas
   * être déjà facturés, et avoir un `billableAmount` strictement positif. Une facture par
   * soumission de retour (plusieurs dégâts possibles) ou par déclaration hors retour (un seul). */
  damageIds: string[];
}

export interface CreateDamageInvoiceResult {
  invoice: DamageInvoice;
  damages: Damage[];
}

/**
 * Crée une DamageInvoice regroupant un ou plusieurs dégâts déjà déclarés et facturables — jamais
 * un dégât sans montant facturable, jamais un dégât déjà facturé (idempotence, vérifiée sous
 * verrou de ligne). `tx` optionnel : sans tx fournie, ouvre sa propre transaction ; avec une tx
 * fournie (returnLocation, src/lib/location-return.ts), la réutilise sans imbrication.
 */
export async function createDamageInvoice(
  data: CreateDamageInvoiceInput,
  tx: Prisma.TransactionClient = prisma
): Promise<CreateDamageInvoiceResult> {
  if (data.damageIds.length === 0) {
    throw new NoDamagesToInvoiceError();
  }

  if (tx !== prisma) {
    return createDamageInvoiceLocked(data, tx);
  }
  return prisma.$transaction((innerTx) => createDamageInvoiceLocked(data, innerTx));
}

async function createDamageInvoiceLocked(
  data: CreateDamageInvoiceInput,
  tx: Prisma.TransactionClient
): Promise<CreateDamageInvoiceResult> {
  const location = await getLocationById(data.tenantId, data.locationId, tx);
  if (!location) {
    throw new DamageLocationMismatchError();
  }

  const lockedDamages: Damage[] = [];
  for (const damageId of data.damageIds) {
    const damage = await lockDamageForUpdate(data.tenantId, damageId, tx);
    if (!damage) {
      throw new DamageNotFoundError();
    }
    if (damage.locationId !== data.locationId) {
      throw new DamageLocationMismatchError();
    }
    if (damage.damageInvoiceId) {
      throw new DamageAlreadyInvoicedError();
    }
    if (!damage.billableAmount || damage.billableAmount <= 0) {
      throw new DamageNotBillableError();
    }
    lockedDamages.push(damage);
  }

  const subtotal = lockedDamages.reduce((sum, damage) => sum + (damage.billableAmount ?? 0), 0);
  const contractNumber = location.contractNumber ?? `#${location.id.slice(-8)}`;

  for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
    const sequence = await generateDamageInvoiceSequence(data.tenantId, tx);
    const number = `${sequence}/${contractNumber}`;
    const savepoint = DAMAGE_INVOICE_NUMBER_SAVEPOINTS[attempt];
    await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
    try {
      const invoice = await tx.damageInvoice.create({
        data: {
          tenantId: data.tenantId,
          agencyId: location.agencyId,
          locationId: location.id,
          clientId: location.clientId,
          number,
          status: "SENT",
          subtotal,
          totalAmount: subtotal,
          amountPaid: 0,
          currency: location.currency,
          lines: {
            createMany: {
              data: lockedDamages.map((damage) => ({
                damageId: damage.id,
                nature: damage.nature,
                description: damage.description,
                billableAmount: damage.billableAmount as number,
                currency: damage.currency,
              })),
            },
          },
        },
      });

      await tx.damage.updateMany({
        where: { id: { in: lockedDamages.map((damage) => damage.id) } },
        data: { damageInvoiceId: invoice.id },
      });
      await applyDamageInvoiceStatus(
        lockedDamages.map((damage) => damage.id),
        "SENT",
        tx
      );

      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      const damages = await tx.damage.findMany({ where: { id: { in: lockedDamages.map((damage) => damage.id) } } });
      return { invoice, damages };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      if (attempt === MAX_NUMBER_ATTEMPTS - 1) {
        throw error;
      }
    }
  }

  throw new Error("Impossible de générer un numéro de facture de dégâts unique.");
}

/** Même primitive que lockInvoiceForUpdate (src/lib/payments.ts) — verrou de ligne posé avant
 * toute lecture du solde restant, contre le double encaissement concurrent. */
async function lockDamageInvoiceForUpdate(
  tenantId: string,
  damageInvoiceId: string,
  tx: Prisma.TransactionClient
): Promise<DamageInvoice | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "DamageInvoice" WHERE id = ${damageInvoiceId} AND "tenantId" = ${tenantId} FOR UPDATE
  `;
  if (locked.length === 0) {
    return null;
  }
  return getDamageInvoiceById(tenantId, damageInvoiceId, tx);
}

async function recomputeDamageInvoiceStatus(damageInvoiceId: string, tx: Prisma.TransactionClient): Promise<void> {
  const invoice = await tx.damageInvoice.findUniqueOrThrow({ where: { id: damageInvoiceId } });
  const aggregate = await tx.payment.aggregate({
    where: { damageInvoiceId, status: "ACTIVE" },
    _sum: { amount: true },
  });
  const amountPaid = aggregate._sum.amount ?? 0;

  const nextStatus =
    invoice.status === "CANCELLED"
      ? invoice.status
      : amountPaid >= invoice.totalAmount && invoice.totalAmount > 0
        ? "PAID"
        : amountPaid > 0
          ? "PARTIALLY_PAID"
          : "SENT";

  await tx.damageInvoice.update({ where: { id: damageInvoiceId }, data: { amountPaid, status: nextStatus } });

  const damages = await tx.damage.findMany({ where: { damageInvoiceId }, select: { id: true } });
  await applyDamageInvoiceStatus(
    damages.map((damage) => damage.id),
    nextStatus,
    tx
  );
}

/** Écriture de caisse d'un paiement de facture de dégâts — même principe que
 * recordPaymentCashEntry (src/lib/payments.ts), catégorie dédiée pour rester distinguable d'un
 * versement de solde locatif dans l'historique de caisse. */
async function recordDamageInvoicePaymentCashEntry(
  tenantId: string,
  invoice: DamageInvoice,
  payment: Payment,
  tx: Prisma.TransactionClient
): Promise<void> {
  const client = await getClientById(tenantId, invoice.clientId, tx);
  const location = await getLocationById(tenantId, invoice.locationId, tx);

  await createCashEntry(
    {
      tenantId,
      type: "ENTRY",
      category: "DEGATS",
      amount: payment.amount,
      description: `Paiement facture de dégâts ${invoice.number}`,
      contractId: invoice.locationId,
      contractNumber: location?.contractNumber ?? null,
      clientName: client?.name,
      paymentMethod: payment.method,
      agencyId: invoice.agencyId,
      paymentId: payment.id,
    },
    tx
  );
}

export interface CreateDamageInvoicePaymentsInput {
  tenantId: string;
  damageInvoiceId: string;
  lines: DamagePaymentLine[];
  paidAt?: Date;
  reference?: string;
  notes?: string;
}

/**
 * Encaisse un ou plusieurs paiements (espèces/carte/mixte) contre une DamageInvoice — verrouille
 * la facture, revalide son solde restant au moment de l'écriture, écrit chaque Payment
 * (damageInvoiceId renseigné, invoiceId toujours null), alimente la caisse pour chacun, puis
 * recalcule DamageInvoice.amountPaid/status et le DamageStatus de chaque dégât regroupé. `tx`
 * optionnel, même contrat que createDamageInvoice.
 */
export async function createDamageInvoicePayments(
  data: CreateDamageInvoicePaymentsInput,
  tx: Prisma.TransactionClient = prisma
): Promise<Payment[]> {
  if (data.lines.length === 0) {
    throw new InvalidDamageInvoicePaymentAmountError("Le paiement nécessite au moins une ligne.");
  }
  for (const line of data.lines) {
    if (!Number.isInteger(line.amount) || line.amount <= 0) {
      throw new InvalidDamageInvoicePaymentAmountError("Chaque montant doit être un entier positif.");
    }
  }

  if (tx !== prisma) {
    return createDamageInvoicePaymentsLocked(data, tx);
  }
  return prisma.$transaction((innerTx) => createDamageInvoicePaymentsLocked(data, innerTx));
}

async function createDamageInvoicePaymentsLocked(
  data: CreateDamageInvoicePaymentsInput,
  tx: Prisma.TransactionClient
): Promise<Payment[]> {
  const invoice = await lockDamageInvoiceForUpdate(data.tenantId, data.damageInvoiceId, tx);
  if (!invoice) {
    throw new DamageInvoiceNotFoundError();
  }
  if (invoice.status === "CANCELLED") {
    throw new DamageInvoiceCancelledError();
  }

  const remainingBalance = invoice.totalAmount - invoice.amountPaid;
  const linesTotal = data.lines.reduce((sum, line) => sum + line.amount, 0);
  if (linesTotal > remainingBalance) {
    throw new DamageInvoicePaymentExceedsBalanceError(remainingBalance);
  }

  const payments: Payment[] = [];
  for (const line of data.lines) {
    const payment = await tx.payment.create({
      data: {
        tenantId: data.tenantId,
        damageInvoiceId: invoice.id,
        amount: line.amount,
        currency: invoice.currency,
        method: line.method,
        paidAt: data.paidAt ?? new Date(),
        reference: data.reference,
        notes: data.notes,
      },
    });
    payments.push(payment);
    await recordDamageInvoicePaymentCashEntry(data.tenantId, invoice, payment, tx);
  }

  await recomputeDamageInvoiceStatus(invoice.id, tx);
  return payments;
}

export interface CancelDamageInvoiceOptions {
  reason: string;
  performedByUserId: string;
}

export interface CancelDamageInvoiceResult {
  invoice: DamageInvoice;
  reversedPaymentCount: number;
  reversedAmountTotal: number;
  refundedWithoutCashEntryCount: number;
  refunds: Array<{ paymentId: string; amount: number; method: PaymentMethod }>;
}

/**
 * Annulation d'une DamageInvoice (n'importe quel statut non déjà CANCELLED), avec réversibilité
 * financière complète — même principe qu'adminCancelInvoice (src/lib/invoices.ts) : chaque
 * Payment ACTIVE lié passe à REFUNDED (jamais réécrit/supprimé) et reçoit une CashEntry de
 * compensation liée à son écriture d'origine, jamais une réécriture d'historique. Concurrence :
 * verrou de ligne posé avant lecture d'éligibilité, puis `updateMany` conditionné comme
 * réclamation atomique — une seule annulation concurrente réussit.
 */
export async function cancelDamageInvoice(
  tenantId: string,
  damageInvoiceId: string,
  options: CancelDamageInvoiceOptions
): Promise<CancelDamageInvoiceResult | null> {
  if (!options.reason.trim()) {
    throw new CorrectionReasonRequiredError();
  }

  const existing = await getDamageInvoiceById(tenantId, damageInvoiceId);
  if (!existing) {
    return null;
  }
  if (existing.status === "CANCELLED") {
    throw new DamageInvoiceAlreadyCancelledError();
  }

  return prisma.$transaction(async (tx) => {
    const locked = await lockDamageInvoiceForUpdate(tenantId, damageInvoiceId, tx);
    if (!locked) {
      return null;
    }
    if (locked.status === "CANCELLED") {
      throw new DamageInvoiceAlreadyCancelledError();
    }

    const { count } = await tx.damageInvoice.updateMany({
      where: { id: damageInvoiceId, tenantId, status: { not: "CANCELLED" } },
      data: { status: "CANCELLED" },
    });
    if (count === 0) {
      throw new DamageInvoiceConflictError();
    }
    const invoice = await tx.damageInvoice.findUniqueOrThrow({ where: { id: damageInvoiceId } });

    const activePayments = await tx.payment.findMany({
      where: { damageInvoiceId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
    });

    let reversedPaymentCount = 0;
    let reversedAmountTotal = 0;
    let refundedWithoutCashEntryCount = 0;
    const refunds: CancelDamageInvoiceResult["refunds"] = [];

    for (const payment of activePayments) {
      const originalEntry = await tx.cashEntry.findFirst({ where: { paymentId: payment.id, parentEntryId: null } });

      if (!originalEntry) {
        await tx.payment.update({ where: { id: payment.id }, data: { status: "REFUNDED" } });
        refundedWithoutCashEntryCount += 1;
        refunds.push({ paymentId: payment.id, amount: payment.amount, method: payment.method });
        continue;
      }

      await createCorrectionCashEntry(
        {
          tenantId,
          parentEntryId: originalEntry.id,
          paymentId: payment.id,
          type: "EXPENSE",
          amount: payment.amount,
          paymentMethod: payment.method,
          category: "ANNULATION_FACTURE_DEGATS",
          description: `Annulation facture de dégâts ${invoice.number} — compensation du paiement du ${payment.paidAt.toISOString().slice(0, 10)}`,
          reason: options.reason.trim(),
          performedByUserId: options.performedByUserId,
          agencyId: invoice.agencyId,
          contractId: invoice.locationId,
        },
        tx
      );
      await tx.payment.update({ where: { id: payment.id }, data: { status: "REFUNDED" } });

      reversedPaymentCount += 1;
      reversedAmountTotal += payment.amount;
      refunds.push({ paymentId: payment.id, amount: payment.amount, method: payment.method });
    }

    const damages = await tx.damage.findMany({ where: { damageInvoiceId }, select: { id: true } });
    await applyDamageInvoiceStatus(
      damages.map((damage) => damage.id),
      "CANCELLED",
      tx
    );

    return { invoice, reversedPaymentCount, reversedAmountTotal, refundedWithoutCashEntryCount, refunds };
  });
}
