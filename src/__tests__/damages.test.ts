import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createInvoice, updateInvoice } from "@/lib/invoices";
import { createPayment } from "@/lib/payments";
import { adminCancelValidatedLocation } from "@/lib/locations";
import {
  createDamage,
  updateDamage,
  getDamageById,
  DamageNotFoundError,
  DamageNotEditableError,
  InvalidDamageAmountError,
  InvalidDamageNatureError,
} from "@/lib/damages";
import {
  createDamageInvoice,
  createDamageInvoicePayments,
  cancelDamageInvoice,
  getDamageInvoiceById,
  DamageInvoiceNotFoundError,
  DamageLocationMismatchError,
  DamageAlreadyInvoicedError,
  DamageNotBillableError,
  NoDamagesToInvoiceError,
  DamageInvoiceCancelledError,
  DamageInvoiceAlreadyCancelledError,
  DamageInvoicePaymentExceedsBalanceError,
  InvalidDamageInvoicePaymentAmountError,
  CorrectionReasonRequiredError,
} from "@/lib/damage-invoices";

/**
 * Sprint 32 (DOMAINRULES.md section 32) — tests directs du service (pas de route HTTP à cette
 * étape), même convention que src/__tests__/db.test.ts : fixtures créées directement via Prisma,
 * appel direct des fonctions de src/lib/damages.ts.
 *
 * Sprint 33 (DOMAINRULES.md section 48) : le paiement direct d'un dégât (createDamagePayments)
 * est retiré — remplacé par la facturation séparée (createDamageInvoice/
 * createDamageInvoicePayments, src/lib/damage-invoices.ts). Les scénarios ci-dessous couvrent le
 * nouveau flux ; les scénarios de solde/concurrence/non-régression du Sprint 32 restent
 * pertinents et sont conservés, adaptés à la nouvelle API.
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

let tenantId: string;
let agencyId: string;
let clientId: string;
let userId: string;
let counter = 0;

beforeAll(async () => {
  const tenant = await prisma.tenant.create({
    data: { name: "Damages Test", slug: `damages-test-${runId}` },
  });
  tenantId = tenant.id;
  const agency = await prisma.agency.create({ data: { tenantId, name: "Agence Test", slug: "agence-test" } });
  agencyId = agency.id;
  const client = await prisma.client.create({ data: { tenantId, name: "Client Test" } });
  clientId = client.id;
  const user = await prisma.user.create({
    data: { tenantId, email: `agent-${runId}@test.local`, name: "Agent", role: "MEMBER" },
  });
  userId = user.id;
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { tenantId } });
  await prisma.damageInvoiceLine.deleteMany({ where: { damageInvoice: { tenantId } } });
  await prisma.damage.deleteMany({ where: { tenantId } });
  await prisma.damageInvoice.deleteMany({ where: { tenantId } });
  await prisma.invoice.deleteMany({ where: { tenantId } });
  await prisma.location.deleteMany({ where: { tenantId } });
  await prisma.vehicle.deleteMany({ where: { tenantId } });
  await prisma.client.deleteMany({ where: { tenantId } });
  await prisma.user.deleteMany({ where: { tenantId } });
  await prisma.cashEntry.deleteMany({ where: { tenantId } });
  await prisma.cashRegister.deleteMany({ where: { tenantId } });
  await prisma.agency.deleteMany({ where: { tenantId } });
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.alert.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
});

/** Un contrat quelconque avec une facture finalisée, pour porter le vehicleId/locationId/
 * invoiceId requis par createDamage/createInvoice. contractNumber distinct par fixture pour
 * vérifier le format du numéro de facture de dégâts. */
async function createFixtureLocation() {
  counter += 1;
  const vehicle = await prisma.vehicle.create({
    data: {
      tenantId,
      agencyId,
      name: `Véhicule ${counter}`,
      licensePlate: `DMG-${runId}-${counter}`,
      make: "Dacia",
      model: "Logan",
      year: 2022,
      category: "ECONOMY",
      currency: "MAD",
    },
  });
  const start = new Date(Date.UTC(2031, 0, 1));
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
  const contractNumber = `DMG-${runId}-${counter}`;
  const location = await prisma.location.create({
    data: {
      tenantId,
      agencyId,
      vehicleId: vehicle.id,
      clientId,
      startDate: start,
      endDate: end,
      status: "ACTIVE",
      pricePerDay: 5000,
      totalPrice: 15000,
      currency: "MAD",
      contractNumber,
    },
  });
  const invoice = await createInvoice({ tenantId, locationId: location.id });
  await updateInvoice(tenantId, invoice.id, { status: "SENT" });
  return { vehicle, location, invoiceId: invoice.id, contractNumber };
}

