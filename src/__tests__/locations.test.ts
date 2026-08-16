import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let memberA: AuthenticatedTestUser;
/** Sprint 19 — MEMBER rattaché à agencyA1Id (contrairement à memberA), pour tester que la
 * machine à états/le verrou de dates s'applique toujours à un MEMBER (contrairement à
 * l'override ADMIN, voir DOMAINRULES.md section 37). */
let linkedMemberA: AuthenticatedTestUser;
let agencyA1Id: string;
let agencyB1Id: string;
let vehicleAId: string; // pricePerDay = 5000 (50,00 MAD)
let vehicleBId: string;
let clientAId: string;
let clientBId: string;

async function createLocation(
  admin: AuthenticatedTestUser,
  overrides: Record<string, unknown> = {}
) {
  return apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      vehicleId: vehicleAId,
      clientId: clientAId,
      startDate: "2028-01-10",
      endDate: "2028-01-13",
      ...overrides,
    }),
  });
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Locations Test A",
    tenantSlug: `locations-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Locations Test B",
    tenantSlug: `locations-test-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminB.tenantId);

  memberA = await createAndLoginMember({
    tenantId: adminA.tenantId,
    name: "Member A",
    email: `member-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });

  const agencyAResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A1", slug: `agence-a1-${runId}` }),
  });
  agencyA1Id = (await agencyAResponse.json()).agency.id;

  const agencyBResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Agence B1", slug: `agence-b1-${runId}` }),
  });
  agencyB1Id = (await agencyBResponse.json()).agency.id;

  const vehicleAResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      agencyId: agencyA1Id,
      name: "Clio",
      licensePlate: `LOC-A-${runId}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay: 5000,
      chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
    }),
  });
  vehicleAId = (await vehicleAResponse.json()).vehicle.id;

  const vehicleBResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({
      agencyId: agencyB1Id,
      name: "208",
      licensePlate: `LOC-B-${runId}`,
      make: "Peugeot",
      model: "208",
      year: 2022,
      category: "Citadine",
      pricePerDay: 4000,
      chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
    }),
  });
  vehicleBId = (await vehicleBResponse.json()).vehicle.id;

  const clientAResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Client A", email: `client-a-${runId}@test.local` }),
  });
  clientAId = (await clientAResponse.json()).client.id;

  const clientBResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Client B", email: `client-b-${runId}@test.local` }),
  });
  clientBId = (await clientBResponse.json()).client.id;

  linkedMemberA = await createAndLoginMember({
    tenantId: adminA.tenantId,
    name: "Linked Member A",
    email: `linked-member-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  await prisma.userAgency.create({ data: { userId: linkedMemberA.userId, agencyId: agencyA1Id } });
});

/** Sprint 23 — plage de dates unique par appel (base 2028-02-01, +5 jours à chaque fois) : les
 * tests ci-dessous créent plusieurs contrats sur le même vehicleAId dans le même describe block
 * (contrairement aux tests existants du fichier, chacun avec ses propres dates explicites) —
 * sans cela, tous retomberaient sur les dates par défaut de createLocation et se
 * chevaucheraient (VehicleNotAvailableError, 409). */
let sprint23DateCounter = 0;
function nextTestDateRange(): { startDate: string; endDate: string } {
  const startDay = 1 + sprint23DateCounter * 5;
  sprint23DateCounter += 1;
  const start = new Date(Date.UTC(2028, 1, startDay));
  const end = new Date(Date.UTC(2028, 1, startDay + 3));
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

/** Sprint 23 — même motif que createLocationWithPayment (location-payment.test.ts) : crée un
 * contrat CONFIRMED avec un paiement intégré (donc une facture PAID et une CashEntry réelle),
 * pour tester l'annulation admin avec réversibilité financière. */
async function createConfirmedLocationWithPayment(admin: AuthenticatedTestUser) {
  const response = await createLocation(admin, {
    ...nextTestDateRange(),
    status: "CONFIRMED",
    payment: { method: "CASH", partial: false },
  });
  const body = await response.json();
  return {
    location: body.location as { id: string; agencyId: string; totalPrice: number },
    invoice: body.invoice as { id: string; status: string },
  };
}

describe("Sprint 23 — annulation d'un contrat validé, réservée ADMIN, avec réversibilité (DOMAINRULES.md section 39)", () => {
  it("PATCH status=CANCELLED sur un contrat CONFIRMED est refusé (403) même pour un ADMIN — seule POST .../admin-cancel le permet", async () => {
    const { location } = await createConfirmedLocationWithPayment(adminA);

    const patchResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(patchResponse.status).toBe(403);
  });

  it("PATCH status=CANCELLED sur un contrat encore PENDING reste autorisé pour un MEMBER (brouillon jamais validé)", async () => {
    const createResponse = await createLocation(linkedMemberA, nextTestDateRange());
    const { location: pendingLocation } = await createResponse.json();

    const patchResponse = await apiFetch(`/api/locations/${pendingLocation.id}`, {
      method: "PATCH",
      headers: { Cookie: linkedMemberA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(patchResponse.status).toBe(200);
  });

  it("POST .../admin-cancel refusé (403) pour un MEMBER, même rattaché à l'agence", async () => {
    const { location } = await createConfirmedLocationWithPayment(adminA);

    const response = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: linkedMemberA.sessionCookie },
    });
    expect(response.status).toBe(403);
  });

  it("POST .../admin-cancel refusé (409) sur un contrat encore PENDING", async () => {
    const createResponse = await createLocation(adminA, nextTestDateRange());
    const { location: pendingLocation } = await createResponse.json();

    const response = await apiFetch(`/api/locations/${pendingLocation.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Test — contrat encore PENDING" }),
    });
    expect(response.status).toBe(409);
  });

  it("annule un contrat CONFIRMED avec facture PAID : facture annulée, écriture de compensation créée, solde de caisse revenu à sa valeur d'origine, Payment conservé et marqué REFUNDED", async () => {
    const balanceBefore = await apiFetch("/api/cash-register", { headers: { Cookie: adminA.sessionCookie } });
    const currentBalanceBefore = (await balanceBefore.json()).currentBalance as number;

    const { location, invoice } = await createConfirmedLocationWithPayment(adminA);
    expect(invoice.status).toBe("PAID");

    const paymentsBefore = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(paymentsBefore.length).toBe(1);
    const paymentAmount = paymentsBefore[0].amount;

    const response = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Client — annulation de contrat" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.status).toBe("CANCELLED");
    expect(body.cancelledInvoiceCount).toBe(1);
    expect(body.reversedPaymentCount).toBe(1);
    expect(body.reversedAmountTotal).toBe(paymentAmount);

    const invoiceAfter = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(invoiceAfter?.status).toBe("CANCELLED");

    // Le Payment d'origine n'est jamais supprimé, ni réécrit dans son amount/method/paidAt
    // (append-only, DOMAINRULES.md section 10/23) — seul son statut passe à REFUNDED (Sprint
    // 26D, Finding D1) ; une écriture de compensation est ajoutée en caisse, liée à l'écriture
    // et au Payment d'origine.
    const paymentsAfter = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(paymentsAfter).toHaveLength(1);
    expect(paymentsAfter[0].amount).toBe(paymentsBefore[0].amount);
    expect(paymentsAfter[0].method).toBe(paymentsBefore[0].method);
    expect(paymentsAfter[0].paidAt).toEqual(paymentsBefore[0].paidAt);
    expect(paymentsBefore[0].status).toBe("ACTIVE");
    expect(paymentsAfter[0].status).toBe("REFUNDED");

    const originalEntry = await prisma.cashEntry.findFirst({
      where: { paymentId: paymentsAfter[0].id, parentEntryId: null },
    });
    expect(originalEntry).not.toBeNull();
    expect(originalEntry?.amount).toBe(paymentAmount);

    const compensationEntry = await prisma.cashEntry.findFirst({
      where: { contractId: location.id, category: "ANNULATION_CONTRAT" },
    });
    expect(compensationEntry).not.toBeNull();
    expect(compensationEntry?.type).toBe("EXPENSE");
    expect(compensationEntry?.amount).toBe(paymentAmount);
    expect(compensationEntry?.paymentId).toBe(paymentsAfter[0].id);
    expect(compensationEntry?.parentEntryId).toBe(originalEntry?.id);
    expect(compensationEntry?.reason).toBe("Client — annulation de contrat");
    expect(compensationEntry?.performedByUserId).toBe(adminA.userId);

    const balanceAfter = await apiFetch("/api/cash-register", { headers: { Cookie: adminA.sessionCookie } });
    const currentBalanceAfter = (await balanceAfter.json()).currentBalance as number;
    expect(currentBalanceAfter).toBe(currentBalanceBefore);
  });

  it("un second appel admin-cancel sur le même contrat déjà annulé échoue proprement (409, jamais un double reversal)", async () => {
    const { location } = await createConfirmedLocationWithPayment(adminA);

    const first = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Premier appel" }),
    });
    expect(first.status).toBe(200);

    const second = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Second appel — doit échouer" }),
    });
    expect(second.status).toBe(409);
  });

  it("Sprint 26D (Finding D1) — idempotence : un second appel (retry) ne rembourse jamais deux fois le même Payment", async () => {
    const { location, invoice } = await createConfirmedLocationWithPayment(adminA);
    const paymentsBefore = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(paymentsBefore).toHaveLength(1);
    const paymentId = paymentsBefore[0].id;

    const first = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Premier remboursement" }),
    });
    expect(first.status).toBe(200);

    const paymentAfterFirst = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(paymentAfterFirst.status).toBe("REFUNDED");
    const compensationsAfterFirst = await prisma.cashEntry.findMany({ where: { paymentId, parentEntryId: { not: null } } });
    expect(compensationsAfterFirst).toHaveLength(1);

    const second = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Retry — ne doit rien changer" }),
    });
    expect(second.status).toBe(409);

    // Conservé tel quel — jamais un second remboursement, jamais une seconde compensation.
    const paymentAfterSecond = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(paymentAfterSecond).toEqual(paymentAfterFirst);
    const compensationsAfterSecond = await prisma.cashEntry.findMany({ where: { paymentId, parentEntryId: { not: null } } });
    expect(compensationsAfterSecond).toHaveLength(1);
    expect(compensationsAfterSecond[0].id).toBe(compensationsAfterFirst[0].id);
  });

  it("un contrat annulé avec historique financier reste bloqué à la suppression (LocationHasInvoiceError, décision documentée section 3.3 du plan Sprint 23)", async () => {
    const { location } = await createConfirmedLocationWithPayment(adminA);
    await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Annulation avant suppression" }),
    });

    const deleteResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(409);
  });

  it("le contrat annulé n'est plus compté dans le CA réalisé du véhicule (getTopVehicles)", async () => {
    const { location } = await createConfirmedLocationWithPayment(adminA);
    // Contrat validé (CONFIRMED) : passe ACTIVE pour compter dans REALIZED_LOCATION_STATUSES
    // (src/lib/reports.ts) avant annulation, pour vérifier qu'il en sort bien après.
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    const { getTopVehicles } = await import("@/lib/reports");
    const before = await getTopVehicles(adminA.tenantId, 50);
    const vehicleBefore = before.find((entry) => entry.vehicleId === vehicleAId);
    expect(vehicleBefore).toBeDefined();

    await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Annulation — CA réalisé" }),
    });

    const after = await getTopVehicles(adminA.tenantId, 50);
    const vehicleAfter = after.find((entry) => entry.vehicleId === vehicleAId);
    expect(vehicleAfter?.revenue ?? 0).toBe((vehicleBefore?.revenue ?? 0) - location.totalPrice);
  });
});

