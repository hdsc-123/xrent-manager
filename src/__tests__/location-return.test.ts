import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createInvoice, updateInvoice } from "@/lib/invoices";
import {
  returnLocation,
  MissingReturnOdometerError,
  InvalidReturnOdometerError,
  MissingReturnFuelLevelError,
  InvalidReturnFuelLevelError,
  LocationNotActiveForReturnError,
  LocationReturnNotFoundError,
  LocationHasNoInvoiceError,
  InvalidReturnTimeError,
  PaymentExceedsRemainingBalanceError,
  DamageInvoicePaymentExceedsBalanceError,
} from "@/lib/location-return";

/**
 * Sprint 32 (DOMAINRULES.md section 32) — tests directs du service (pas de route HTTP à cette
 * étape, voir le rapport d'étape 2), même convention que src/__tests__/db.test.ts : fixtures
 * créées directement via Prisma, appel direct de returnLocation (src/lib/location-return.ts).
 *
 * Sprint 33 (DOMAINRULES.md section 48) : les dégâts facturables saisis au retour sont
 * désormais automatiquement regroupés dans une unique DamageInvoice (createDamageInvoice,
 * src/lib/damage-invoices.ts) — les scénarios de paiement de dégât ci-dessous sont adaptés en
 * conséquence (damageInvoicePaymentLines, un seul paiement pour l'ensemble des dégâts
 * facturables de la soumission, jamais un paiement par dégât individuel).
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

let tenantId: string;
let agencyId: string;
let clientId: string;
let userId: string;
let counter = 0;

beforeAll(async () => {
  const tenant = await prisma.tenant.create({
    data: { name: "Location Return Test", slug: `location-return-test-${runId}` },
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

interface FixtureOptions {
  startOdometer?: number | null;
  totalPrice?: number;
  startDate?: Date;
}

async function createActiveLocationWithInvoice(options: FixtureOptions = {}) {
  counter += 1;
  const vehicle = await prisma.vehicle.create({
    data: {
      tenantId,
      agencyId,
      name: `Véhicule ${counter}`,
      licensePlate: `RET-${runId}-${counter}`,
      make: "Dacia",
      model: "Logan",
      year: 2022,
      category: "ECONOMY",
      status: "RENTED",
      currency: "MAD",
    },
  });
  const start = options.startDate ?? new Date(Date.UTC(2031, 0, 1));
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
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
      totalPrice: options.totalPrice ?? 15000,
      currency: "MAD",
      startOdometer: options.startOdometer === undefined ? 1000 : options.startOdometer,
      startFuelLevel: 50,
      contractNumber: `RET-${runId}-${counter}`,
    },
  });
  const invoice = await createInvoice({ tenantId, locationId: location.id });
  await updateInvoice(tenantId, invoice.id, { status: "SENT" });
  return { vehicle, location, invoiceId: invoice.id };
}

describe("returnLocation — retour valide", () => {
  it("clôture le contrat, met à jour kilométrage/carburant/actualReturnAt, passe le véhicule AVAILABLE", async () => {
    const { vehicle, location } = await createActiveLocationWithInvoice();
    const before = Date.now();

    const result = await returnLocation({
      tenantId,
      userId,
      locationId: location.id,
      endOdometer: 1200,
      endFuelLevel: 80,
      canOverrideReturnTime: false,
    });

    expect(result.location.status).toBe("COMPLETED");
    expect(result.location.endOdometer).toBe(1200);
    expect(result.location.endFuelLevel).toBe(80);
    expect(result.location.actualReturnAt).not.toBeNull();
    expect(result.location.actualReturnAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.vehicle.id).toBe(vehicle.id);
    expect(result.vehicle.status).toBe("AVAILABLE");
    expect(result.returnTimeOverridden).toBe(false);

    const dbLocation = await prisma.location.findUniqueOrThrow({ where: { id: location.id } });
    const dbVehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    expect(dbLocation.status).toBe("COMPLETED");
    expect(dbVehicle.status).toBe("AVAILABLE");
  });
});

describe("returnLocation — kilométrage invalide", () => {
  it("refuse un kilométrage absent", async () => {
    const { location } = await createActiveLocationWithInvoice();
    await expect(
      returnLocation({
        tenantId,
        userId,
        locationId: location.id,
        endOdometer: undefined,
        endFuelLevel: 50,
        canOverrideReturnTime: false,
      })
    ).rejects.toThrow(MissingReturnOdometerError);
  });

  it("refuse un kilométrage égal au départ", async () => {
    const { location } = await createActiveLocationWithInvoice({ startOdometer: 1000 });
    await expect(
      returnLocation({
        tenantId,
        userId,
        locationId: location.id,
        endOdometer: 1000,
        endFuelLevel: 50,
        canOverrideReturnTime: false,
      })
    ).rejects.toThrow(InvalidReturnOdometerError);
  });

  it("refuse un kilométrage inférieur au départ", async () => {
    const { location } = await createActiveLocationWithInvoice({ startOdometer: 1000 });
    await expect(
      returnLocation({
        tenantId,
        userId,
        locationId: location.id,
        endOdometer: 900,
        endFuelLevel: 50,
        canOverrideReturnTime: false,
      })
    ).rejects.toThrow(InvalidReturnOdometerError);

    const dbLocation = await prisma.location.findUniqueOrThrow({ where: { id: location.id } });
    expect(dbLocation.status).toBe("ACTIVE");
    expect(dbLocation.endOdometer).toBeNull();
  });
});

describe("returnLocation — carburant invalide", () => {
  it("refuse un niveau de carburant absent", async () => {
    const { location } = await createActiveLocationWithInvoice();
    await expect(
      returnLocation({
        tenantId,
        userId,
        locationId: location.id,
        endOdometer: 1200,
        endFuelLevel: undefined,
        canOverrideReturnTime: false,
      })
    ).rejects.toThrow(MissingReturnFuelLevelError);
  });

  it("refuse un niveau de carburant hors des bornes 0-100", async () => {
    const { location } = await createActiveLocationWithInvoice();
    await expect(
      returnLocation({
        tenantId,
        userId,
        locationId: location.id,
        endOdometer: 1200,
        endFuelLevel: 101,
        canOverrideReturnTime: false,
      })
    ).rejects.toThrow(InvalidReturnFuelLevelError);

    await expect(
      returnLocation({
        tenantId,
        userId,
        locationId: location.id,
        endOdometer: 1200,
        endFuelLevel: -1,
        canOverrideReturnTime: false,
      })
    ).rejects.toThrow(InvalidReturnFuelLevelError);
  });
});

describe("returnLocation — double retour concurrent", () => {
  it("un seul des deux retours simultanés réussit, l'autre échoue proprement", async () => {
    const { location, vehicle } = await createActiveLocationWithInvoice();

    const results = await Promise.allSettled([
      returnLocation({
        tenantId,
        userId,
        locationId: location.id,
        endOdometer: 1200,
        endFuelLevel: 70,
        canOverrideReturnTime: false,
      }),
      returnLocation({
        tenantId,
        userId,
        locationId: location.id,
        endOdometer: 1300,
        endFuelLevel: 60,
        canOverrideReturnTime: false,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LocationNotActiveForReturnError);

    const dbLocation = await prisma.location.findUniqueOrThrow({ where: { id: location.id } });
    const dbVehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    expect(dbLocation.status).toBe("COMPLETED");
    expect(dbVehicle.status).toBe("AVAILABLE");
  });
});

describe("returnLocation — encaissement du solde locatif", () => {
  it("paiement espèces intégral au retour, paidAt = actualReturnAt (heure serveur)", async () => {
    const { location, invoiceId } = await createActiveLocationWithInvoice({ totalPrice: 15000 });
    const before = Date.now();

    const result = await returnLocation({
      tenantId,
      userId,
      locationId: location.id,
      endOdometer: 1200,
      endFuelLevel: 70,
      canOverrideReturnTime: false,
      paymentLines: [{ method: "CASH", amount: 15000 }],
    });

    expect(result.payments).toHaveLength(1);
    expect(result.payments[0].method).toBe("CASH");
    expect(result.payments[0].amount).toBe(15000);
    expect(result.payments[0].damageInvoiceId).toBeNull();
    expect(result.payments[0].paidAt.getTime()).toBe(result.location.actualReturnAt!.getTime());
    expect(result.payments[0].paidAt.getTime()).toBeGreaterThanOrEqual(before);

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.amountPaid).toBe(15000);
    expect(invoice.status).toBe("PAID");

    const cashEntry = await prisma.cashEntry.findFirst({ where: { paymentId: result.payments[0].id } });
    expect(cashEntry).not.toBeNull();
    expect(cashEntry?.amount).toBe(15000);
  });

  it("paiement carte intégral", async () => {
    const { location } = await createActiveLocationWithInvoice({ totalPrice: 15000 });
    const result = await returnLocation({
      tenantId,
      userId,
      locationId: location.id,
      endOdometer: 1200,
      endFuelLevel: 70,
      canOverrideReturnTime: false,
      paymentLines: [{ method: "CARD", amount: 15000 }],
    });
    expect(result.payments).toHaveLength(1);
    expect(result.payments[0].method).toBe("CARD");
  });

  it("paiement mixte (espèces + carte) — deux lignes, somme = montant encaissé", async () => {
    const { location, invoiceId } = await createActiveLocationWithInvoice({ totalPrice: 15000 });
    const result = await returnLocation({
      tenantId,
      userId,
      locationId: location.id,
      endOdometer: 1200,
      endFuelLevel: 70,
      canOverrideReturnTime: false,
      paymentLines: [
        { method: "CASH", amount: 6000 },
        { method: "CARD", amount: 9000 },
      ],
    });
    expect(result.payments).toHaveLength(2);
    const total = result.payments.reduce((sum, p) => sum + p.amount, 0);
    expect(total).toBe(15000);

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.amountPaid).toBe(15000);
  });

  it("refuse un encaissement qui dépasse le solde réel du contrat", async () => {
    const { location, vehicle } = await createActiveLocationWithInvoice({ totalPrice: 15000 });
    await expect(
      returnLocation({
        tenantId,
        userId,
        locationId: location.id,
        endOdometer: 1200,
        endFuelLevel: 70,
        canOverrideReturnTime: false,
        paymentLines: [{ method: "CASH", amount: 20000 }],
      })
    ).rejects.toThrow(PaymentExceedsRemainingBalanceError);

    // Rollback complet : ni le retour, ni le paiement, ni le passage du véhicule ne doivent
    // avoir été appliqués.
    const dbLocation = await prisma.location.findUniqueOrThrow({ where: { id: location.id } });
    const dbVehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    expect(dbLocation.status).toBe("ACTIVE");
    expect(dbVehicle.status).not.toBe("AVAILABLE");
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { locationId: location.id } });
    const realPayments = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(realPayments).toHaveLength(0);
  });
});

describe("returnLocation — dégâts", () => {
  it("crée plusieurs dégâts liés au véhicule et au contrat, avec/sans montant facturable — seuls les facturables sont facturés", async () => {
    const { location, vehicle } = await createActiveLocationWithInvoice();
    const result = await returnLocation({
      tenantId,
      userId,
      locationId: location.id,
      endOdometer: 1200,
      endFuelLevel: 70,
      canOverrideReturnTime: false,
      damages: [
        { nature: "Rayure portière", description: "Portière avant gauche", billableAmount: 800 },
        { nature: "Enjoliveur manquant" },
      ],
    });

    expect(result.damages).toHaveLength(2);
    for (const damage of result.damages) {
      expect(damage.vehicleId).toBe(vehicle.id);
      expect(damage.locationId).toBe(location.id);
      expect(damage.createdByUserId).toBe(userId);
    }
    const billable = result.damages.find((d) => d.nature === "Rayure portière")!;
    const nonBillable = result.damages.find((d) => d.nature === "Enjoliveur manquant")!;
    expect(billable.status).toBe("REPORTED");
    expect(billable.damageInvoiceId).not.toBeNull();
    expect(nonBillable.status).toBe("REPORTED");
    expect(nonBillable.damageInvoiceId).toBeNull();

    expect(result.damageInvoice).not.toBeNull();
    expect(result.damageInvoice?.totalAmount).toBe(800);
    expect(result.damageInvoice?.locationId).toBe(location.id);
  });

  it("regroupe plusieurs dégâts facturables dans une seule DamageInvoice", async () => {
    const { location } = await createActiveLocationWithInvoice();
    const result = await returnLocation({
      tenantId,
      userId,
      locationId: location.id,
      endOdometer: 1200,
      endFuelLevel: 70,
      canOverrideReturnTime: false,
      damages: [
        { nature: "Rayure portière", billableAmount: 800 },
        { nature: "Pare-choc fissuré", billableAmount: 1200 },
      ],
    });

    expect(result.damageInvoice).not.toBeNull();
    expect(result.damageInvoice?.totalAmount).toBe(2000);
    const lines = await prisma.damageInvoiceLine.findMany({ where: { damageInvoiceId: result.damageInvoice!.id } });
    expect(lines).toHaveLength(2);
  });

  it("encaisse un paiement de dégâts dans la même opération, séparé du solde locatif", async () => {
    const { location, invoiceId } = await createActiveLocationWithInvoice({ totalPrice: 15000 });
    const result = await returnLocation({
      tenantId,
      userId,
      locationId: location.id,
      endOdometer: 1200,
      endFuelLevel: 70,
      canOverrideReturnTime: false,
      paymentLines: [{ method: "CASH", amount: 15000 }],
      damages: [{ nature: "Pare-choc fissuré", billableAmount: 1000 }],
      damageInvoicePaymentLines: [{ method: "CASH", amount: 1000 }],
    });

    expect(result.damages).toHaveLength(1);
    expect(result.damages[0].status).toBe("PAID");
    expect(result.damageInvoice?.status).toBe("PAID");
    expect(result.damagePayments).toHaveLength(1);
    expect(result.damagePayments[0].damageInvoiceId).toBe(result.damageInvoice!.id);
    expect(result.damagePayments[0].invoiceId).toBeNull();

    // Le solde locatif (Invoice.amountPaid) ne doit jamais inclure le paiement de dégât —
    // seul le versement de 15000 (solde locatif) doit y figurer, pas les 1000 du dégât.
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.amountPaid).toBe(15000);
    expect(invoice.status).toBe("PAID");
  });

  it("rollback complet si le paiement des dégâts dépasse leur solde — aucune écriture partielle", async () => {
    const { location, vehicle, invoiceId } = await createActiveLocationWithInvoice({ totalPrice: 15000 });
    await expect(
      returnLocation({
        tenantId,
        userId,
        locationId: location.id,
        endOdometer: 1200,
        endFuelLevel: 70,
        canOverrideReturnTime: false,
        paymentLines: [{ method: "CASH", amount: 5000 }],
        damages: [{ nature: "Vitre brisée", billableAmount: 1000 }],
        damageInvoicePaymentLines: [{ method: "CASH", amount: 2000 }],
      })
    ).rejects.toThrow(DamageInvoicePaymentExceedsBalanceError);

    const dbLocation = await prisma.location.findUniqueOrThrow({ where: { id: location.id } });
    const dbVehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    expect(dbLocation.status).toBe("ACTIVE");
    expect(dbLocation.endOdometer).toBeNull();
    expect(dbVehicle.status).not.toBe("AVAILABLE");

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.amountPaid).toBe(0);
    const payments = await prisma.payment.findMany({ where: { invoiceId } });
    expect(payments).toHaveLength(0);
    const damages = await prisma.damage.findMany({ where: { locationId: location.id } });
    expect(damages).toHaveLength(0);
    const damageInvoices = await prisma.damageInvoice.findMany({ where: { locationId: location.id } });
    expect(damageInvoices).toHaveLength(0);
  });
});

describe("returnLocation — date/heure réelle de retour (permission)", () => {
  it("sans locations.return_time.edit : une valeur personnalisée est ignorée, l'heure serveur est utilisée", async () => {
    const { location } = await createActiveLocationWithInvoice();
    const farPast = new Date(Date.UTC(2020, 0, 1));
    const before = Date.now();

    const result = await returnLocation({
      tenantId,
      userId,
      locationId: location.id,
      endOdometer: 1200,
      endFuelLevel: 70,
      actualReturnAt: farPast,
      canOverrideReturnTime: false,
    });

    expect(result.returnTimeOverridden).toBe(false);
    expect(result.location.actualReturnAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("avec locations.return_time.edit : une valeur cohérente est honorée", async () => {
    // Contrairement aux autres fixtures de ce fichier (dates 2031, convention du projet pour
    // éviter tout conflit de disponibilité — non pertinente ici, la Location est créée
    // directement) : cette validation compare explicitement à l'heure serveur réelle
    // (InvalidReturnTimeError, "jamais dans le futur"), donc le départ du contrat doit être
    // réellement dans le passé pour qu'une valeur de retour réaliste puisse être honorée.
    const start = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const { location } = await createActiveLocationWithInvoice({ startDate: start });
    const customReturn = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const result = await returnLocation({
      tenantId,
      userId,
      locationId: location.id,
      endOdometer: 1200,
      endFuelLevel: 70,
      actualReturnAt: customReturn,
      canOverrideReturnTime: true,
    });

    expect(result.returnTimeOverridden).toBe(true);
    expect(result.location.actualReturnAt!.getTime()).toBe(customReturn.getTime());
  });

  it("avec locations.return_time.edit : une valeur antérieure au départ du contrat est refusée", async () => {
    const start = new Date(Date.UTC(2031, 0, 1));
    const { location } = await createActiveLocationWithInvoice({ startDate: start });
    const tooEarly = new Date(start.getTime() - 24 * 60 * 60 * 1000);

    await expect(
      returnLocation({
        tenantId,
        userId,
        locationId: location.id,
        endOdometer: 1200,
        endFuelLevel: 70,
        actualReturnAt: tooEarly,
        canOverrideReturnTime: true,
      })
    ).rejects.toThrow(InvalidReturnTimeError);
  });

  it("avec locations.return_time.edit : une valeur future est refusée", async () => {
    const { location } = await createActiveLocationWithInvoice();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await expect(
      returnLocation({
        tenantId,
        userId,
        locationId: location.id,
        endOdometer: 1200,
        endFuelLevel: 70,
        actualReturnAt: future,
        canOverrideReturnTime: true,
      })
    ).rejects.toThrow(InvalidReturnTimeError);
  });
});

/** Sprint 32 (étape 5, audit) : couverture manquante trouvée à l'audit — aucun test n'exerçait
 * encore ces deux branches, pourtant réelles. `POST /api/locations/[id]/return` ne les
 * atteint jamais en pratique (getLocationById + canAccessLocationAgency refusent déjà l'accès
 * avant d'appeler returnLocation, voir location-return-route.test.ts), donc ces tests
 * appellent directement le service, seule façon de les exercer. */
