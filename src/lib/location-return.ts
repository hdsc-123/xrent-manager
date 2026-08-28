import type { Damage, DamageInvoice, Location, Payment, PaymentMethod, Prisma, Vehicle } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lockVehicleForUpdate } from "@/lib/vehicles";
import { syncVehicleStatus } from "@/lib/vehicle-status";
import { updateInvoice } from "@/lib/invoices";
import {
  createPayment,
  createMixedPayments,
  PaymentInvoiceNotFoundError,
  InvoiceCancelledError,
  InvoiceNotFinalizedError,
  InvalidPaymentAmountError,
  PaymentExceedsRemainingBalanceError,
} from "@/lib/payments";
import { createDamage, InvalidDamageAmountError, InvalidDamageNatureError } from "@/lib/damages";
import {
  createDamageInvoice,
  createDamageInvoicePayments,
  DamageNotFoundError,
  DamageLocationMismatchError,
  DamageAlreadyInvoicedError,
  DamageNotBillableError,
  NoDamagesToInvoiceError,
  DamageInvoiceNotFoundError,
  DamageInvoiceCancelledError,
  InvalidDamageInvoicePaymentAmountError,
  DamageInvoicePaymentExceedsBalanceError,
  type DamagePaymentLine,
} from "@/lib/damage-invoices";

export {
  PaymentInvoiceNotFoundError,
  InvoiceCancelledError,
  InvoiceNotFinalizedError,
  InvalidPaymentAmountError,
  PaymentExceedsRemainingBalanceError,
  DamageNotFoundError,
  DamageLocationMismatchError,
  DamageAlreadyInvoicedError,
  DamageNotBillableError,
  NoDamagesToInvoiceError,
  DamageInvoiceNotFoundError,
  DamageInvoiceCancelledError,
  InvalidDamageInvoicePaymentAmountError,
  DamageInvoicePaymentExceedsBalanceError,
  InvalidDamageAmountError,
  InvalidDamageNatureError,
};

/**
 * Sprint 32 (DOMAINRULES.md section 32) — orchestration transactionnelle unique de la clôture
 * d'un contrat par son retour : verrouillage Location + Vehicle, validations kilométrage/
 * carburant, date/heure réelle, encaissement du solde éventuel, dégâts, puis (seulement en cas
 * de succès complet) passage du véhicule à AVAILABLE. N'est jamais orchestré via updateLocation
 * (src/lib/locations.ts, non modifiée ce sprint) : le retour a ses propres garanties
 * transactionnelles, plus larges qu'une simple transition de statut (paiements + dégâts dans la
 * même unité atomique), et sa propre route dédiée (POST /api/locations/[id]/return).
 *
 * Sprint 33 (DOMAINRULES.md section 48) : le paiement direct d'un dégât (sans facture) est
 * retiré — tout dégât facturable saisi au retour génère automatiquement, dans la même
 * transaction, une DamageInvoice unique regroupant tous les dégâts facturables de cette
 * soumission (createDamageInvoice, src/lib/damage-invoices.ts) ; son solde éventuel s'encaisse
 * via un unique paiement optionnel (damageInvoicePaymentLines), strictement séparé du solde
 * locatif (paymentLines) — jamais un paiement par dégât individuel.
 */

export class LocationReturnNotFoundError extends Error {
  constructor() {
    super("Contrat introuvable.");
    this.name = "LocationReturnNotFoundError";
  }
}

/** Seul ACTIVE → COMPLETED est un retour valide — un contrat PENDING/CONFIRMED n'a jamais
 * commencé, un contrat déjà COMPLETED/CANCELLED a déjà été clôturé (couvre aussi bien un vrai
 * refus métier qu'un double retour concurrent, voir LocationReturnConflictError ci-dessous pour
 * la distinction). */
export class LocationNotActiveForReturnError extends Error {
  constructor() {
    super("Seul un contrat en cours (ACTIVE) peut faire l'objet d'un retour.");
    this.name = "LocationNotActiveForReturnError";
  }
}