describe("Sprint 23 — correctif de concurrence sur updateLocation (DOMAINRULES.md section 39, étend le correctif Sprint 22)", () => {
  it("deux transitions de statut concurrentes sur la même location PENDING — une seule réussit (409 pour l'autre)", async () => {
    // PENDING → CONFIRMED et PENDING → CANCELLED sont toutes deux des transitions normalement
    // valides depuis PENDING (contrairement à CONFIRMED → CANCELLED, réservée ADMIN depuis ce
    // sprint via admin-cancel) — le choix le plus propre pour exercer la garde de concurrence
    // sans se heurter à cette nouvelle restriction.
    const createResponse = await createLocation(adminA, nextTestDateRange());
    const { location } = await createResponse.json();

    const [toConfirmed, toCancelled] = await Promise.all([
      apiFetch(`/api/locations/${location.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ status: "CONFIRMED" }),
      }),
      apiFetch(`/api/locations/${location.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ status: "CANCELLED" }),
      }),
    ]);

    const statuses = [toConfirmed.status, toCancelled.status].sort();
    expect(statuses).toEqual([200, 409]);

    const finalLocation = await prisma.location.findUnique({ where: { id: location.id } });
    expect(["CONFIRMED", "CANCELLED"]).toContain(finalLocation?.status);
  });
});