describe("createDamage — validations", () => {
  it("refuse une nature vide", async () => {
    const { vehicle, location } = await createFixtureLocation();
    await expect(
      createDamage({
        tenantId,
        vehicleId: vehicle.id,
        locationId: location.id,
        createdByUserId: userId,
        nature: "   ",
        currency: "MAD",
      })
    ).rejects.toThrow(InvalidDamageNatureError);
  });

  it("refuse un montant facturable négatif ou non entier", async () => {
    const { vehicle, location } = await createFixtureLocation();
    await expect(
      createDamage({
        tenantId,
        vehicleId: vehicle.id,
        locationId: location.id,
        createdByUserId: userId,
        nature: "Rayure",
        billableAmount: -100,
        currency: "MAD",
      })
    ).rejects.toThrow(InvalidDamageAmountError);
  });

  it("crée un dégât sans montant facturable — statut REPORTED, jamais facturé", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Pare-choc rayé",
      description: "Rayure avant droite",
      currency: "MAD",
    });
    expect(damage.status).toBe("REPORTED");
    expect(damage.billableAmount).toBeNull();
    expect(damage.damageInvoiceId).toBeNull();
    expect(damage.vehicleId).toBe(vehicle.id);
    expect(damage.locationId).toBe(location.id);
    expect(damage.createdByUserId).toBe(userId);

    const fetched = await getDamageById(tenantId, damage.id);
    expect(fetched?.id).toBe(damage.id);
  });
});

describe("updateDamage — édition tant que non facturé (Sprint 33, damages.edit)", () => {
  it("corrige nature/description/billableAmount d'un dégât non facturé", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Rayure",
      billableAmount: 1000,
      currency: "MAD",
    });

    const updated = await updateDamage(tenantId, damage.id, { nature: "Rayure profonde", billableAmount: 1500 });
    expect(updated?.nature).toBe("Rayure profonde");
    expect(updated?.billableAmount).toBe(1500);
  });

  it("refuse une nature vide / un montant invalide", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Rayure",
      currency: "MAD",
    });
    await expect(updateDamage(tenantId, damage.id, { nature: "   " })).rejects.toThrow(InvalidDamageNatureError);
    await expect(updateDamage(tenantId, damage.id, { billableAmount: -5 })).rejects.toThrow(InvalidDamageAmountError);
  });

  it("refuse toute correction une fois le dégât facturé (DamageNotEditableError)", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Vitre fêlée",
      billableAmount: 2000,
      currency: "MAD",
    });
    await createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] });

    await expect(updateDamage(tenantId, damage.id, { nature: "Autre nature" })).rejects.toThrow(DamageNotEditableError);
  });

  it("retourne null pour un dégât introuvable", async () => {
    await expect(updateDamage(tenantId, "does-not-exist", { nature: "X" })).resolves.toBeNull();
  });
});