describe("returnLocation — contrat introuvable (défensif, jamais atteint via la route)", () => {
  it("refuse un locationId inexistant", async () => {
    await expect(
      returnLocation({
        tenantId,
        userId,
        locationId: "does-not-exist",
        endOdometer: 1200,
        endFuelLevel: 70,
        canOverrideReturnTime: false,
      })
    ).rejects.toThrow(LocationReturnNotFoundError);
  });
});

describe("returnLocation — contrat sans facture (défensif, jamais atteint en usage normal)", () => {
  it("refuse un encaissement de solde si aucune facture n'existe pour le contrat", async () => {
    const { location } = await createActiveLocationWithInvoice({ totalPrice: 15000 });
    // createLocation crée toujours une Invoice avec la Location (src/lib/locations.ts) — ce
    // scénario n'est donc jamais atteignable en usage normal, seulement en corrompant l'état
    // directement pour exercer la branche défensive de returnLocation.
    await prisma.invoice.deleteMany({ where: { locationId: location.id } });

    await expect(
      returnLocation({
        tenantId,
        userId,
        locationId: location.id,
        endOdometer: 1200,
        endFuelLevel: 70,
        canOverrideReturnTime: false,
        paymentLines: [{ method: "CASH", amount: 5000 }],
      })
    ).rejects.toThrow(LocationHasNoInvoiceError);
  });
});