describe("Sprint 26C, Finding C — verrou Vehicle contre le double booking concurrent", () => {
  it("Test 1 — deux POST /api/locations concurrents, même véhicule, dates chevauchantes : une seule réussite, une seule Location bloquante persistée", async () => {
    const [responseA, responseB] = await Promise.all([
      createLocation(adminA, { startDate: "2033-01-10", endDate: "2033-01-15" }),
      createLocation(adminA, { startDate: "2033-01-12", endDate: "2033-01-18" }),
    ]);

    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winnerResponse = responseA.status === 201 ? responseA : responseB;
    const loserResponse = responseA.status === 201 ? responseB : responseA;
    const winnerBody = await winnerResponse.json();
    const loserBody = await loserResponse.json();
    expect(Array.isArray(loserBody.conflictingLocations)).toBe(true);

    const persisted = await prisma.location.findMany({
      where: {
        vehicleId: vehicleAId,
        status: { in: ["PENDING", "CONFIRMED", "ACTIVE"] },
        startDate: { lt: new Date("2033-01-18") },
        endDate: { gt: new Date("2033-01-10") },
      },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(winnerBody.location.id);
  });

  it("Test 4 — PATCH concurrent vers une période conflictuelle et création directe sur le même véhicule : aucun chevauchement final persisté", async () => {
    // `otherLocation` démarre sur une période totalement indépendante de la cible visée par les
    // deux tentatives concurrentes ci-dessous, pour n'entrer en conflit qu'avec elles (et pas
    // avec elle-même avant sa propre modification).
    const otherResponse = await createLocation(adminA, { startDate: "2033-03-20", endDate: "2033-03-25" });
    const otherLocation = (await otherResponse.json()).location;

    const [patchResponse, createResponse] = await Promise.all([
      apiFetch(`/api/locations/${otherLocation.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ startDate: "2033-03-02", endDate: "2033-03-06" }),
      }),
      createLocation(adminA, { startDate: "2033-03-02", endDate: "2033-03-06" }),
    ]);

    const statuses = [patchResponse.status, createResponse.status].sort();
    expect(statuses).toEqual([201, 409]);

    const blocking = await prisma.location.findMany({
      where: {
        vehicleId: vehicleAId,
        status: { in: ["PENDING", "CONFIRMED", "ACTIVE"] },
        startDate: { lt: new Date("2033-03-06") },
        endDate: { gt: new Date("2033-03-02") },
      },
    });
    expect(blocking).toHaveLength(1);
  });

  it("Test 5 — non-régression séquentielle : disponibilité sans conflit, conflit existant, bornes de dates, statuts bloquants, exclusion de la Location courante en modification", async () => {
    const free = await createLocation(adminA, { startDate: "2033-02-01", endDate: "2033-02-05" });
    expect(free.status).toBe(201);

    // Conflit existant (chevauchement strict).
    const conflict = await createLocation(adminA, { startDate: "2033-02-03", endDate: "2033-02-08" });
    expect(conflict.status).toBe(409);

    // Borne de date : une reprise le jour même de la restitution n'est pas un conflit.
    const adjacent = await createLocation(adminA, { startDate: "2033-02-05", endDate: "2033-02-08" });
    expect(adjacent.status).toBe(201);
    const adjacentLocation = (await adjacent.json()).location;

    // Statuts bloquants : CANCELLED ne bloque plus la période qu'elle occupait.
    const cancelResponse = await apiFetch(`/api/locations/${adjacentLocation.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(cancelResponse.status).toBe(200);
    const afterCancel = await createLocation(adminA, { startDate: "2033-02-05", endDate: "2033-02-08" });
    expect(afterCancel.status).toBe(201);
    const afterCancelLocation = (await afterCancel.json()).location;

    // Exclusion de la Location courante lors d'une modification de ses propres dates (PATCH sur
    // elle-même) : ne doit jamais se heurter à son propre enregistrement.
    const selfPatch = await apiFetch(`/api/locations/${afterCancelLocation.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ startDate: "2033-02-05", endDate: "2033-02-09" }),
    });
    expect(selfPatch.status).toBe(200);

    // Un vrai conflit (avec `free`, toujours PENDING) reste bien détecté après ce changement.
    const realConflict = await apiFetch(`/api/locations/${afterCancelLocation.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ startDate: "2033-02-01", endDate: "2033-02-03" }),
    });
    expect(realConflict.status).toBe(409);
  });

  it("Isolation tenant — lockVehicleForUpdate ne verrouille jamais un véhicule d'un autre tenant", async () => {
    const { lockVehicleForUpdate } = await import("@/lib/vehicles");
    const result = await prisma.$transaction((tx) => lockVehicleForUpdate(adminB.tenantId, vehicleAId, tx));
    expect(result).toBeNull();
  });

  it("Isolation tenant — POST /api/locations refuse un véhicule d'un autre tenant (404, avant toute tentative de verrou)", async () => {
    const response = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({
        vehicleId: vehicleAId,
        clientId: clientBId,
        startDate: "2033-04-01",
        endDate: "2033-04-03",
      }),
    });
    expect(response.status).toBe(404);
  });

  it("Rollback — un échec après acquisition du verrou (MissingPriceError) ne laisse aucune Location partiellement persistée", async () => {
    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId: agencyA1Id,
        name: "Sans prix Finding C",
        licensePlate: `LOC-S26C-NOPRICE-${runId}`,
        make: "Renault",
        model: "Clio",
        year: 2022,
        category: "Citadine",
        chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
        color: "Blanc",
        doors: 5,
        seats: 5,
        horsepower: 6,
        powerKW: 75,
        engineSize: 1.5,
      }),
    });
    const noPriceVehicleId = (await vehicleResponse.json()).vehicle.id;

    const response = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId: noPriceVehicleId,
        clientId: clientAId,
        startDate: "2033-05-01",
        endDate: "2033-05-03",
      }),
    });
    expect(response.status).toBe(400);

    const persisted = await prisma.location.findMany({ where: { vehicleId: noPriceVehicleId } });
    expect(persisted).toHaveLength(0);
  });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  // Sprint 23 — les tests d'annulation admin avec réversibilité créent des Payment/CashEntry
  // réels (voir createLocationWithPayment ci-dessous), à purger avant Payment/Location.
  await prisma.cashEntry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashRegister.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.payment.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("POST /api/locations", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/locations", {
      method: "POST",
      body: JSON.stringify({ vehicleId: vehicleAId, clientId: clientAId }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse une date de fin antérieure ou égale à la date de début", async () => {
    const response = await createLocation(adminA, { startDate: "2028-02-05", endDate: "2028-02-05" });
    expect(response.status).toBe(400);
  });

  it("refuse un véhicule d'un autre tenant (isolation multi-tenant)", async () => {
    const response = await createLocation(adminA, { vehicleId: vehicleBId });
    expect(response.status).toBe(404);
  });

  it("refuse un client d'un autre tenant (isolation multi-tenant)", async () => {
    const response = await createLocation(adminA, { clientId: clientBId });
    expect(response.status).toBe(404);
  });

  it("crée la location, calcule totalPrice = pricePerDay × jours et fixe le statut PENDING par défaut", async () => {
    const response = await createLocation(adminA, {
      startDate: "2028-01-10",
      endDate: "2028-01-13",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.status).toBe("PENDING");
    expect(body.location.pricePerDay).toBe(5000);
    expect(body.location.totalPrice).toBe(15000); // 3 jours × 5000
    expect(body.location.currency).toBe("MAD");
  });

  it("un pricePerDay explicite prime sur le prix informatif du véhicule (Sprint 14A)", async () => {
    const response = await createLocation(adminA, {
      startDate: "2028-01-20",
      endDate: "2028-01-22",
      pricePerDay: 8000,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.pricePerDay).toBe(8000);
    expect(body.location.totalPrice).toBe(16000); // 2 jours × 8000
  });

  // Sprint 24-1 : NewLocationForm.tsx préremplit désormais startOdometer/startFuelLevel depuis
  // GET /api/vehicles/[id]/last-known-state (comportement client, non testable ici) — ce test
  // couvre la seule partie serveur concernée : startFuelLevel accepté et persisté à la création,
  // déjà supporté par l'API depuis le Sprint 23 mais jusqu'ici non couvert par un test dédié.
  it("accepte et persiste startFuelLevel à la création (Sprint 23, non testé jusqu'ici)", async () => {
    const response = await createLocation(adminA, {
      startDate: "2028-01-25",
      endDate: "2028-01-27",
      startOdometer: 15000,
      startFuelLevel: 75,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.startOdometer).toBe(15000);
    expect(body.location.startFuelLevel).toBe(75);
  });

  describe("véhicule sans pricePerDay (Sprint 14A, prix optionnel)", () => {
    let vehicleNoPriceId: string;

    beforeAll(async () => {
      const response = await apiFetch("/api/vehicles", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({
          agencyId: agencyA1Id,
          name: "Sans prix",
          licensePlate: `LOC-NOPRICE-${runId}`,
          make: "Dacia",
          model: "Sandero",
          year: 2023,
          category: "Citadine",
          chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
          color: "Blanc",
          doors: 5,
          seats: 5,
          horsepower: 6,
          powerKW: 75,
          engineSize: 1.5,
        }),
      });
      vehicleNoPriceId = (await response.json()).vehicle.id;
    });

    it("crée la location si un pricePerDay explicite est fourni", async () => {
      const response = await createLocation(adminA, {
        vehicleId: vehicleNoPriceId,
        startDate: "2028-01-24",
        endDate: "2028-01-26",
        pricePerDay: 3000,
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.location.pricePerDay).toBe(3000);
      expect(body.location.totalPrice).toBe(6000); // 2 jours × 3000
    });

    it("refuse (400) sans pricePerDay explicite ni prix véhicule", async () => {
      const response = await createLocation(adminA, {
        vehicleId: vehicleNoPriceId,
        startDate: "2028-01-27",
        endDate: "2028-01-29",
      });
      expect(response.status).toBe(400);
    });
  });

  it("refuse une location en conflit avec une location existante sur le même véhicule", async () => {
    const first = await createLocation(adminA, { startDate: "2028-05-01", endDate: "2028-05-05" });
    expect(first.status).toBe(201);

    const conflicting = await createLocation(adminA, {
      startDate: "2028-05-03",
      endDate: "2028-05-08",
    });
    expect(conflicting.status).toBe(409);
    const body = await conflicting.json();
    expect(body.conflictingLocations).toHaveLength(1);
  });

  it("accepte une location adjacente (pas de chevauchement) sur le même véhicule", async () => {
    const response = await createLocation(adminA, { startDate: "2028-05-05", endDate: "2028-05-08" });
    expect(response.status).toBe(201);
  });

  it("refuse un MEMBER non rattaché à l'agence du véhicule", async () => {
    const response = await createLocation(memberA as unknown as AuthenticatedTestUser, {
      startDate: "2028-06-01",
      endDate: "2028-06-03",
    });
    expect(response.status).toBe(403);
  });

  it("persiste startOdometer/endOdometer/deposit (Sprint 12A)", async () => {
    const response = await createLocation(adminA, {
      startDate: "2029-01-15",
      endDate: "2029-01-17",
      startOdometer: 12000,
      endOdometer: 12250,
      deposit: 300000,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.startOdometer).toBe(12000);
    expect(body.location.endOdometer).toBe(12250);
    expect(body.location.deposit).toBe(300000);
  });

  it("refuse un kilométrage négatif", async () => {
    const response = await createLocation(adminA, {
      startDate: "2029-01-20",
      endDate: "2029-01-22",
      startOdometer: -10,
    });
    expect(response.status).toBe(400);
  });

  it("arrondit le nombre de jours au jour supérieur en tenant compte de l'heure (dépassement = jour supplémentaire)", async () => {
    // Départ 10/02 10:00, retour 12/02 11:00 → 2 jours + 1h de dépassement → 3 jours facturés.
    const response = await createLocation(adminA, {
      startDate: "2029-02-10T10:00:00.000Z",
      endDate: "2029-02-12T11:00:00.000Z",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.totalPrice).toBe(15000); // 3 jours × 5000
  });

  it("n'arrondit pas à un jour de plus pour un retour légèrement anticipé", async () => {
    // Départ 10/03 10:00, retour 12/03 09:59 → toujours 2 jours (pas de dépassement).
    const response = await createLocation(adminA, {
      startDate: "2029-03-10T10:00:00.000Z",
      endDate: "2029-03-12T09:59:00.000Z",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.totalPrice).toBe(10000); // 2 jours × 5000
  });
});

describe("GET /api/locations", () => {
  it("liste uniquement les locations du tenant connecté (isolation multi-tenant)", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-07-01",
      endDate: "2028-07-03",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch("/api/locations", { headers: { Cookie: adminA.sessionCookie } });
    const body = await response.json();
    const ids: string[] = body.locations.map((l: { id: string }) => l.id);
    expect(ids).toContain(locationId);

    const otherTenantResponse = await apiFetch("/api/locations", {
      headers: { Cookie: adminB.sessionCookie },
    });
    const otherBody = await otherTenantResponse.json();
    const otherIds: string[] = otherBody.locations.map((l: { id: string }) => l.id);
    expect(otherIds).not.toContain(locationId);
  });

  it("filtre par statut", async () => {
    const response = await apiFetch("/api/locations?status=PENDING", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.locations.every((l: { status: string }) => l.status === "PENDING")).toBe(true);
  });
});

describe("PATCH /api/locations/[id]", () => {
  it("retourne 404 pour une location d'un autre tenant", async () => {
    const otherLocationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({
        vehicleId: vehicleBId,
        clientId: clientBId,
        startDate: "2028-08-01",
        endDate: "2028-08-03",
      }),
    });
    const otherLocationId = (await otherLocationResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${otherLocationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(response.status).toBe(404);
  });

  it("autorise la transition PENDING → CONFIRMED", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-09-01",
      endDate: "2028-09-03",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.status).toBe("CONFIRMED");
  });

  it("refuse une transition de statut invalide (PENDING → COMPLETED) pour un MEMBER", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-09-10",
      endDate: "2028-09-13",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: linkedMemberA.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    expect(response.status).toBe(409);
  });

  it("Sprint 19 : un ADMIN peut forcer une transition de statut invalide (override, journalisé)", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-09-15",
      endDate: "2028-09-18",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).location.status).toBe("COMPLETED");

    const auditResponse = await apiFetch(
      `/api/audit?resource=Location&action=location.admin_override`,
      { headers: { Cookie: adminA.sessionCookie } }
    );
    const auditLogs = (await auditResponse.json()).logs as { resourceId: string }[];
    expect(auditLogs.some((log) => log.resourceId === locationId)).toBe(true);
  });

  it("recalcule totalPrice quand les dates changent", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-10-01",
      endDate: "2028-10-03",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ startDate: "2028-10-01", endDate: "2028-10-06" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.totalPrice).toBe(25000); // 5 jours × 5000
  });

  it("permet d'enregistrer le kilométrage de retour et la caution (Sprint 12A)", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2029-04-01",
      endDate: "2029-04-03",
      startOdometer: 50000,
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 50180 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.startOdometer).toBe(50000);
    expect(body.location.endOdometer).toBe(50180);
  });
});