/** Déclenchée uniquement par l'updateMany conditionné (défense en profondeur) — en pratique,
 * le verrou de ligne posé en tout début de transaction (lockLocationForReturn) intercepte déjà
 * un double retour concurrent via LocationNotActiveForReturnError avant d'y arriver : la
 * deuxième requête, bloquée sur le verrou, ne relit le statut (déjà COMPLETED) qu'après le
 * commit de la première. */
export class LocationReturnConflictError extends Error {
  constructor() {
    super("Ce contrat a déjà été modifié par un autre retour. Actualisez la page puis réessayez.");
    this.name = "LocationReturnConflictError";
  }
}

export class MissingReturnOdometerError extends Error {
  constructor() {
    super("Le kilométrage de retour est obligatoire.");
    this.name = "MissingReturnOdometerError";
  }
}

export class InvalidReturnOdometerError extends Error {
  constructor() {
    super("Le kilométrage de retour doit être un entier strictement supérieur au kilométrage de départ.");
    this.name = "InvalidReturnOdometerError";
  }
}

export class MissingReturnFuelLevelError extends Error {
  constructor() {
    super("Le niveau de carburant de retour est obligatoire.");
    this.name = "MissingReturnFuelLevelError";
  }
}

export class InvalidReturnFuelLevelError extends Error {
  constructor() {
    super("Le niveau de carburant de retour doit être un entier entre 0 et 100 (pourcentage).");
    this.name = "InvalidReturnFuelLevelError";
  }
}

/** Levée aussi bien pour une date invalide que pour une date incohérente (antérieure au départ
 * du contrat, ou postérieure à l'heure serveur actuelle) — un retour ne peut pas être daté dans
 * le futur ni avant que le contrat n'ait commencé. */
export class InvalidReturnTimeError extends Error {
  constructor() {
    super(
      "La date/heure de retour doit être postérieure ou égale à la date de départ du contrat, et ne peut jamais être postérieure à l'heure actuelle."
    );
    this.name = "InvalidReturnTimeError";
  }
}

/** Ne devrait jamais se produire en usage normal (une Invoice est toujours créée avec la
 * Location, voir createLocation/src/lib/locations.ts) — défensif. */
export class LocationHasNoInvoiceError extends Error {
  constructor() {
    super("Aucune facture n'est associée à ce contrat : impossible d'encaisser un paiement.");
    this.name = "LocationHasNoInvoiceError";
  }
}

export class VehicleNotFoundForReturnError extends Error {
  constructor() {
    super("Véhicule introuvable pour ce contrat.");
    this.name = "VehicleNotFoundForReturnError";
  }
}

export interface ReturnDamageInput {
  nature: string;
  description?: string;
  billableAmount?: number | null;
}

export interface ReturnLocationInput {
  tenantId: string;
  userId: string;
  locationId: string;
  /** number | null | undefined plutôt que number : permet de représenter fidèlement un champ
   * absent du corps de requête (le serveur doit refaire toutes les validations, jamais
   * supposer un type déjà correct côté client). */
  endOdometer: number | null | undefined;
  endFuelLevel: number | null | undefined;
  /** Valeur soumise par le client, honorée uniquement si canOverrideReturnTime === true — sinon
   * toujours ignorée au profit de l'heure serveur (voir resolveActualReturnAt ci-dessous).
   * Jamais un simple indicateur d'interface : c'est cette fonction qui applique la règle, pas
   * seulement la route appelante. */
  actualReturnAt?: Date;
  /** Dérivé côté route de can(user, "locations.return_time.edit") — jamais un champ de corps de
   * requête, même principe que Location.adminOverride (src/lib/locations.ts). */
  canOverrideReturnTime: boolean;
  /** Solde locatif encaissé au retour — une ligne (espèces OU carte) ou plusieurs (mixte).
   * Absent/vide = aucun encaissement à ce stade (payé plus tard depuis la fiche facture). */
  paymentLines?: MixedPaymentLineInput[];
  damages?: ReturnDamageInput[];
  /** Sprint 33 — solde de la DamageInvoice générée automatiquement pour l'ensemble des dégâts
   * facturables de cette soumission (une seule facture, jamais un paiement par dégât). Ignoré
   * si aucun dégât facturable n'est présent dans `damages`. */
  damageInvoicePaymentLines?: MixedPaymentLineInput[];
}