describe("createDamageInvoice — génération et idempotence", () => {
  it("refuse une liste de dégâts vide", async () => {
    const { location } = await createFixtureLocation();
    await expect(createDamageInvoice({ tenantId, locationId: location.id, damageIds: [] })).rejects.toThrow(
      NoDamagesToInvoiceError
    );
  });

  it("refuse un dégât introuvable", async () => {
    const { location } = await createFixtureLocation();
    await expect(
      createDamageInvoice({ tenantId, locationId: location.id, damageIds: ["does-not-exist"] })
    ).rejects.toThrow(DamageNotFoundError);
  });

  it("refuse un dégât d'un autre contrat (IDOR)", async () => {
    const { location } = await createFixtureLocation();
    const other = await createFixtureLocation();
    const foreignDamage = await createDamage({
      tenantId,
      vehicleId: other.vehicle.id,
      locationId: other.location.id,
      createdByUserId: userId,
      nature: "Dégât d'un autre contrat",
      billableAmount: 1000,
      currency: "MAD",
    });
    await expect(
      createDamageInvoice({ tenantId, locationId: location.id, damageIds: [foreignDamage.id] })
    ).rejects.toThrow(DamageLocationMismatchError);
  });

  it("refuse un dégât sans montant facturable", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Dégât gratuit",
      currency: "MAD",
    });
    await expect(
      createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] })
    ).rejects.toThrow(DamageNotBillableError);
  });

  it("génère une facture au format FACT-DEG-{5 chiffres}/{contractNumber}, statut SENT", async () => {
    const { vehicle, location, contractNumber } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Rétroviseur cassé",
      billableAmount: 3000,
      currency: "MAD",
    });

    const { invoice, damages } = await createDamageInvoice({
      tenantId,
      locationId: location.id,
      damageIds: [damage.id],
    });

    expect(invoice.number).toBe(`${invoice.number.split("/")[0]}/${contractNumber}`);
    expect(invoice.number.startsWith("FACT-DEG-")).toBe(true);
    expect(invoice.number.split("-")[2].split("/")[0]).toHaveLength(5);
    expect(invoice.status).toBe("SENT");
    expect(invoice.subtotal).toBe(3000);
    expect(invoice.totalAmount).toBe(3000);
    expect(invoice.amountPaid).toBe(0);
    expect(invoice.locationId).toBe(location.id);
    expect(invoice.agencyId).toBe(agencyId);
    expect(invoice.clientId).toBe(clientId);

    expect(damages).toHaveLength(1);
    expect(damages[0].damageInvoiceId).toBe(invoice.id);
    expect(damages[0].status).toBe("REPORTED");

    const lines = await prisma.damageInvoiceLine.findMany({ where: { damageInvoiceId: invoice.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0].billableAmount).toBe(3000);
    expect(lines[0].nature).toBe("Rétroviseur cassé");
  });

  it("regroupe plusieurs dégâts dans une seule facture", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damageA = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Aile enfoncée",
      billableAmount: 2000,
      currency: "MAD",
    });
    const damageB = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Pare-brise fissuré",
      billableAmount: 1500,
      currency: "MAD",
    });

    const { invoice } = await createDamageInvoice({
      tenantId,
      locationId: location.id,
      damageIds: [damageA.id, damageB.id],
    });

    expect(invoice.totalAmount).toBe(3500);
    const lines = await prisma.damageInvoiceLine.findMany({ where: { damageInvoiceId: invoice.id } });
    expect(lines).toHaveLength(2);
  });

  it("refuse de facturer un dégât déjà facturé (idempotence)", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Jante voilée",
      billableAmount: 1000,
      currency: "MAD",
    });
    await createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] });

    await expect(
      createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] })
    ).rejects.toThrow(DamageAlreadyInvoicedError);
  });

  it("double soumission concurrente sur le même dégât : une seule facture créée", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Phare cassé",
      billableAmount: 1200,
      currency: "MAD",
    });

    const results = await Promise.allSettled([
      createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] }),
      createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const reloaded = await getDamageById(tenantId, damage.id);
    expect(reloaded?.damageInvoiceId).not.toBeNull();
    const invoiceCount = await prisma.damageInvoice.count({ where: { locationId: location.id } });
    expect(invoiceCount).toBe(1);
  });
});