describe("DELETE /api/locations/[id]", () => {
  it("supprime une location PENDING", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-11-01",
      endDate: "2028-11-03",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("refuse la suppression d'une location CONFIRMED (doit être annulée d'abord, désormais via admin-cancel — Sprint 23, DOMAINRULES.md section 39)", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-11-10",
      endDate: "2028-11-13",
    });
    const locationId = (await createResponse.json()).location.id;

    await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const deleteResponse = await apiFetch(`/api/locations/${locationId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(409);

    // Sprint 23 : un contrat déjà validé (CONFIRMED) ne peut plus être annulé via la
    // transition PATCH simple, même pour un ADMIN — seul POST .../admin-cancel le permet
    // (voir LocationCancellationRequiresAdminError, src/lib/locations.ts).
    const cancelResponse = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(cancelResponse.status).toBe(403);

    const adminCancelResponse = await apiFetch(`/api/locations/${locationId}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Annulation — pas de paiement enregistré" }),
    });
    expect(adminCancelResponse.status).toBe(200);

    // Aucun paiement n'a jamais été enregistré ici (facture restée DRAFT, amountPaid = 0) —
    // admin-cancel ne la force donc pas à CANCELLED (voir le commentaire dans
    // adminCancelValidatedLocation), la suppression reste donc possible ensuite.
    const deleteAfterCancelResponse = await apiFetch(`/api/locations/${locationId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteAfterCancelResponse.status).toBe(200);
  });
});

describe("Sprint 14B — numérotation de contrat", () => {
  it("génère un numéro de contrat séquentiel à la création", async () => {
    const first = await createLocation(adminA, { startDate: "2029-05-01", endDate: "2029-05-03" });
    const firstBody = await first.json();
    const second = await createLocation(adminA, { startDate: "2029-05-05", endDate: "2029-05-07" });
    const secondBody = await second.json();

    expect(firstBody.location.contractNumber).toBeTruthy();
    expect(secondBody.location.contractNumber).toBeTruthy();

    const firstN = Number(firstBody.location.contractNumber.split("-").pop());
    const secondN = Number(secondBody.location.contractNumber.split("-").pop());
    expect(secondN).toBe(firstN + 1);
  });

  it("respecte le préfixe et le dernier numéro configurés dans les paramètres de l'agence (Sprint 15 — numérotation déplacée vers Agency)", async () => {
    await apiFetch(`/api/agencies/${agencyA1Id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ contractNumberPrefix: "RAK", lastContractNumber: 120 }),
    });

    const response = await createLocation(adminA, { startDate: "2029-06-01", endDate: "2029-06-03" });
    const body = await response.json();
    expect(body.location.contractNumber).toBe("RAK-00121");
  });

  it("réessaie avec le numéro suivant en cas de collision (redéfinition manuelle en arrière)", async () => {
    const first = await createLocation(adminA, { startDate: "2029-07-01", endDate: "2029-07-03" });
    const firstBody = await first.json();
    const firstN = Number(firstBody.location.contractNumber.split("-").pop());

    // Rembobine volontairement le compteur pour forcer une collision sur le prochain numéro
    // (Sprint 15 — la numérotation est désormais portée par Agency, pas Tenant).
    await apiFetch(`/api/agencies/${agencyA1Id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ lastContractNumber: firstN - 1 }),
    });

    const second = await createLocation(adminA, { startDate: "2029-07-10", endDate: "2029-07-12" });
    expect(second.status).toBe(201);
    const secondBody = await second.json();
    expect(secondBody.location.contractNumber).not.toBe(firstBody.location.contractNumber);
    // Le contrat existant n'a pas été affecté par la collision.
    const existing = await prisma.location.findUnique({ where: { id: firstBody.location.id } });
    expect(existing?.contractNumber).toBe(firstBody.location.contractNumber);
  });

  it("verrouille les dates une fois le contrat sorti de PENDING (CONFIRMED) pour un MEMBER", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2029-08-01", endDate: "2029-08-03" });
    const locationId = (await createResponse.json()).location.id;

    await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: linkedMemberA.sessionCookie },
      body: JSON.stringify({ startDate: "2029-08-02", endDate: "2029-08-04" }),
    });
    expect(response.status).toBe(409);

    // Le statut, lui, reste modifiable (seules les dates sont verrouillées).
    const notesResponse = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: linkedMemberA.sessionCookie },
      body: JSON.stringify({ notes: "toujours modifiable" }),
    });
    expect(notesResponse.status).toBe(200);
  });

  it("Sprint 19 : un ADMIN peut modifier les dates d'un contrat verrouillé (override, journalisé)", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2029-08-10", endDate: "2029-08-12" });
    const locationId = (await createResponse.json()).location.id;

    await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ startDate: "2029-08-11", endDate: "2029-08-13" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.startDate).toContain("2029-08-11");

    const auditResponse = await apiFetch(
      `/api/audit?resource=Location&action=location.admin_override`,
      { headers: { Cookie: adminA.sessionCookie } }
    );
    const auditLogs = (await auditResponse.json()).logs as { resourceId: string }[];
    expect(auditLogs.some((log) => log.resourceId === locationId)).toBe(true);
  });

  it("permet toujours de modifier les dates tant que le contrat est PENDING", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2029-09-01", endDate: "2029-09-03" });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ startDate: "2029-09-01", endDate: "2029-09-05" }),
    });
    expect(response.status).toBe(200);
  });
});

describe("GET /api/locations/[id]/pdf", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/locations/nonexistent/pdf");
    expect(response.status).toBe(401);
  });

  it("génère le PDF du contrat pour un contrat numéroté", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2029-10-01", endDate: "2029-10-03" });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}/pdf`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });

  it("refuse un contrat sans numéro (créé avant la numérotation)", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2029-10-10", endDate: "2029-10-12" });
    const locationId = (await createResponse.json()).location.id;
    await prisma.location.update({ where: { id: locationId }, data: { contractNumber: null } });

    const response = await apiFetch(`/api/locations/${locationId}/pdf`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });

  it("refuse l'accès à un contrat d'un autre tenant", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2029-10-15", endDate: "2029-10-17" });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}/pdf`, {
      headers: { Cookie: adminB.sessionCookie },
    });
    expect(response.status).toBe(404);
  });
});