export interface MixedPaymentLineInput {
  method: PaymentMethod;
  amount: number;
}

export interface ReturnLocationResult {
  location: Location;
  vehicle: Vehicle;
  payments: Payment[];
  damages: Damage[];
  damageInvoice: DamageInvoice | null;
  damagePayments: Payment[];
  /** true uniquement si canOverrideReturnTime était vrai ET qu'une valeur différente de l'heure
   * serveur a réellement été appliquée — pour que l'appelant (route) n'audite le contournement
   * que lorsqu'il change effectivement le comportement, même principe que `wouldOverride`
   * (PATCH /api/locations/[id]/route.ts). */
  returnTimeOverridden: boolean;
}

function assertOdometerProvided(value: number | null | undefined): asserts value is number {
  if (value === null || value === undefined) {
    throw new MissingReturnOdometerError();
  }
}

function assertValidOdometer(endOdometer: number, startOdometer: number | null): void {
  if (!Number.isInteger(endOdometer)) {
    throw new InvalidReturnOdometerError();
  }
  if (startOdometer !== null) {
    if (endOdometer <= startOdometer) {
      throw new InvalidReturnOdometerError();
    }
    return;
  }
  // Aucun kilométrage de départ connu (optionnel à la création, DOMAINRULES.md section 5) :
  // rien à comparer — un entier positif ou nul reste néanmoins exigé.
  if (endOdometer < 0) {
    throw new InvalidReturnOdometerError();
  }
}

function assertFuelLevelProvided(value: number | null | undefined): asserts value is number {
  if (value === null || value === undefined) {
    throw new MissingReturnFuelLevelError();
  }
}

function assertValidFuelLevel(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new InvalidReturnFuelLevelError();
  }
}

/** Heure serveur par défaut, jamais une valeur transmise par le client sans la permission
 * dédiée — voir ReturnLocationInput.canOverrideReturnTime. Bornes de cohérence appliquées
 * uniquement sur une valeur personnalisée réellement honorée : le repli par défaut (heure
 * serveur) est toujours trivialement valide et ne doit jamais pouvoir être rejeté par cette
 * même règle. */
function resolveActualReturnAt(input: ReturnLocationInput, locationStartDate: Date): { value: Date; overridden: boolean } {
  const now = new Date();
  if (!input.canOverrideReturnTime || input.actualReturnAt === undefined) {
    return { value: now, overridden: false };
  }
  const custom = input.actualReturnAt;
  if (Number.isNaN(custom.getTime())) {
    throw new InvalidReturnTimeError();
  }
  if (custom.getTime() < locationStartDate.getTime() || custom.getTime() > now.getTime()) {
    throw new InvalidReturnTimeError();
  }
  return { value: custom, overridden: true };
}

/** Même primitive que lockLocationForUpdate (src/lib/locations.ts, fonction privée non
 * exportée) — dupliquée localement pour ne pas dépendre des internes d'un autre module
 * (même convention que lockDamageForUpdate, src/lib/damages.ts). Colonnes minimales pour le
 * verrou ; la Location complète est relue après l'écriture via updateMany conditionné. */
async function lockLocationForReturn(
  tenantId: string,
  locationId: string,
  tx: Prisma.TransactionClient
): Promise<{ id: string; status: string; vehicleId: string; startDate: Date; startOdometer: number | null } | null> {
  const locked = await tx.$queryRaw<
    { id: string; status: string; vehicleId: string; startDate: Date; startOdometer: number | null }[]
  >`
    SELECT id, status, "vehicleId", "startDate", "startOdometer" FROM "Location"
    WHERE id = ${locationId} AND "tenantId" = ${tenantId} FOR UPDATE
  `;
  return locked[0] ?? null;
}