describe("createDamageInvoicePayments — solde et encaissement", () => {
  it("refuse un montant de ligne invalide (zéro/négatif/non entier)", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Vitre fêlée",
      billableAmount: 2000,
      currency: "MAD",
    });
    const { invoice } = await createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] });

    await expect(
      createDamageInvoicePayments({ tenantId, damageInvoiceId: invoice.id, lines: [{ method: "CASH", amount: 0 }] })
    ).rejects.toThrow(InvalidDamageInvoicePaymentAmountError);
  });

  it("refuse une facture introuvable", async () => {
    await expect(
      createDamageInvoicePayments({
        tenantId,
        damageInvoiceId: "does-not-exist",
        lines: [{ method: "CASH", amount: 1000 }],
      })
    ).rejects.toThrow(DamageInvoiceNotFoundError);
  });

  it("paiement espèces intégral — statut PAID, écriture de caisse créée, dégât PAID", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Rétroviseur cassé",
      billableAmount: 3000,
      currency: "MAD",
    });
    const { invoice } = await createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] });

    const payments = await createDamageInvoicePayments({
      tenantId,
      damageInvoiceId: invoice.id,
      lines: [{ method: "CASH", amount: 3000 }],
    });

    expect(payments).toHaveLength(1);
    expect(payments[0].damageInvoiceId).toBe(invoice.id);
    expect(payments[0].invoiceId).toBeNull();
    expect(payments[0].amount).toBe(3000);

    const updatedInvoice = await getDamageInvoiceById(tenantId, invoice.id);
    expect(updatedInvoice?.status).toBe("PAID");
    expect(updatedInvoice?.amountPaid).toBe(3000);

    const updatedDamage = await getDamageById(tenantId, damage.id);
    expect(updatedDamage?.status).toBe("PAID");

    const cashEntry = await prisma.cashEntry.findFirst({ where: { paymentId: payments[0].id } });
    expect(cashEntry).not.toBeNull();
    expect(cashEntry?.category).toBe("DEGATS");
    expect(cashEntry?.contractId).toBe(location.id);
    expect(cashEntry?.amount).toBe(3000);
  });

  it("paiement mixte (carte + espèces) — deux lignes, statut PAID si le total règle le solde", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Aile enfoncée",
      billableAmount: 5000,
      currency: "MAD",
    });
    const { invoice } = await createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] });

    const payments = await createDamageInvoicePayments({
      tenantId,
      damageInvoiceId: invoice.id,
      lines: [
        { method: "CASH", amount: 2000 },
        { method: "CARD", amount: 3000 },
      ],
    });

    expect(payments).toHaveLength(2);
    const total = payments.reduce((sum, p) => sum + p.amount, 0);
    expect(total).toBe(5000);

    const updatedInvoice = await getDamageInvoiceById(tenantId, invoice.id);
    expect(updatedInvoice?.status).toBe("PAID");
  });

  it("paiement partiel — statut PARTIALLY_PAID, puis solde exact — statut PAID", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Sellerie tachée",
      billableAmount: 4000,
      currency: "MAD",
    });
    const { invoice } = await createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] });

    await createDamageInvoicePayments({ tenantId, damageInvoiceId: invoice.id, lines: [{ method: "CASH", amount: 1000 }] });
    let updatedInvoice = await getDamageInvoiceById(tenantId, invoice.id);
    expect(updatedInvoice?.status).toBe("PARTIALLY_PAID");
    let updatedDamage = await getDamageById(tenantId, damage.id);
    expect(updatedDamage?.status).toBe("PARTIALLY_PAID");

    await createDamageInvoicePayments({ tenantId, damageInvoiceId: invoice.id, lines: [{ method: "CARD", amount: 3000 }] });
    updatedInvoice = await getDamageInvoiceById(tenantId, invoice.id);
    expect(updatedInvoice?.status).toBe("PAID");
    updatedDamage = await getDamageById(tenantId, damage.id);
    expect(updatedDamage?.status).toBe("PAID");
  });

  it("refuse un dépassement du solde de la facture de dégâts", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Pare-brise fissuré",
      billableAmount: 1000,
      currency: "MAD",
    });
    const { invoice } = await createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] });

    await expect(
      createDamageInvoicePayments({ tenantId, damageInvoiceId: invoice.id, lines: [{ method: "CASH", amount: 1500 }] })
    ).rejects.toThrow(DamageInvoicePaymentExceedsBalanceError);

    const unchanged = await getDamageInvoiceById(tenantId, invoice.id);
    expect(unchanged?.status).toBe("SENT");
    const payments = await prisma.payment.findMany({ where: { damageInvoiceId: invoice.id } });
    expect(payments).toHaveLength(0);
  });

  it("double encaissement concurrent sur la même facture : un seul succès, jamais de dépassement", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Jante voilée",
      billableAmount: 2000,
      currency: "MAD",
    });
    const { invoice } = await createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] });

    const results = await Promise.allSettled([
      createDamageInvoicePayments({ tenantId, damageInvoiceId: invoice.id, lines: [{ method: "CASH", amount: 1500 }] }),
      createDamageInvoicePayments({ tenantId, damageInvoiceId: invoice.id, lines: [{ method: "CARD", amount: 1500 }] }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DamageInvoicePaymentExceedsBalanceError);

    const payments = await prisma.payment.findMany({ where: { damageInvoiceId: invoice.id } });
    const total = payments.reduce((sum, p) => sum + p.amount, 0);
    expect(total).toBeLessThanOrEqual(2000);
    expect(total).toBe(1500);
  });
});