describe("Sprint 15 — permissions granulaires (locations.create)", () => {
  it("refuse un MEMBER rattaché à l'agence mais dont le groupe personnalisé n'a pas locations.create", async () => {
    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoLocationCreate-${runId}`, permissions: ["locations.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Member",
      email: `restricted-locations-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: restrictedMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const response = await createLocation(restrictedMember, { startDate: "2029-11-01", endDate: "2029-11-03" });
    expect(response.status).toBe(403);
  });

  it("autorise un MEMBER dont le groupe personnalisé accorde locations.create", async () => {
    const grantedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `WithLocationCreate-${runId}`, permissions: ["locations.view", "locations.create"] }),
    });
    const grantedGroupId = (await grantedGroupResponse.json()).group.id;

    const grantedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Granted Member",
      email: `granted-locations-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: grantedMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${grantedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: grantedGroupId }),
    });

    const response = await createLocation(grantedMember, { startDate: "2029-11-05", endDate: "2029-11-07" });
    expect(response.status).toBe(201);
  });

  it("un ADMIN crée une location même rattaché à un groupe personnalisé vide (bypass systématique)", async () => {
    const emptyGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `EmptyAdminGroup-${runId}`, permissions: [] }),
    });
    const emptyGroupId = (await emptyGroupResponse.json()).group.id;

    await apiFetch(`/api/users/${adminA.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: emptyGroupId }),
    });

    try {
      const response = await createLocation(adminA, { startDate: "2029-11-10", endDate: "2029-11-12" });
      expect(response.status).toBe(201);
    } finally {
      await apiFetch(`/api/users/${adminA.userId}/permissions`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ permissionGroupId: null }),
      });
    }
  });
});

