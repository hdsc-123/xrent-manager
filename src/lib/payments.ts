import type { Invoice, Payment, PaymentMethod, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getInvoiceById } from "@/lib/invoices";
import { getLocationById } from "@/lib/locations";
import { getClientById } from "@/lib/clients";
import { createCashEntry, createCorrectionCashEntry, CorrectionReasonRequiredError } from "@/lib/cash-register";
import { formatMoney } from "@/lib/format";

export { CorrectionReasonRequiredError };

export class PaymentInvoiceNotFoundError extends Error {
  constructor() {
    super("Facture introuvable.");
    this.name = "PaymentInvoiceNotFoundError";
  }
}

export class InvoiceCancelledError extends Error {
  constructor() {
    super("Impossible d'enregistrer un paiement sur une facture annulée.");
    this.name = "InvoiceCancelledError";
  }
}

/** Finding F : une facture DRAFT n'est pas encore finalisée (verrouillée, envoyée au
 * client) — un paiement ne peut être enregistré qu'à partir de SENT. Le paiement intégré à
 * la création d'un contrat/d'une location (processLocationPayment, src/lib/location-payment.ts)
 * finalise automatiquement la facture avant d'appeler createPayment ; en dehors de ce flux, une
 * finalisation manuelle (PATCH /api/invoices/[id], bouton « Finaliser ») est requise au
 * préalable. */
export class InvoiceNotFinalizedError extends Error {
  constructor() {
    super("Impossible d'enregistrer un paiement sur une facture non finalisée (DRAFT) — finalisez-la d'abord.");
    this.name = "InvoiceNotFinalizedError";
  }
}

export class InvalidPaymentAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPaymentAmountError";
  }
}

export class PaymentExceedsRemainingBalanceError extends Error {
  remainingBalance: number;

  /**
   * Message toujours exprimé dans la devise de la facture (jamais un entier brut de centimes)
   * — corrige un message technique incompréhensible pour un agent (Sprint 14B, voir
   * DOMAINRULES.md section 10).
   */
  constructor(remainingBalance: number, currency: string) {
    super(`Le montant dépasse le solde restant dû (${formatMoney(remainingBalance, currency)}).`);
    this.name = "PaymentExceedsRemainingBalanceError";
    this.remainingBalance = remainingBalance;
  }
}

/** Sprint 26D (Finding D1) : un Payment REFUNDED (remboursé via l'annulation admin d'un
 * contrat, adminCancelValidatedLocation) est terminal — ni correction ni nouveau
 * remboursement ne sont plus permis. */
export class PaymentAlreadyRefundedError extends Error {
  constructor() {
    super("Ce paiement a déjà été remboursé et ne peut plus être modifié.");
    this.name = "PaymentAlreadyRefundedError";
  }
}

/** Sprint 26D (Finding D1) : une correction de montant/moyen doit toujours s'appuyer sur
 * l'écriture de caisse d'origine (paymentId + parentEntryId null) pour créer sa
 * compensation liée — jamais une correspondance devinée par montant/date/moyen. Un
 * paiement antérieur au Sprint 18 (avant que createPayment n'alimente systématiquement
 * la caisse) peut ne jamais avoir eu de CashEntry : la correction est alors refusée
 * plutôt que de créer une compensation orpheline. */
export class PaymentCashEntryNotFoundError extends Error {
  constructor() {
    super(
      "Aucune écriture de caisse d'origine n'est liée à ce paiement — correction refusée " +
        "(pas de compensation possible sans écriture à compenser)."
    );
    this.name = "PaymentCashEntryNotFoundError";
  }
}

/** Sprint 26D (Finding D1) : un paiement déjà reflété en caisse (au moins une CashEntry,
 * originale ou compensation, liée par paymentId) ne peut plus être supprimé
 * physiquement — seul le flux de remboursement (annulation de contrat) permet de le
 * neutraliser, en le conservant et en le marquant REFUNDED. */
export class PaymentHasCashEntryError extends Error {
  constructor() {
    super(
      "Ce paiement est déjà reflété en caisse : suppression physique impossible. " +
        "Utilisez le remboursement via l'annulation du contrat."
    );
    this.name = "PaymentHasCashEntryError";
  }
}

