import type { Damage, DamageInvoiceStatus, DamageStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Sprint 32 (DOMAINRULES.md section 32) — module dégâts. Sprint 33 (DOMAINRULES.md section 48) :
 * le paiement direct d'un dégât (sans facture séparée) a été retiré — `createDamagePayments` et
 * les erreurs qui lui étaient propres (`DamageHasNoBillableAmountError`,
 * `DamagePaymentExceedsBillableAmountError`, `InvalidDamagePaymentAmountError`) ont déplacé leur
 * rôle vers `src/lib/damage-invoices.ts` (`createDamageInvoice`/`createDamageInvoicePayments`),
 * seul point d'entrée désormais possible pour régler un dégât facturable. `Damage.status` n'est
 * plus dérivé directement des `Payment` (mécanisme provisoire du Sprint 32, `Payment.damageId`
 * retiré) mais de l'état de la `DamageInvoice` à laquelle ce dégât est rattaché, appliqué par
 * `applyDamageInvoiceStatus` ci-dessous — appelée depuis `src/lib/damage-invoices.ts`, jamais
 * réglée directement ici (même principe que `recomputeInvoiceStatus`, `src/lib/payments.ts`).
 */

export class DamageNotFoundError extends Error {
  constructor() {
    super("Dégât introuvable.");
    this.name = "DamageNotFoundError";
  }
}

export class InvalidDamageNatureError extends Error {
  constructor() {
    super("La nature du dégât est obligatoire.");
    this.name = "InvalidDamageNatureError";
  }
}

export class InvalidDamageAmountError extends Error {
  constructor() {
    super("Le montant facturable doit être un entier positif ou nul (plus petite unité monétaire).");
    this.name = "InvalidDamageAmountError";
  }
}

/** Risque résiduel B (HANDOFF.md, Phase 6.2) : `description` est reproduit tel quel dans la
 * facture de dégâts PDF (snapshot vers `DamageInvoiceLine.description`, voir
 * src/lib/damage-invoices.ts) — une valeur disproportionnée dégraderait ce rendu sans qu'aucune
 * limite serveur n'existe jusqu'ici (seule `MAX_AUTHENTICATED_JSON_BODY_BYTES` borne le corps de
 * la requête entière, pas ce champ précis). Refusée explicitement (400), jamais tronquée
 * silencieusement. */
export const MAX_DAMAGE_DESCRIPTION_LENGTH = 2000;

export class InvalidDamageDescriptionError extends Error {
  constructor() {
    super(`La description ne doit pas dépasser ${MAX_DAMAGE_DESCRIPTION_LENGTH} caractères.`);
    this.name = "InvalidDamageDescriptionError";
  }
}

function assertValidDamageDescription(description: string | null | undefined): void {
  if (description != null && description.length > MAX_DAMAGE_DESCRIPTION_LENGTH) {
    throw new InvalidDamageDescriptionError();
  }
}

/** Sprint 33 : un dégât déjà rattaché à une DamageInvoice (Damage.damageInvoiceId renseigné) ne
 * peut plus être corrigé — son contenu facturé est figé sur un snapshot immuable
 * (DamageInvoiceLine, voir prisma/schema.prisma), corriger le Damage vivant ensuite créerait une
 * divergence entre ce qui a été facturé et ce que la fiche affiche (double source de vérité). */
export class DamageNotEditableError extends Error {
  constructor() {
    super("Ce dégât est déjà facturé (DamageInvoice) : il ne peut plus être corrigé.");
    this.name = "DamageNotEditableError";
  }
}

/** Sprint 33 : un dégât ne peut jamais être facturé deux fois — vérifié sous verrou de ligne
 * (voir lockDamageForUpdate) avant toute création de DamageInvoice, jamais après coup. */
export class DamageAlreadyInvoicedError extends Error {
  constructor() {
    super("Ce dégât est déjà rattaché à une facture de dégâts.");
    this.name = "DamageAlreadyInvoicedError";
  }
}

/** Sprint 33 : seul un dégât avec un montant facturable strictement positif peut être facturé
 * (DamageInvoice) — un dégât consigné sans montant (assurance, information) n'a pas de solde. */
export class DamageNotBillableError extends Error {
  constructor() {
    super("Ce dégât n'a pas de montant facturable : aucune facture ne peut être générée.");
    this.name = "DamageNotBillableError";
  }
}

export async function getDamageById(
  tenantId: string,
  damageId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<Damage | null> {
  return tx.damage.findFirst({ where: { id: damageId, tenantId } });
}

export interface DamageFilters {
  vehicleId?: string;
  locationId?: string;
}

/** Historique des dégâts d'un véhicule (fiche véhicule, gated damages.view — écran non codé à
 * cette étape) ou d'un contrat. Jamais de suppression physique (voir le commentaire en tête de
 * fichier) : cette liste reste donc toujours complète, y compris les dégâts déjà facturés/payés. */
export async function getDamages(tenantId: string, filters: DamageFilters = {}): Promise<Damage[]> {
  return prisma.damage.findMany({
    where: {
      tenantId,
      ...(filters.vehicleId ? { vehicleId: filters.vehicleId } : {}),
      ...(filters.locationId ? { locationId: filters.locationId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
}

export interface CreateDamageInput {
  tenantId: string;
  vehicleId: string;
  locationId: string;
  createdByUserId: string;
  nature: string;
  description?: string;
  /** Montant facturable, en plus petite unité monétaire (centimes) — jamais un float
   * (DOMAINRULES.md section 14). Optionnel : un dégât peut être simplement consigné sans
   * montant (ex. pris en charge par une assurance/l'entreprise, ou évalué plus tard) — voir
   * DOMAINRULES.md section 48, un dégât non facturable ne génère jamais de DamageInvoice. */
  billableAmount?: number | null;
  /** Devise, dérivée par l'appelant de Location.currency (snapshot immuable, même principe que
   * Invoice.subtotal vis-à-vis de Location.totalPrice) — jamais devinée ici. */
  currency: string;
}

export async function createDamage(data: CreateDamageInput, tx: Prisma.TransactionClient = prisma): Promise<Damage> {
  if (!data.nature.trim()) {
    throw new InvalidDamageNatureError();
  }
  assertValidDamageDescription(data.description);
  if (
    data.billableAmount !== undefined &&
    data.billableAmount !== null &&
    (!Number.isInteger(data.billableAmount) || data.billableAmount < 0)
  ) {
    throw new InvalidDamageAmountError();
  }

  return tx.damage.create({
    data: {
      tenantId: data.tenantId,
      vehicleId: data.vehicleId,
      locationId: data.locationId,
      createdByUserId: data.createdByUserId,
      nature: data.nature,
      description: data.description,
      billableAmount: data.billableAmount ?? null,
      currency: data.currency,
    },
  });
}

export interface UpdateDamageInput {
  nature?: string;
  description?: string | null;
  billableAmount?: number | null;
}

/**
 * Sprint 33 (DOMAINRULES.md section 48, objectif 4 — jamais appliqué par aucune route au Sprint
 * 32, comblé ici) : corrige nature/description/billableAmount d'un dégât **tant qu'il n'a pas
 * encore été facturé** (`Damage.damageInvoiceId` doit être `null`) — au-delà, `DamageNotEditableError`
 * (409), quel que soit le statut de paiement de la facture. Jamais de suppression physique
 * (aucune fonction de suppression n'existe, cohérent avec le reste du module).
 */
export async function updateDamage(
  tenantId: string,
  damageId: string,
  data: UpdateDamageInput
): Promise<Damage | null> {
  const existing = await getDamageById(tenantId, damageId);
  if (!existing) {
    return null;
  }

  if (existing.damageInvoiceId) {
    throw new DamageNotEditableError();
  }

  if (data.nature !== undefined && !data.nature.trim()) {
    throw new InvalidDamageNatureError();
  }
  assertValidDamageDescription(data.description);
  if (
    data.billableAmount !== undefined &&
    data.billableAmount !== null &&
    (!Number.isInteger(data.billableAmount) || data.billableAmount < 0)
  ) {
    throw new InvalidDamageAmountError();
  }

  return prisma.damage.update({
    where: { id: damageId },
    data: {
      ...(data.nature !== undefined ? { nature: data.nature } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.billableAmount !== undefined ? { billableAmount: data.billableAmount } : {}),
    },
  });
}

/** Verrou de ligne (SELECT ... FOR UPDATE) posé avant toute décision dépendant de
 * `damageInvoiceId` (idempotence de facturation, voir src/lib/damage-invoices.ts) — nécessaire
 * pour qu'une double soumission concurrente ne puisse jamais facturer deux fois le même dégât en
 * lisant toutes les deux `damageInvoiceId: null` avant que l'une des deux n'écrive. Exporté
 * (contrairement au Sprint 32) : réutilisé par src/lib/damage-invoices.ts, seul autre module
 * autorisé à faire transiter un dégât vers l'état facturé. */
export async function lockDamageForUpdate(
  tenantId: string,
  damageId: string,
  tx: Prisma.TransactionClient
): Promise<Damage | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Damage" WHERE id = ${damageId} AND "tenantId" = ${tenantId} FOR UPDATE
  `;
  if (locked.length === 0) {
    return null;
  }
  return tx.damage.findFirst({ where: { id: damageId, tenantId } });
}

/** Sprint 33 : mappe le statut d'une DamageInvoice vers le DamageStatus de chacun des dégâts
 * qu'elle regroupe — appelée exclusivement depuis src/lib/damage-invoices.ts après tout
 * changement de statut de la DamageInvoice (création, paiement, annulation), jamais réglée à la
 * main. Un dégât non facturé (jamais passé par cette fonction) reste REPORTED par défaut. */
export function mapDamageInvoiceStatusToDamageStatus(invoiceStatus: DamageInvoiceStatus): DamageStatus {
  switch (invoiceStatus) {
    case "PAID":
      return "PAID";
    case "PARTIALLY_PAID":
      return "PARTIALLY_PAID";
    case "CANCELLED":
      return "CANCELLED";
    case "DRAFT":
    case "SENT":
    default:
      return "REPORTED";
  }
}

export async function applyDamageInvoiceStatus(
  damageIds: string[],
  invoiceStatus: DamageInvoiceStatus,
  tx: Prisma.TransactionClient
): Promise<void> {
  if (damageIds.length === 0) {
    return;
  }
  await tx.damage.updateMany({
    where: { id: { in: damageIds } },
    data: { status: mapDamageInvoiceStatusToDamageStatus(invoiceStatus) },
  });
}