/**
 * Clôture transactionnelle d'un contrat par son retour. Ordre des opérations, toutes dans la
 * même transaction (rollback complet garanti par prisma.$transaction en cas d'échec à n'importe
 * quelle étape — aucun paiement/écriture de caisse/dégât/facture de dégâts partiel, aucun statut
 * véhicule incohérent) :
 *   1. verrouillage de la Location (empêche un double retour concurrent) ;
 *   2. verrouillage du Vehicle (toujours celui de la Location verrouillée — jamais un
 *      vehicleId fourni par le client : "le véhicule correspond au contrat" est garanti par
 *      construction, pas par une vérification a posteriori) ;
 *   3. validations kilométrage/carburant (obligatoires, kilométrage strictement croissant) ;
 *   4. résolution de la date/heure réelle de retour ;
 *   5. transition atomique de la Location (endOdometer/endFuelLevel/actualReturnAt/COMPLETED) ;
 *   6. encaissement du solde locatif éventuel (réutilise createPayment/createMixedPayments,
 *      src/lib/payments.ts, tels quels — mêmes garanties anti-double-encaissement) ;
 *   7. création des dégâts éventuels (createDamage, src/lib/damages.ts) ;
 *   8. pour les dégâts facturables (billableAmount > 0) : une DamageInvoice unique regroupant
 *      tous ces dégâts (createDamageInvoice, src/lib/damage-invoices.ts), puis son paiement
 *      éventuel (damageInvoicePaymentLines, createDamageInvoicePayments) — jamais mêlé au solde
 *      locatif de l'étape 6 ;
 *   9. passage du véhicule à AVAILABLE — seule la dernière étape, atteinte uniquement si tout
 *      ce qui précède a réussi.
 */