/** Sprint 33 (DOMAINRULES.md section 48) : createPayment/updatePayment/createMixedPayments/
 * deletePayment ne traitent jamais que des paiements locatifs (Payment.invoiceId non nul) —
 * jamais un paiement de dégât (Payment.damageInvoiceId non nul, voir src/lib/damage-invoices.ts,
 * seul module habilité à les créer/corriger). Cette erreur ne devrait jamais se produire en usage
 * normal (les routes dédiées appellent toujours la bonne fonction) : défense en profondeur contre
 * un appel direct/un identifiant substitué (IDOR) qui viserait un paiement de dégât via une route
 * de paiement locatif générique. */
export class PaymentIsDamageInvoicePaymentError extends Error {
  constructor() {
    super("Ce paiement appartient à une facture de dégâts : utilisez les routes dédiées /api/damage-invoices.");
    this.name = "PaymentIsDamageInvoicePaymentError";
  }
}

/**
 * Recalcule amountPaid (somme des paiements) et status de la facture à partir des
 * paiements existants — jamais l'inverse. amountPaid n'est donc jamais incrémenté/
 * décrémenté directement : toujours recalculé pour éviter toute dérive (SECURITY.md
 * section 4, cohérence des montants financiers).
 */
/** `tx` optionnel (Sprint 26A, Finding A) — voir le commentaire équivalent sur
 * `getReservationById`, src/lib/reservations.ts. */