describe("cancelDamageInvoice — réversibilité financière (Sprint 33)", () => {
  it("exige un motif", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Rayure",
      billableAmount: 1000,
      currency: "MAD",
    });
    const { invoice } = await createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] });
    await expect(cancelDamageInvoice(tenantId, invoice.id, { reason: "  ", performedByUserId: userId })).rejects.toThrow(
      CorrectionReasonRequiredError
    );
  });

  it("annule une facture sans paiement — statut CANCELLED, dégât CANCELLED", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Rayure",
      billableAmount: 1000,
      currency: "MAD",
    });
    const { invoice } = await createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] });

    const result = await cancelDamageInvoice(tenantId, invoice.id, { reason: "Erreur de saisie", performedByUserId: userId });
    expect(result?.invoice.status).toBe("CANCELLED");
    expect(result?.reversedPaymentCount).toBe(0);

    const updatedDamage = await getDamageById(tenantId, damage.id);
    expect(updatedDamage?.status).toBe("CANCELLED");
  });

  it("annule une facture payée — paiement REFUNDED, compensation de caisse créée", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Pare-choc",
      billableAmount: 2000,
      currency: "MAD",
    });
    const { invoice } = await createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] });
    const [payment] = await createDamageInvoicePayments({
      tenantId,
      damageInvoiceId: invoice.id,
      lines: [{ method: "CASH", amount: 2000 }],
    });

    const result = await cancelDamageInvoice(tenantId, invoice.id, { reason: "Client remboursé", performedByUserId: userId });
    expect(result?.reversedPaymentCount).toBe(1);
    expect(result?.reversedAmountTotal).toBe(2000);

    const reloadedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reloadedPayment.status).toBe("REFUNDED");
    expect(reloadedPayment.amount).toBe(2000);

    const compensation = await prisma.cashEntry.findFirst({
      where: { paymentId: payment.id, category: "ANNULATION_FACTURE_DEGATS" },
    });
    expect(compensation).not.toBeNull();
    expect(compensation?.type).toBe("EXPENSE");
    expect(compensation?.amount).toBe(2000);
  });

  it("refuse d'encaisser un paiement sur une facture annulée", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Rayure",
      billableAmount: 1000,
      currency: "MAD",
    });
    const { invoice } = await createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] });
    await cancelDamageInvoice(tenantId, invoice.id, { reason: "Erreur", performedByUserId: userId });

    await expect(
      createDamageInvoicePayments({ tenantId, damageInvoiceId: invoice.id, lines: [{ method: "CASH", amount: 500 }] })
    ).rejects.toThrow(DamageInvoiceCancelledError);
  });

  it("refuse une seconde annulation", async () => {
    const { vehicle, location } = await createFixtureLocation();
    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Rayure",
      billableAmount: 1000,
      currency: "MAD",
    });
    const { invoice } = await createDamageInvoice({ tenantId, locationId: location.id, damageIds: [damage.id] });
    await cancelDamageInvoice(tenantId, invoice.id, { reason: "Erreur", performedByUserId: userId });

    await expect(
      cancelDamageInvoice(tenantId, invoice.id, { reason: "Nouvelle tentative", performedByUserId: userId })
    ).rejects.toThrow(DamageInvoiceAlreadyCancelledError);
  });
});

/**
 * Sprint 32 (étape 5, audit) — incohérence réelle trouvée : adminCancelValidatedLocation
 * (src/lib/locations.ts, Sprint 23) recherchait les Payment à rembourser par `invoiceId` seul.
 * Sprint 33 : un paiement de dégât n'a plus jamais d'invoiceId (Payment.invoiceId/
 * damageInvoiceId mutuellement exclusifs, contrainte CHECK) — le correctif est donc désormais
 * structurel (filtrer par invoiceId exclut déjà tout paiement de dégât), revérifié ici par un
 * test de non-régression équivalent à celui du Sprint 32.
 */