describe("Sprint 24 — locations.confirm/activate/complete/cancel séparées de locations.edit", () => {
  async function createGroupAndMember(name: string, permissions: string[]) {
    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `${name}-${runId}`, permissions }),
    });
    const groupId = (await groupResponse.json()).group.id;

    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name,
      email: `${name.toLowerCase()}-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${member.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: groupId }),
    });
    return member;
  }

  it("locations.edit seul ne permet plus de confirmer, activer, terminer ni annuler", async () => {
    const editOnly = await createGroupAndMember("LocEditOnly", ["locations.view", "locations.edit"]);

    const createResponse = await createLocation(adminA, { startDate: "2029-12-01", endDate: "2029-12-03" });
    const location = (await createResponse.json()).location;

    for (const status of ["CONFIRMED", "CANCELLED"]) {
      const response = await apiFetch(`/api/locations/${location.id}`, {
        method: "PATCH",
        headers: { Cookie: editOnly.sessionCookie },
        body: JSON.stringify({ status }),
      });
      expect(response.status).toBe(403);
    }

    // Un champ générique (notes) reste autorisé avec locations.edit seul.
    const notesResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: editOnly.sessionCookie },
      body: JSON.stringify({ notes: "Note ajoutée par LocEditOnly" }),
    });
    expect(notesResponse.status).toBe(200);
  });

  it("locations.confirm seul confirme, sans locations.edit", async () => {
    const confirmOnly = await createGroupAndMember("LocConfirmOnly", ["locations.view", "locations.confirm"]);

    const createResponse = await createLocation(adminA, { startDate: "2029-12-05", endDate: "2029-12-07" });
    const location = (await createResponse.json()).location;

    const confirmResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: confirmOnly.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(confirmResponse.status).toBe(200);
    expect((await confirmResponse.json()).location.status).toBe("CONFIRMED");

    const notesResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: confirmOnly.sessionCookie },
      body: JSON.stringify({ notes: "Tentative" }),
    });
    expect(notesResponse.status).toBe(403);
  });

  it("locations.activate seul active (CONFIRMED → ACTIVE), sans locations.edit", async () => {
    const activateOnly = await createGroupAndMember("LocActivateOnly", ["locations.view", "locations.activate"]);

    const createResponse = await createLocation(adminA, { startDate: "2029-12-08", endDate: "2029-12-10" });
    const location = (await createResponse.json()).location;
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const activateResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: activateOnly.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });
    expect(activateResponse.status).toBe(200);
    expect((await activateResponse.json()).location.status).toBe("ACTIVE");
  });

  it("locations.complete seul termine (→ COMPLETED), sans locations.edit", async () => {
    const completeOnly = await createGroupAndMember("LocCompleteOnly", ["locations.view", "locations.complete"]);

    const createResponse = await createLocation(adminA, { startDate: "2029-12-11", endDate: "2029-12-13" });
    const location = (await createResponse.json()).location;
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    const completeResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: completeOnly.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    expect(completeResponse.status).toBe(200);
    expect((await completeResponse.json()).location.status).toBe("COMPLETED");
  });

  it("locations.cancel seul annule un contrat PENDING, sans locations.edit", async () => {
    const cancelOnly = await createGroupAndMember("LocCancelOnly", ["locations.view", "locations.cancel"]);

    const createResponse = await createLocation(adminA, { startDate: "2029-12-15", endDate: "2029-12-17" });
    const location = (await createResponse.json()).location;

    const cancelResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: cancelOnly.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(cancelResponse.status).toBe(200);
    expect((await cancelResponse.json()).location.status).toBe("CANCELLED");
  });

  it("un ADMIN (super admin du tenant) confirme/active/termine/annule sans aucun groupe de permissions", async () => {
    const progressResponse = await createLocation(adminA, { startDate: "2029-12-20", endDate: "2029-12-22" });
    const progress = (await progressResponse.json()).location;

    const confirmResponse = await apiFetch(`/api/locations/${progress.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(confirmResponse.status).toBe(200);

    const activateResponse = await apiFetch(`/api/locations/${progress.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });
    expect(activateResponse.status).toBe(200);

    const completeResponse = await apiFetch(`/api/locations/${progress.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    expect(completeResponse.status).toBe(200);

    const cancelTargetResponse = await createLocation(adminA, { startDate: "2029-12-23", endDate: "2029-12-25" });
    const cancelTarget = (await cancelTargetResponse.json()).location;
    const cancelResponse = await apiFetch(`/api/locations/${cancelTarget.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(cancelResponse.status).toBe(200);
  });
});