async function recomputeInvoiceStatus(invoiceId: string, tx: Prisma.TransactionClient = prisma): Promise<void> {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const aggregate = await tx.payment.aggregate({
    // Sprint 33 (DOMAINRULES.md section 48) : un paiement de dégât n'a plus jamais d'invoiceId
    // (Payment.invoiceId/damageInvoiceId sont mutuellement exclusifs, contrainte CHECK en base —
    // voir prisma/schema.prisma, remplace le mécanisme provisoire du Sprint 32 où un paiement de
    // dégât partageait l'invoiceId de la facture du contrat). `damageInvoiceId: null` est donc
    // redondant avec `invoiceId` mais conservé par défense en profondeur : jamais faire confiance
    // à une seule couche de validation pour un agrégat financier.
    where: { invoiceId, damageInvoiceId: null },
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
          : invoice.status === "PARTIALLY_PAID" || invoice.status === "PAID"
            ? "SENT"
            : invoice.status;

  await tx.invoice.update({
    where: { id: invoiceId },
    data: { amountPaid, status: nextStatus },
  });
}

/**
 * Sprint 26A, Finding B : verrou de ligne explicite (`SELECT ... FOR UPDATE`) sur l'Invoice
 * ciblée, posé avant toute lecture du solde restant — nécessaire car ni `updateMany`
 * conditionné (motif du Finding A, inadapté ici : on ne transite pas un statut, on valide un
 * montant contre une somme agrégée) ni contrainte SQL ne peuvent empêcher deux créations de
 * paiement concurrentes de lire le même `amountPaid` périmé avant d'écrire. Une deuxième
 * transaction concurrente sur la même facture attend ici le commit de la première, puis relit
 * un `amountPaid` à jour — jamais l'inverse. Requête paramétrée via template tag Prisma (aucune
 * concaténation de valeur utilisateur) ; ne doit être appelée que depuis une véritable
 * transaction (`Prisma.TransactionClient` issue de `prisma.$transaction`), jamais sur le client
 * global. La relecture après verrou passe par `getInvoiceById` (typée), pas par le résultat brut
 * du `$queryRaw`.
 */
async function lockInvoiceForUpdate(
  tenantId: string,
  invoiceId: string,
  tx: Prisma.TransactionClient
): Promise<Invoice | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Invoice" WHERE id = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE
  `;
  if (locked.length === 0) {
    return null;
  }
  return getInvoiceById(tenantId, invoiceId, tx);
}

export interface PaymentFilters {
  invoiceId?: string;
  method?: PaymentMethod;
  from?: Date;
  to?: Date;
}

/** Sprint 33 (DOMAINRULES.md section 48) : ce module (src/lib/payments.ts) ne traite jamais que
 * des paiements locatifs — `invoiceId: { not: null }` exclut structurellement tout paiement de
 * dégât (Payment.damageInvoiceId non nul, invoiceId toujours null dans ce cas), même sans filtre
 * `invoiceId` explicite fourni par l'appelant. Un paiement de dégât se consulte exclusivement via
 * src/lib/damage-invoices.ts (getDamageInvoiceWithDetails). */
export async function getPayments(tenantId: string, filters: PaymentFilters = {}): Promise<Payment[]> {
  return prisma.payment.findMany({
    where: {
      tenantId,
      invoiceId: { not: null },
      ...(filters.invoiceId ? { invoiceId: filters.invoiceId } : {}),
      ...(filters.method ? { method: filters.method } : {}),
      ...(filters.from ? { paidAt: { gte: filters.from } } : {}),
      ...(filters.to ? { paidAt: { lte: filters.to } } : {}),
    },
    orderBy: { paidAt: "desc" },
  });
}

export async function getPaymentById(tenantId: string, paymentId: string): Promise<Payment | null> {
  return prisma.payment.findFirst({ where: { id: paymentId, tenantId } });
}

export interface CreatePaymentInput {
  tenantId: string;
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  paidAt?: Date;
  reference?: string;
  notes?: string;
}

/**
 * currency n'est jamais fourni par le client : toujours dérivée de l'Invoice ciblée,
 * pour empêcher tout paiement enregistré dans une devise incohérente avec la facture.
 *
 * `tx` optionnel (Sprint 26A, Finding A) — défaut au client Prisma global, comportement
 * inchangé pour tout appel sans transaction partagée (POST /api/payments, etc.).
 *
 * Sprint 26A, Finding B : sans `tx` fournie, ouvre désormais sa propre transaction interne
 * (au lieu d'exécuter chaque étape en autocommit séparé) pour verrouiller l'Invoice avant de
 * valider le solde restant (voir `lockInvoiceForUpdate` ci-dessus) — deux créations concurrentes
 * sur la même facture ne peuvent plus toutes deux passer la validation contre une lecture
 * périmée. Avec une `tx` fournie par l'appelant (ex. `processLocationPayment` dans la
 * transaction du Finding A), aucune transaction n'est ouverte ici : le verrou est posé dans la
 * transaction de l'appelant, sans imbrication.
 */
export async function createPayment(
  data: CreatePaymentInput,
  tx: Prisma.TransactionClient = prisma
): Promise<Payment> {
  if (!Number.isInteger(data.amount) || data.amount <= 0) {
    throw new InvalidPaymentAmountError("amount doit être un entier positif (plus petite unité monétaire).");
  }

  if (tx !== prisma) {
    return createPaymentLocked(data, tx);
  }
  return prisma.$transaction((innerTx) => createPaymentLocked(data, innerTx));
}

async function createPaymentLocked(data: CreatePaymentInput, tx: Prisma.TransactionClient): Promise<Payment> {
  const invoice = await lockInvoiceForUpdate(data.tenantId, data.invoiceId, tx);
  if (!invoice) {
    throw new PaymentInvoiceNotFoundError();
  }

  if (invoice.status === "CANCELLED") {
    throw new InvoiceCancelledError();
  }
  if (invoice.status === "DRAFT") {
    throw new InvoiceNotFinalizedError();
  }

  const remainingBalance = invoice.totalAmount - invoice.amountPaid;
  if (data.amount > remainingBalance) {
    throw new PaymentExceedsRemainingBalanceError(remainingBalance, invoice.currency);
  }

  const payment = await tx.payment.create({
    data: {
      tenantId: data.tenantId,
      invoiceId: data.invoiceId,
      amount: data.amount,
      currency: invoice.currency,
      method: data.method,
      paidAt: data.paidAt ?? new Date(),
      reference: data.reference,
      notes: data.notes,
    },
  });

  await recomputeInvoiceStatus(data.invoiceId, tx);
  await recordPaymentCashEntry(data.tenantId, invoice.locationId, payment, tx);
  return payment;
}

/**
 * Toute écriture de paiement encaissée doit se refléter en caisse — corrige un bug réel
 * (Sprint 18, pilote terrain) : seul le paiement intégré à la création d'une location
 * (processLocationPayment) alimentait la caisse ; un paiement enregistré plus tard depuis la
 * fiche facture (createPayment/createMixedPayments, POST /api/payments) n'y apparaissait
 * jamais, alors que c'est le flux normal documenté (paiement « au retour » réglé après coup).
 * Centralisé ici (plutôt que dupliqué par chaque appelant) pour que tout paiement, quel que
 * soit son point d'entrée, ait la même garantie.
 *
 * `tx` optionnel (Sprint 26A, Finding A) — voir le commentaire équivalent sur `createPayment`.
 */
async function recordPaymentCashEntry(
  tenantId: string,
  locationId: string,
  payment: Payment,
  tx: Prisma.TransactionClient = prisma
): Promise<void> {
  const location = await getLocationById(tenantId, locationId, tx);
  const contractNumber = location?.contractNumber ?? null;
  const clientName = location ? (await getClientById(tenantId, location.clientId, tx))?.name : undefined;

  await createCashEntry(
    {
      tenantId,
      type: "ENTRY",
      category: "VERSEMENT",
      amount: payment.amount,
      description: `Paiement location ${contractNumber ?? `#${locationId.slice(-8)}`}`,
      contractId: locationId,
      contractNumber,
      clientName,
      paymentMethod: payment.method,
      // Sprint 22 : agence d'origine de l'écriture, dérivée de la Location réglée — permet de
      // calculer un solde/CA par agence en plus du solde global (voir src/lib/cash-register.ts).
      agencyId: location?.agencyId,
      // Sprint 26D (Finding D1) : lien fiable vers ce Payment — condition nécessaire pour
      // qu'une future correction/un futur remboursement retrouve cette écriture sans jamais
      // deviner par montant/date/moyen (voir updatePaymentLocked/adminCancelValidatedLocation).
      paymentId: payment.id,
    },
    tx
  );
}

export interface UpdatePaymentInput {
  amount?: number;
  method?: PaymentMethod;
  paidAt?: Date;
  reference?: string;
  notes?: string;
  /** Sprint 26D (Finding D1) : obligatoire dès que amount/method/paidAt change réellement
   * (par rapport à la valeur actuelle) — jamais requis pour un simple changement de
   * reference/notes. */
  reason?: string;
  /** Sprint 26D (Finding D1) : agent à l'origine de la correction — toujours fourni par la
   * route authentifiée (user.id), utilisé uniquement quand une compensation est créée. */
  performedByUserId?: string;
}

/**
 * `tx` optionnel (Sprint 26A, Finding B) — même contrat que `createPayment` : sans `tx`
 * fournie, ouvre une transaction interne ; avec une `tx` fournie par l'appelant, la réutilise
 * sans imbrication. Le verrou (`lockInvoiceForUpdate`) n'est posé que si `amount` est modifié
 * (seul cas où le solde restant est recalculé) — un changement de méthode/date/référence/notes
 * seul ne verrouille rien de plus.
 *
 * Sprint 26D (Finding D1) : toute correction qui change réellement amount/method/paidAt exige
 * désormais un motif (`reason`) — refusé sinon (`CorrectionReasonRequiredError`). Un changement
 * de amount et/ou method crée une CashEntry de compensation liée à l'écriture d'origine
 * (jamais une modification/suppression de celle-ci, voir createCorrectionCashEntry,
 * src/lib/cash-register.ts) : un delta unique si seul amount change, une paire sortie/entrée
 * si method change (avec ou sans changement de amount simultané, jamais un delta mélangeant
 * deux moyens). Un changement de paidAt seul ne crée aucune CashEntry (rien à compenser
 * financièrement) — uniquement journalisé côté route (ancien/nouveau paidAt), voir
 * PATCH /api/payments/[id]/route.ts. Un Payment REFUNDED (remboursé via l'annulation de
 * contrat) ne peut plus être corrigé (`PaymentAlreadyRefundedError`).
 */
export async function updatePayment(
  tenantId: string,
  paymentId: string,
  data: UpdatePaymentInput,
  tx: Prisma.TransactionClient = prisma
): Promise<Payment | null> {
  if (tx !== prisma) {
    return updatePaymentLocked(tenantId, paymentId, data, tx);
  }
  return prisma.$transaction((innerTx) => updatePaymentLocked(tenantId, paymentId, data, innerTx));
}

async function updatePaymentLocked(
  tenantId: string,
  paymentId: string,
  data: UpdatePaymentInput,
  tx: Prisma.TransactionClient
): Promise<Payment | null> {
  let existing = await tx.payment.findFirst({ where: { id: paymentId, tenantId } });
  if (!existing) {
    return null;
  }

  if (existing.damageInvoiceId) {
    throw new PaymentIsDamageInvoicePaymentError();
  }
  // Narrowing explicite (Sprint 33) : garanti non nul ici par la contrainte CHECK d'exclusivité
  // (Payment.invoiceId/damageInvoiceId, voir prisma/schema.prisma) puisque damageInvoiceId vient
  // d'être vérifié null — revérifié quand même au runtime plutôt que d'utiliser une assertion `!`
  // muette, cohérent avec le principe de ne jamais faire confiance à une seule couche.
  const rentalInvoiceId = existing.invoiceId;
  if (!rentalInvoiceId) {
    throw new PaymentIsDamageInvoicePaymentError();
  }

  if (existing.status === "REFUNDED") {
    throw new PaymentAlreadyRefundedError();
  }

  // Évaluation préliminaire (lecture non verrouillée) — suffisante pour savoir si un motif
  // est exigé, mais jamais pour calculer la compensation elle-même (voir la relecture
  // verrouillée ci-dessous).
  const isCorrection =
    (data.amount !== undefined && data.amount !== existing.amount) ||
    (data.method !== undefined && data.method !== existing.method) ||
    (data.paidAt !== undefined && data.paidAt.getTime() !== existing.paidAt.getTime());

  if (isCorrection && (!data.reason?.trim() || !data.performedByUserId)) {
    throw new CorrectionReasonRequiredError();
  }

  let invoice: Invoice | null = null;
  if (isCorrection) {
    // Sprint 26D (Finding D1) : toute correction (montant, moyen ou date — pas seulement le
    // montant comme pour le Finding B) verrouille désormais l'Invoice, même point de
    // sérialisation déjà utilisé par createPayment/createMixedPayments. Nécessaire ici au-delà
    // du seul Finding B : deux PATCH concurrents sur le *même* Payment doivent être sérialisés
    // pour que la relecture ci-dessous (existing) soit garantie à jour au moment du calcul de
    // la compensation — une lecture non verrouillée pourrait sinon rester périmée si un premier
    // PATCH concurrent committait entre cette lecture initiale et l'écriture finale.
    invoice = await lockInvoiceForUpdate(tenantId, rentalInvoiceId, tx);
    if (!invoice) {
      throw new PaymentInvoiceNotFoundError();
    }

    const refreshed = await tx.payment.findFirst({ where: { id: paymentId, tenantId } });
    if (!refreshed) {
      throw new PaymentInvoiceNotFoundError();
    }
    if (refreshed.status === "REFUNDED") {
      throw new PaymentAlreadyRefundedError();
    }
    existing = refreshed;
  }

  const amountChanging = data.amount !== undefined && data.amount !== existing.amount;
  const methodChanging = data.method !== undefined && data.method !== existing.method;

  if (amountChanging) {
    if (!Number.isInteger(data.amount) || (data.amount as number) <= 0) {
      throw new InvalidPaymentAmountError("amount doit être un entier positif (plus petite unité monétaire).");
    }

    // `invoice` est garanti non nul ici : amountChanging ne peut être vrai que si isCorrection
    // l'était déjà à la relecture, qui a déjà posé le verrou ci-dessus.
    // Solde restant en excluant ce paiement lui-même, pour permettre d'ajuster son propre montant.
    const remainingExcludingThis = invoice!.totalAmount - (invoice!.amountPaid - existing.amount);
    if ((data.amount as number) > remainingExcludingThis) {
      throw new PaymentExceedsRemainingBalanceError(remainingExcludingThis, invoice!.currency);
    }
  }

  // Toute correction affectant amount/method doit pouvoir s'appuyer sur l'écriture de caisse
  // d'origine de ce Payment — validé avant la moindre écriture (jamais de compensation
  // orpheline, jamais de correspondance devinée par montant/date/moyen, Finding D1).
  let originalEntry: Awaited<ReturnType<typeof tx.cashEntry.findFirst>> = null;
  if (amountChanging || methodChanging) {
    originalEntry = await tx.cashEntry.findFirst({ where: { paymentId: existing.id, parentEntryId: null } });
    if (!originalEntry) {
      throw new PaymentCashEntryNotFoundError();
    }
  }

  const updated = await tx.payment.update({
    where: { id: paymentId },
    data: {
      ...(data.amount !== undefined ? { amount: data.amount } : {}),
      ...(data.method ? { method: data.method } : {}),
      ...(data.paidAt ? { paidAt: data.paidAt } : {}),
      ...(data.reference !== undefined ? { reference: data.reference } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
    },
  });

  if (originalEntry) {
    const newAmount = data.amount ?? existing.amount;
    const newMethod = data.method ?? existing.method;
    const reason = data.reason!.trim();
    const performedByUserId = data.performedByUserId!;
    const sharedCorrectionFields = {
      tenantId,
      parentEntryId: originalEntry.id,
      paymentId: existing.id,
      category: "CORRECTION_PAIEMENT",
      reason,
      performedByUserId,
      agencyId: originalEntry.agencyId ?? undefined,
      contractId: originalEntry.contractId ?? undefined,
      contractNumber: originalEntry.contractNumber,
      clientName: originalEntry.clientName ?? undefined,
    };

    if (methodChanging) {
      // Changement de moyen (avec ou sans changement de montant simultané) : toujours une
      // paire sortie complète de l'ancien moyen / entrée complète du nouveau moyen — jamais
      // un delta unique, pour ne jamais mélanger deux moyens dans une même ligne et pour que
      // la ventilation CASH/CARD (monthCash/monthCard) reste exacte.
      await createCorrectionCashEntry(
        {
          ...sharedCorrectionFields,
          type: "EXPENSE",
          amount: existing.amount,
          paymentMethod: existing.method,
          description: `Correction paiement — réallocation hors ${existing.method}`,
        },
        tx
      );
      await createCorrectionCashEntry(
        {
          ...sharedCorrectionFields,
          type: "ENTRY",
          amount: newAmount,
          paymentMethod: newMethod,
          description: `Correction paiement — réallocation vers ${newMethod}`,
        },
        tx
      );
    } else {
      // Moyen inchangé, seul le montant change : un delta unique.
      const delta = newAmount - existing.amount;
      await createCorrectionCashEntry(
        {
          ...sharedCorrectionFields,
          type: delta > 0 ? "ENTRY" : "EXPENSE",
          amount: Math.abs(delta),
          paymentMethod: newMethod,
          description:
            `Correction du montant du paiement (${formatMoney(existing.amount, existing.currency)} → ` +
            `${formatMoney(newAmount, existing.currency)})`,
        },
        tx
      );
    }
  }

  if (amountChanging) {
    await recomputeInvoiceStatus(rentalInvoiceId, tx);
  }

  return updated;
}

export interface MixedPaymentLine {
  amount: number;
  method: PaymentMethod;
}

export interface CreateMixedPaymentsInput {
  tenantId: string;
  invoiceId: string;
  lines: MixedPaymentLine[];
  paidAt?: Date;
  reference?: string;
  notes?: string;
}

/**
 * Paiement mixte (plusieurs lignes méthode+montant) depuis la fiche facture existante
 * (`InvoiceActions.tsx`) — même garantie que `processLocationPayment`
 * (src/lib/location-payment.ts, Sprint 14B) : le total des lignes est validé contre le solde
 * restant *relu au moment de l'appel* avant d'écrire quoi que ce soit, pour ne jamais laisser
 * un paiement partiel orphelin si le solde a changé depuis l'ouverture du formulaire (Sprint 17
 * — jusqu'ici `InvoiceActions.tsx` revalidait côté client contre un solde figé au chargement de
 * la page, puis postait chaque ligne séparément : une baisse du solde réel entre l'ouverture du
 * dialogue et la soumission pouvait laisser la première ligne écrite avant que la seconde échoue).
 *
 * `tx` optionnel (Sprint 26A, Finding B) — même contrat que `createPayment`/`updatePayment` :
 * sans `tx` fournie, ouvre une seule transaction interne pour toutes les lignes (jamais une par
 * ligne) ; avec une `tx` fournie, la réutilise. Le verrou (`lockInvoiceForUpdate`) n'est posé
 * qu'une fois, avant la validation globale du total — chaque `createPayment` interne (une par
 * ligne, ci-dessous) reçoit ensuite cette même `tx` et réutilise donc le même verrou (déjà tenu
 * par cette transaction : une réacquisition `FOR UPDATE` sur une ligne déjà verrouillée par la
 * transaction courante est un no-op côté Postgres, jamais un blocage). La validation par ligne de
 * `createPayment` reste inchangée et ne fait que confirmer, ligne après ligne, ce que la
 * validation globale ci-dessous a déjà garanti pour le total.
 */
export async function createMixedPayments(
  data: CreateMixedPaymentsInput,
  tx: Prisma.TransactionClient = prisma
): Promise<Payment[]> {
  if (data.lines.length === 0) {
    throw new InvalidPaymentAmountError("Le paiement mixte nécessite au moins une ligne.");
  }
  for (const line of data.lines) {
    if (!Number.isInteger(line.amount) || line.amount <= 0) {
      throw new InvalidPaymentAmountError("Chaque montant du paiement mixte doit être un entier positif.");
    }
  }

  if (tx !== prisma) {
    return createMixedPaymentsLocked(data, tx);
  }
  return prisma.$transaction((innerTx) => createMixedPaymentsLocked(data, innerTx));
}

async function createMixedPaymentsLocked(
  data: CreateMixedPaymentsInput,
  tx: Prisma.TransactionClient
): Promise<Payment[]> {
  const invoice = await lockInvoiceForUpdate(data.tenantId, data.invoiceId, tx);
  if (!invoice) {
    throw new PaymentInvoiceNotFoundError();
  }
  if (invoice.status === "CANCELLED") {
    throw new InvoiceCancelledError();
  }
  if (invoice.status === "DRAFT") {
    throw new InvoiceNotFinalizedError();
  }

  const remainingBalance = invoice.totalAmount - invoice.amountPaid;
  const linesTotal = data.lines.reduce((sum, line) => sum + line.amount, 0);
  if (linesTotal > remainingBalance) {
    throw new PaymentExceedsRemainingBalanceError(remainingBalance, invoice.currency);
  }

  const payments: Payment[] = [];
  for (const line of data.lines) {
    payments.push(
      await createPayment(
        {
          tenantId: data.tenantId,
          invoiceId: data.invoiceId,
          amount: line.amount,
          method: line.method,
          paidAt: data.paidAt,
          reference: data.reference,
          notes: data.notes,
        },
        tx
      )
    );
  }
  return payments;
}

/**
 * Sprint 26D (Finding D1) : suppression physique désormais réservée aux paiements
 * jamais reflétés en caisse (aucune CashEntry — originale ou compensation — liée par
 * `paymentId`) ; cas résiduel/défensif, la quasi-totalité des paiements en ont une
 * depuis le Sprint 18 (recordPaymentCashEntry, systématique dans createPayment). Dès
 * qu'une CashEntry existe, la suppression physique est refusée
 * (`PaymentHasCashEntryError`, 409) — le paiement encaissé doit passer par le flux de
 * remboursement (annulation de contrat, voir adminCancelValidatedLocation), qui le
 * conserve et le marque REFUNDED plutôt que de le supprimer.
 *
 * `tx` optionnel, même contrat que `createPayment`/`updatePayment` — sans `tx` fournie,
 * ouvre sa propre transaction ; avec une `tx` fournie, la réutilise sans imbrication.
 */
export async function deletePayment(
  tenantId: string,
  paymentId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<boolean> {
  if (tx !== prisma) {
    return deletePaymentLocked(tenantId, paymentId, tx);
  }
  return prisma.$transaction((innerTx) => deletePaymentLocked(tenantId, paymentId, innerTx));
}

async function deletePaymentLocked(
  tenantId: string,
  paymentId: string,
  tx: Prisma.TransactionClient
): Promise<boolean> {
  const existing = await tx.payment.findFirst({ where: { id: paymentId, tenantId } });
  if (!existing) {
    return false;
  }

  if (existing.damageInvoiceId) {
    throw new PaymentIsDamageInvoicePaymentError();
  }
  const rentalInvoiceId = existing.invoiceId;
  if (!rentalInvoiceId) {
    throw new PaymentIsDamageInvoicePaymentError();
  }

  const linkedEntry = await tx.cashEntry.findFirst({ where: { paymentId: existing.id } });
  if (linkedEntry) {
    throw new PaymentHasCashEntryError();
  }

  await tx.payment.delete({ where: { id: paymentId } });
  await recomputeInvoiceStatus(rentalInvoiceId, tx);
  return true;
}