describe("adminCancelValidatedLocation — n'affecte jamais un paiement de dégât (Sprint 32/33)", () => {
  it("rembourse le paiement de solde locatif mais laisse un paiement de dégât intact", async () => {
    const { vehicle, location, invoiceId } = await createFixtureLocation();

    await updateInvoice(tenantId, invoiceId, { status: "SENT" });
    const rentalPayment = await createPayment({
      tenantId,
      invoiceId,
      amount: 5000,
      method: "CASH",
    });

    const damage = await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Rétroviseur cassé",
      billableAmount: 2000,
      currency: "MAD",
    });
    const { invoice: damageInvoice } = await createDamageInvoice({
      tenantId,
      locationId: location.id,
      damageIds: [damage.id],
    });
    const [damagePayment] = await createDamageInvoicePayments({
      tenantId,
      damageInvoiceId: damageInvoice.id,
      lines: [{ method: "CASH", amount: 2000 }],
    });

    const result = await adminCancelValidatedLocation(tenantId, location.id, {
      reason: "Audit Sprint 32/33 — test de non-régression",
      performedByUserId: userId,
    });

    expect(result).not.toBeNull();
    expect(result?.reversedPaymentCount).toBe(1);

    const reloadedRentalPayment = await prisma.payment.findUniqueOrThrow({ where: { id: rentalPayment.id } });
    expect(reloadedRentalPayment.status).toBe("REFUNDED");

    const reloadedDamagePayment = await prisma.payment.findUniqueOrThrow({ where: { id: damagePayment.id } });
    expect(reloadedDamagePayment.status).toBe("ACTIVE");

    const damageCompensation = await prisma.cashEntry.findFirst({
      where: { paymentId: damagePayment.id, category: "ANNULATION_CONTRAT" },
    });
    expect(damageCompensation).toBeNull();

    const damageAfterCancel = await getDamageById(tenantId, damage.id);
    expect(damageAfterCancel?.status).toBe("PAID");

    const damageInvoiceAfterCancel = await getDamageInvoiceById(tenantId, damageInvoice.id);
    expect(damageInvoiceAfterCancel?.status).toBe("PAID");
  });
});

/**
 * Sprint 32 (étape 5, audit) — incohérence réelle trouvée : Damage.locationId est une
 * contrainte de clé étrangère réelle vers Location (jamais de suppression physique d'un
 * dégât), mais deleteLocation (src/lib/locations.ts, Sprint 5) ne vérifiait pas l'existence de
 * Damage avant de tenter la suppression.
 */
describe("deleteLocation — refuse proprement si un dégât est attaché (Sprint 32, correctif)", () => {
  it("refuse la suppression d'une location PENDING ayant un dégât, même non payé", async () => {
    counter += 1;
    const vehicle = await prisma.vehicle.create({
      data: {
        tenantId,
        agencyId,
        name: `DeleteGuardVehicle${counter}`,
        licensePlate: `DELGUARD-${runId}-${counter}`,
        make: "Dacia",
        model: "Logan",
        year: 2022,
        category: "ECONOMY",
        currency: "MAD",
      },
    });
    const start = new Date(Date.UTC(2031, 0, 1));
    const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
    const location = await prisma.location.create({
      data: {
        tenantId,
        agencyId,
        vehicleId: vehicle.id,
        clientId,
        startDate: start,
        endDate: end,
        status: "PENDING",
        pricePerDay: 5000,
        totalPrice: 15000,
        currency: "MAD",
        contractNumber: `DELGUARD-${runId}-${counter}`,
      },
    });
    await createInvoice({ tenantId, locationId: location.id });
    await createDamage({
      tenantId,
      vehicleId: vehicle.id,
      locationId: location.id,
      createdByUserId: userId,
      nature: "Rayure constatée avant confirmation",
      currency: "MAD",
    });

    const { deleteLocation, LocationHasInvoiceError } = await import("@/lib/locations");
    await expect(deleteLocation(tenantId, location.id)).rejects.toThrow(LocationHasInvoiceError);

    const stillExists = await prisma.location.findUnique({ where: { id: location.id } });
    expect(stillExists).not.toBeNull();
  });
});