export async function returnLocation(input: ReturnLocationInput): Promise<ReturnLocationResult> {
  assertOdometerProvided(input.endOdometer);
  assertFuelLevelProvided(input.endFuelLevel);
  assertValidFuelLevel(input.endFuelLevel);
  const endOdometer = input.endOdometer;
  const endFuelLevel = input.endFuelLevel;

  return prisma.$transaction(async (tx) => {
    const locked = await lockLocationForReturn(input.tenantId, input.locationId, tx);
    if (!locked) {
      throw new LocationReturnNotFoundError();
    }
    if (locked.status !== "ACTIVE") {
      throw new LocationNotActiveForReturnError();
    }

    const vehicle = await lockVehicleForUpdate(input.tenantId, locked.vehicleId, tx);
    if (!vehicle) {
      throw new VehicleNotFoundForReturnError();
    }

    assertValidOdometer(endOdometer, locked.startOdometer);

    const { value: actualReturnAt, overridden } = resolveActualReturnAt(input, locked.startDate);

    const { count } = await tx.location.updateMany({
      where: { id: locked.id, status: "ACTIVE" },
      data: {
        endOdometer,
        endFuelLevel,
        actualReturnAt,
        status: "COMPLETED",
      },
    });
    if (count === 0) {
      throw new LocationReturnConflictError();
    }
    const updatedLocation = await tx.location.findUniqueOrThrow({ where: { id: locked.id } });

    // Sprint 33 : la facture du contrat (solde locatif) n'est plus jamais liée aux dégâts —
    // needsInvoice ne dépend que de paymentLines (solde locatif). La DamageInvoice (étape 8) a
    // sa propre numérotation/son propre cycle de vie, indépendants de cette Invoice.
    const needsInvoice = Boolean(input.paymentLines && input.paymentLines.length > 0);

    let invoiceId: string | null = null;
    if (needsInvoice) {
      const invoice = await tx.invoice.findFirst({
        where: { locationId: locked.id },
        orderBy: { createdAt: "desc" },
      });
      if (!invoice) {
        throw new LocationHasNoInvoiceError();
      }
      // Finding F (src/lib/location-payment.ts) : un paiement ne peut être enregistré que sur
      // une facture finalisée (ISSUED et au-delà) — même correctif appliqué ici, jamais réservé
      // au seul flux de création de contrat.
      if (invoice.status === "DRAFT") {
        await updateInvoice(input.tenantId, invoice.id, { status: "ISSUED" }, tx);
      }
      invoiceId = invoice.id;
    }

    const payments: Payment[] = [];
    if (input.paymentLines && input.paymentLines.length > 0) {
      const invoiceId_ = invoiceId as string;
      if (input.paymentLines.length === 1) {
        payments.push(
          await createPayment(
            {
              tenantId: input.tenantId,
              invoiceId: invoiceId_,
              amount: input.paymentLines[0].amount,
              method: input.paymentLines[0].method,
              paidAt: actualReturnAt,
            },
            tx
          )
        );
      } else {
        payments.push(
          ...(await createMixedPayments(
            {
              tenantId: input.tenantId,
              invoiceId: invoiceId_,
              lines: input.paymentLines,
              paidAt: actualReturnAt,
            },
            tx
          ))
        );
      }
    }

    const damages: Damage[] = [];
    for (const damageInput of input.damages ?? []) {
      const damage = await createDamage(
        {
          tenantId: input.tenantId,
          vehicleId: locked.vehicleId,
          locationId: locked.id,
          createdByUserId: input.userId,
          nature: damageInput.nature,
          description: damageInput.description,
          billableAmount: damageInput.billableAmount,
          currency: updatedLocation.currency,
        },
        tx
      );
      damages.push(damage);
    }

    // Sprint 33 (DOMAINRULES.md section 48) : tous les dégâts facturables de cette soumission
    // (billableAmount > 0) sont regroupés dans une unique DamageInvoice — un dégât non
    // facturable (billableAmount null/0) reste sans facture, jamais payable.
    const billableDamageIds = damages
      .filter((damage) => damage.billableAmount !== null && damage.billableAmount > 0)
      .map((damage) => damage.id);

    let damageInvoice: DamageInvoice | null = null;
    let damagePayments: Payment[] = [];
    if (billableDamageIds.length > 0) {
      const result = await createDamageInvoice(
        { tenantId: input.tenantId, locationId: locked.id, damageIds: billableDamageIds },
        tx
      );
      damageInvoice = result.invoice;

      if (input.damageInvoicePaymentLines && input.damageInvoicePaymentLines.length > 0) {
        damagePayments = await createDamageInvoicePayments(
          {
            tenantId: input.tenantId,
            damageInvoiceId: damageInvoice.id,
            lines: input.damageInvoicePaymentLines as DamagePaymentLine[],
            paidAt: actualReturnAt,
          },
          tx
        );
        // createDamageInvoicePayments recalcule DamageInvoice.amountPaid/status en base — le
        // snapshot `damageInvoice` ci-dessus (pris à la création, avant tout paiement) serait
        // sinon renvoyé périmé (toujours ISSUED) à l'appelant, même défaut que pour `damages` plus
        // bas (déjà corrigé) avant ce correctif.
        damageInvoice = await tx.damageInvoice.findUniqueOrThrow({ where: { id: damageInvoice.id } });
      }
    }

    // damages contient les instantanés pris avant facturation (status toujours REPORTED pour
    // les facturables) — relu après createDamageInvoice/createDamageInvoicePayments pour
    // refléter damageInvoiceId/status à jour, jamais renvoyé périmé à l'appelant.
    const refreshedDamages =
      damages.length > 0
        ? await tx.damage.findMany({ where: { id: { in: damages.map((damage) => damage.id) } } })
        : [];

    // Dernière étape, uniquement si tout ce qui précède a réussi (DOMAINRULES.md section 32).
    // Sprint "statut opérationnel automatique" (2026-08-28) : recalcul plutôt qu'une réécriture
    // aveugle à AVAILABLE — le véhicule retourné peut déjà avoir une autre opération bloquante
    // active en parallèle (ex. une maintenance planifiée démarrant le jour même du retour).
    await syncVehicleStatus(vehicle.id, tx);
    const updatedVehicle = await tx.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });

    return {
      location: updatedLocation,
      vehicle: updatedVehicle,
      payments,
      damages: refreshedDamages,
      damageInvoice,
      damagePayments,
      returnTimeOverridden: overridden,
    };
  });
}
