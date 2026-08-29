import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import {
  RESERVATION_IMPORT_COLUMNS,
  RESERVATION_IMPORT_COLUMN_MAP,
  claimReservationConversion,
  markReservationConverted,
} from "@/lib/reservations";
import { createClient } from "@/lib/clients";
import { createLocation } from "@/lib/locations";
import { createInvoice, updateInvoice } from "@/lib/invoices";
import { createPayment, PaymentExceedsRemainingBalanceError } from "@/lib/payments";
import { apiFetch } from "./helpers/http";
import { TEST_BASE_URL } from "./helpers/testServer";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let agencyA1Id: string;
let vehicleAId: string; // pricePerDay = 5000 (50,00 MAD), status AVAILABLE
let clientAPhone: string;

async function createReservation(admin: AuthenticatedTestUser, overrides: Record<string, unknown> = {}) {
  return apiFetch("/api/reservations", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      voucherNumber: `V-${runId}-${Math.random().toString(36).slice(2, 8)}`,
      clientFirstName: "Jean",
      clientLastName: "Testeur",
      startDate: "2030-06-01",
      endDate: "2030-06-03",
      ...overrides,
    }),
  });
}

async function importReservationsFile(
  admin: AuthenticatedTestUser,
  rows: unknown[][],
  mode: "preview" | "commit" = "commit"
) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Reservations");
  worksheet.addRow([...RESERVATION_IMPORT_COLUMNS]);
  for (const row of rows) {
    worksheet.addRow(row);
  }
  const buffer = await workbook.xlsx.writeBuffer();

  const formData = new FormData();
  formData.append("file", new File([buffer], "reservations.xlsx"));
  formData.append("mode", mode);

  return fetch(`${TEST_BASE_URL}/api/reservations/import`, {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: formData,
  });
}

/** Construit une ligne d'import (en-têtes français, RESERVATION_IMPORT_COLUMNS) à partir de
 * valeurs indexées par nom de CHAMP interne (ex. "voucherNumber") — plus lisible dans les
 * tests que l'en-tête français exact. */
function importRow(values: Partial<Record<string, unknown>>): unknown[] {
  return RESERVATION_IMPORT_COLUMNS.map((column) => {
    const field = (RESERVATION_IMPORT_COLUMN_MAP as Record<string, string>)[column];
    return values[field] ?? null;
  });
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Reservations Test A",
    tenantSlug: `reservations-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Reservations Test B",
    tenantSlug: `reservations-test-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminB.tenantId);

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A1", slug: `agence-a1-${runId}` }),
  });
  agencyA1Id = (await agencyResponse.json()).agency.id;

  const vehicleResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      agencyId: agencyA1Id,
      name: "Clio",
      licensePlate: `RES-A-${runId}`,
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
  vehicleAId = (await vehicleResponse.json()).vehicle.id;

  clientAPhone = `+21261${runId.slice(-7)}`;
  await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Client Existant", phone: clientAPhone }),
  });
});

describe("Sprint 23 — statut NO_SHOW et réinitialisation à zéro réservée ADMIN (DOMAINRULES.md section 39)", () => {
  it("autorise PENDING → NO_SHOW et CONFIRMED → NO_SHOW", async () => {
    const pendingResponse = await createReservation(adminA);
    const pendingId = (await pendingResponse.json()).reservation.id;
    const patchPending = await apiFetch(`/api/reservations/${pendingId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "NO_SHOW" }),
    });
    expect(patchPending.status).toBe(200);
    expect((await patchPending.json()).reservation.status).toBe("NO_SHOW");

    const confirmedResponse = await createReservation(adminA);
    const confirmedId = (await confirmedResponse.json()).reservation.id;
    await apiFetch(`/api/reservations/${confirmedId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    const patchConfirmed = await apiFetch(`/api/reservations/${confirmedId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "NO_SHOW" }),
    });
    expect(patchConfirmed.status).toBe(200);
  });

  it("NO_SHOW est terminal — un PATCH ultérieur (hors notes) est refusé (409, ReservationLockedError)", async () => {
    const createResponse = await createReservation(adminA);
    const id = (await createResponse.json()).reservation.id;
    await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "NO_SHOW" }),
    });

    const patchResponse = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ clientFirstName: "Autre" }),
    });
    expect(patchResponse.status).toBe(409);
  });

  it("POST .../reset refusé (403) pour un non-ADMIN", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Member Reset Test",
      email: `member-reset-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    const createResponse = await createReservation(adminA);
    const id = (await createResponse.json()).reservation.id;
    await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });

    const resetResponse = await apiFetch(`/api/reservations/${id}/reset`, {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
    });
    expect(resetResponse.status).toBe(403);
  });

  it("POST .../reset réinitialise une réservation NO_SHOW/CANCELLED à PENDING pour un ADMIN", async () => {
    const createResponse = await createReservation(adminA);
    const id = (await createResponse.json()).reservation.id;
    await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "NO_SHOW" }),
    });

    const resetResponse = await apiFetch(`/api/reservations/${id}/reset`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(resetResponse.status).toBe(200);
    expect((await resetResponse.json()).reservation.status).toBe("PENDING");
  });

  it("POST .../reset sur une réservation CONVERTED est refusé (409) tant que le contrat lié n'est pas annulé", async () => {
    const createResponse = await createReservation(adminA, {
      pickupAgency: "Agence A1",
      dropoffAgency: "Agence A1",
    });
    const id = (await createResponse.json()).reservation.id;

    const clientResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: `Client Convert ${runId}`,
        phone: `+21262${runId.slice(-7)}`,
        licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01",
      }),
    });
    const clientId = (await clientResponse.json()).client.id;

    const convertResponse = await apiFetch(`/api/reservations/${id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId: vehicleAId,
        startDate: "2030-06-01T10:00:00.000Z",
        endDate: "2030-06-03T10:00:00.000Z",
        useExistingClientId: clientId,
        // Correctif F-3 (second passage, DOMAINRULES.md section 68) : startOdometer requis.
        startOdometer: 10000,
        payment: { deferred: true },
      }),
    });
    expect(convertResponse.status).toBe(201);

    const resetResponse = await apiFetch(`/api/reservations/${id}/reset`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(resetResponse.status).toBe(409);
  });

  it("deux actions rapides concurrentes (Annuler + No Show) sur la même réservation — une seule réussit (409 pour l'autre)", async () => {
    const createResponse = await createReservation(adminA);
    const id = (await createResponse.json()).reservation.id;

    const [cancelResponse, noShowResponse] = await Promise.all([
      apiFetch(`/api/reservations/${id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ status: "CANCELLED" }),
      }),
      apiFetch(`/api/reservations/${id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ status: "NO_SHOW" }),
      }),
    ]);

    const statuses = [cancelResponse.status, noShowResponse.status].sort();
    expect(statuses).toEqual([200, 409]);

    const finalReservation = await prisma.reservation.findUnique({ where: { id } });
    expect(["CANCELLED", "NO_SHOW"]).toContain(finalReservation?.status);
  });
});

afterAll(async () => {
  await prisma.reservation.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashEntry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashRegister.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.payment.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  // Campagne QA (2026-08-27) : LocationUpgrade a une contrainte de clé étrangère réelle vers
  // Location (ON DELETE RESTRICT, comme Payment/Invoice) — doit être supprimée avant, sinon la
  // suppression de Location ci-dessous échoue.
  await prisma.locationUpgrade.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("POST /api/reservations", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/reservations", { method: "POST", body: JSON.stringify({}) });
    expect(response.status).toBe(401);
  });

  it("refuse les champs requis manquants", async () => {
    const response = await apiFetch("/api/reservations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ voucherNumber: "V-1" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse endDate antérieure à startDate", async () => {
    const response = await createReservation(adminA, { startDate: "2030-06-05", endDate: "2030-06-01" });
    expect(response.status).toBe(400);
  });

  it("refuse clientFirstName/clientLastName composés uniquement d'espaces (campagne QA partie 2, BUG-008)", async () => {
    // Même défaut qu'INC-9 (BUG-006) sur Client : une chaîne "   " est truthy en JavaScript,
    // donc jamais interceptée par un simple `!champ` — vérifié empiriquement avant correctif
    // (POST acceptait 201 avec clientFirstName/clientLastName = "   " persistés tels quels).
    const responseFirstName = await createReservation(adminA, { clientFirstName: "   " });
    expect(responseFirstName.status).toBe(400);

    const responseLastName = await createReservation(adminA, { clientLastName: "   " });
    expect(responseLastName.status).toBe(400);
  });

  it("refuse un voucherNumber composé uniquement d'espaces pour une source BROKER, régénère pour DIRECT", async () => {
    const brokerResponse = await createReservation(adminA, { source: "BROKER", voucherNumber: "   " });
    expect(brokerResponse.status).toBe(400);

    const directResponse = await createReservation(adminA, { source: "DIRECT", voucherNumber: "   " });
    expect(directResponse.status).toBe(201);
    const body = await directResponse.json();
    expect(body.reservation.voucherNumber).toMatch(/^Dir-\d{4}$/);
  });

  it("crée la réservation avec le statut PENDING et la devise MAD par défaut", async () => {
    const response = await createReservation(adminA, { totalPrice: 15000, pricePerDay: 5000 });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.reservation.status).toBe("PENDING");
    expect(body.reservation.currency).toBe("MAD");
    expect(body.reservation.totalPrice).toBe(15000);
  });

  it("accepte n'importe quelle chaîne non vide pour source, texte libre (Sprint 15)", async () => {
    // Sprint 15 : source n'est plus un enum fermé BROKER/DIRECT — un code broker réel
    // (TJS, DCH, CT...) doit être accepté et stocké tel quel, casse comprise, plutôt que
    // silencieusement réduit à undefined (voir normalizeSource, src/lib/reservations.ts).
    for (const source of ["TJS", "DCH", "CT", "tjs"]) {
      const response = await createReservation(adminA, { source });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.reservation.source).toBe(source);
    }
  });

  it("optionsCurrency vaut MAD par défaut si omis à la création (Sprint 15)", async () => {
    const response = await createReservation(adminA);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.reservation.optionsCurrency).toBe("MAD");
  });

  it("currency et optionsCurrency persistent indépendamment (Sprint 15, ex. total en EUR / options en MAD)", async () => {
    const createResponse = await createReservation(adminA, {
      currency: "EUR",
      optionsCurrency: "MAD",
      totalPrice: 20000,
      gpsPrice: 500,
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()).reservation;
    expect(created.currency).toBe("EUR");
    expect(created.optionsCurrency).toBe("MAD");

    const getResponse = await apiFetch(`/api/reservations/${created.id}`, { headers: { Cookie: adminA.sessionCookie } });
    const fetched = (await getResponse.json()).reservation;
    expect(fetched.currency).toBe("EUR");
    expect(fetched.optionsCurrency).toBe("MAD");

    const patchResponse = await apiFetch(`/api/reservations/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ optionsCurrency: "USD" }),
    });
    expect(patchResponse.status).toBe(200);
    const patched = (await patchResponse.json()).reservation;
    expect(patched.optionsCurrency).toBe("USD");
    expect(patched.currency).toBe("EUR"); // non touché par ce PATCH partiel

    const finalGetResponse = await apiFetch(`/api/reservations/${created.id}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const final = (await finalGetResponse.json()).reservation;
    expect(final.currency).toBe("EUR");
    expect(final.optionsCurrency).toBe("USD");
  });

  it("refuse l'absence de voucherNumber pour une source BROKER (Sprint 13C)", async () => {
    const response = await apiFetch("/api/reservations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        source: "BROKER",
        clientFirstName: "Jean",
        clientLastName: "Testeur",
        startDate: "2030-06-01",
        endDate: "2030-06-03",
      }),
    });
    expect(response.status).toBe(400);
  });

  it("génère automatiquement un voucherNumber Dir-0001, Dir-0002... pour une source DIRECT (Sprint 13C)", async () => {
    const directTenant = await registerTenantAdmin({
      tenantName: "Reservations Direct Voucher",
      tenantSlug: `reservations-direct-voucher-${runId}`,
      name: "Admin Direct",
      email: `admin-direct-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    createdTenantIds.push(directTenant.tenantId);

    const first = await apiFetch("/api/reservations", {
      method: "POST",
      headers: { Cookie: directTenant.sessionCookie },
      body: JSON.stringify({
        source: "DIRECT",
        clientFirstName: "Jean",
        clientLastName: "Testeur",
        startDate: "2030-06-01",
        endDate: "2030-06-03",
      }),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.reservation.voucherNumber).toBe("Dir-0001");

    const second = await apiFetch("/api/reservations", {
      method: "POST",
      headers: { Cookie: directTenant.sessionCookie },
      body: JSON.stringify({
        source: "DIRECT",
        clientFirstName: "Paul",
        clientLastName: "Testeur",
        startDate: "2030-06-01",
        endDate: "2030-06-03",
      }),
    });
    expect(second.status).toBe(201);
    const secondBody = await second.json();
    expect(secondBody.reservation.voucherNumber).toBe("Dir-0002");
  });

  it("respecte un voucherNumber DIRECT saisi manuellement plutôt que de le régénérer", async () => {
    const response = await createReservation(adminA, { source: "DIRECT", voucherNumber: `Manual-${runId}` });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.reservation.voucherNumber).toBe(`Manual-${runId}`);
  });

  it("accepte une ville de départ/retour correspondant à une agence réelle (Sprint 14A)", async () => {
    const response = await createReservation(adminA, {
      pickupAgency: "Agence A1",
      dropoffAgency: "agence a1",
    });
    expect(response.status).toBe(201);
  });

  it("refuse une ville de départ ne correspondant à aucune agence du tenant (Sprint 14A)", async () => {
    const response = await createReservation(adminA, { pickupAgency: "Ville Inexistante" });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Ville de départ inconnue");
  });

  it("refuse une ville de retour ne correspondant à aucune agence du tenant (Sprint 14A)", async () => {
    const response = await createReservation(adminA, {
      pickupAgency: "Agence A1",
      dropoffAgency: "Ville Inexistante",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Ville de retour inconnue");
  });
});

describe("GET /api/reservations", () => {
  it("liste uniquement les réservations du tenant connecté (isolation multi-tenant)", async () => {
    const createResponse = await createReservation(adminA);
    const reservationId = (await createResponse.json()).reservation.id;

    const response = await apiFetch("/api/reservations", { headers: { Cookie: adminA.sessionCookie } });
    const body = await response.json();
    const ids: string[] = body.reservations.map((r: { id: string }) => r.id);
    expect(ids).toContain(reservationId);

    const otherTenantResponse = await apiFetch("/api/reservations", { headers: { Cookie: adminB.sessionCookie } });
    const otherIds: string[] = (await otherTenantResponse.json()).reservations.map((r: { id: string }) => r.id);
    expect(otherIds).not.toContain(reservationId);
  });

  it("filtre par statut", async () => {
    const response = await apiFetch("/api/reservations?status=PENDING", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reservations.every((r: { status: string }) => r.status === "PENDING")).toBe(true);
  });

  it("filtre par ville de départ/retour et catégorie de véhicule (Sprint 14A)", async () => {
    const voucherNumber = `V-FILTER-${runId}`;
    const created = await createReservation(adminA, {
      voucherNumber,
      pickupAgency: "Agence A1",
      dropoffAgency: "Agence A1",
      vehicleCategory: "SUV-Filtre",
    });
    expect(created.status).toBe(201);

    const matching = await apiFetch(
      `/api/reservations?pickupAgency=${encodeURIComponent("agence a1")}&vehicleCategory=${encodeURIComponent("suv-filtre")}`,
      { headers: { Cookie: adminA.sessionCookie } }
    );
    const matchingIds: string[] = (await matching.json()).reservations.map((r: { voucherNumber: string }) => r.voucherNumber);
    expect(matchingIds).toContain(voucherNumber);

    const nonMatching = await apiFetch(`/api/reservations?vehicleCategory=${encodeURIComponent("Citadine-Introuvable")}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const nonMatchingIds: string[] = (await nonMatching.json()).reservations.map(
      (r: { voucherNumber: string }) => r.voucherNumber
    );
    expect(nonMatchingIds).not.toContain(voucherNumber);
  });
});

describe("PATCH /api/reservations/[id]", () => {
  it("retourne 404 pour une réservation d'un autre tenant", async () => {
    const otherResponse = await createReservation(adminB);
    const otherId = (await otherResponse.json()).reservation.id;

    const response = await apiFetch(`/api/reservations/${otherId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(response.status).toBe(404);
  });

  it("autorise PENDING → CONFIRMED", async () => {
    const createResponse = await createReservation(adminA);
    const id = (await createResponse.json()).reservation.id;

    const response = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).reservation.status).toBe("CONFIRMED");
  });

  it("refuse d'effacer clientFirstName/clientLastName/voucherNumber avec une chaîne composée uniquement d'espaces (campagne QA partie 2, BUG-008)", async () => {
    // Contrairement à POST (défauts requis dès la création), PATCH n'appliquait jusqu'ici
    // aucune validation de présence sur ces champs — un agent pouvait silencieusement vider
    // le client/voucher d'une réservation existante via l'édition. Voir INCIDENTS.md.
    const createResponse = await createReservation(adminA);
    const id = (await createResponse.json()).reservation.id;

    const firstNameResponse = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ clientFirstName: "   " }),
    });
    expect(firstNameResponse.status).toBe(400);

    const lastNameResponse = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ clientLastName: "   " }),
    });
    expect(lastNameResponse.status).toBe(400);

    const voucherResponse = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ voucherNumber: "   " }),
    });
    expect(voucherResponse.status).toBe(400);

    // Aucune écriture partielle : le client/voucher d'origine doit rester intact après refus.
    const getResponse = await apiFetch(`/api/reservations/${id}`, { headers: { Cookie: adminA.sessionCookie } });
    const fetched = (await getResponse.json()).reservation;
    expect(fetched.clientFirstName).toBe("Jean");
    expect(fetched.clientLastName).toBe("Testeur");
  });

  it("refuse CONFIRMED → PENDING (transition non autorisée)", async () => {
    const createResponse = await createReservation(adminA);
    const id = (await createResponse.json()).reservation.id;
    await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const response = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "PENDING" }),
    });
    expect(response.status).toBe(409);
  });

  it("accepte une source texte libre (code broker réel) sur mise à jour (Sprint 15)", async () => {
    const createResponse = await createReservation(adminA);
    const id = (await createResponse.json()).reservation.id;

    const response = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ source: "DCH" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reservation.source).toBe("DCH");
  });

  it("efface réellement les remarques quand une chaîne vide est envoyée (Sprint 19)", async () => {
    const createResponse = await createReservation(adminA, { notes: "Remarque initiale" });
    const id = (await createResponse.json()).reservation.id;

    const cleared = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ notes: "" }),
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).reservation.notes).toBe("");
  });

  it("efface réellement la source quand une chaîne vide est envoyée (Sprint 19 — normalizeSource(\"\") ne doit pas laisser Prisma ignorer le champ)", async () => {
    const createResponse = await createReservation(adminA, { source: "DCH" });
    const id = (await createResponse.json()).reservation.id;

    const cleared = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ source: "" }),
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).reservation.source).toBeNull();
  });

  it("exige la permission reservations.edit (retrofit permissions Sprint 15)", async () => {
    // Sprint 15 : un MEMBER sans groupe assigné retombe désormais sur les permissions du
    // groupe par défaut MEMBER (qui inclut reservations.edit) — voir src/lib/permissions.ts,
    // getEffectivePermissions. Ce test doit donc utiliser un groupe personnalisé
    // explicitement vide pour vérifier un vrai refus, pas l'absence totale de groupe.
    const emptyGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Empty-ReservationsEdit-${runId}`, permissions: [] }),
    });
    const emptyGroupId = (await emptyGroupResponse.json()).group.id;

    const noPerms = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Perms Reservations",
      email: `no-perms-reservations-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await apiFetch(`/api/users/${noPerms.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: emptyGroupId }),
    });

    const createResponse = await createReservation(adminA);
    const id = (await createResponse.json()).reservation.id;

    const response = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: noPerms.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(response.status).toBe(403);
  });

  it("refuse une ville de départ/retour inconnue (Sprint 17 — même validation que POST, absente de PATCH jusqu'ici)", async () => {
    const createResponse = await createReservation(adminA);
    const id = (await createResponse.json()).reservation.id;

    const pickupResponse = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ pickupAgency: "Ville Inexistante" }),
    });
    expect(pickupResponse.status).toBe(400);
    expect((await pickupResponse.json()).error).toContain("Ville de départ inconnue");

    const dropoffResponse = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ pickupAgency: "Agence A1", dropoffAgency: "Ville Inexistante" }),
    });
    expect(dropoffResponse.status).toBe(400);
    expect((await dropoffResponse.json()).error).toContain("Ville de retour inconnue");

    const validResponse = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ pickupAgency: "Agence A1" }),
    });
    expect(validResponse.status).toBe(200);
  });

  it("verrouille une réservation CONVERTED/CANCELLED : refuse tout champ hors notes (Sprint 17)", async () => {
    const createResponse = await createReservation(adminA, { pricePerDay: 5000, totalPrice: 10000 });
    const id = (await createResponse.json()).reservation.id;
    await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });

    const blockedResponse = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ totalPrice: 1 }),
    });
    expect(blockedResponse.status).toBe(409);

    // Les notes restent modifiables même sur une réservation terminale (ReservationActions.tsx
    // les édite indépendamment du statut).
    const notesResponse = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ notes: "Note ajoutée après annulation" }),
    });
    expect(notesResponse.status).toBe(200);
    expect((await notesResponse.json()).reservation.notes).toBe("Note ajoutée après annulation");
  });

  it("efface le prix d'une option décochée plutôt que de le laisser en base (Sprint 17)", async () => {
    const createResponse = await createReservation(adminA, {
      hasGps: true,
      gpsPrice: 5000,
      optionsCurrency: "MAD",
    });
    const id = (await createResponse.json()).reservation.id;
    expect((await (await apiFetch(`/api/reservations/${id}`, { headers: { Cookie: adminA.sessionCookie } })).json()).reservation.gpsPrice).toBe(5000);

    const response = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ hasGps: false }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reservation.hasGps).toBe(false);
    expect(body.reservation.gpsPrice).toBeNull();
  });
});

describe("DELETE /api/reservations/[id]", () => {
  it("supprime une réservation PENDING", async () => {
    const createResponse = await createReservation(adminA);
    const id = (await createResponse.json()).reservation.id;

    const response = await apiFetch(`/api/reservations/${id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("refuse la suppression d'une réservation CONFIRMED (doit être annulée d'abord)", async () => {
    const createResponse = await createReservation(adminA);
    const id = (await createResponse.json()).reservation.id;
    await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const deleteResponse = await apiFetch(`/api/reservations/${id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(409);
  });

  // Suppression multiple (DOMAINRULES.md section 24, Sprint 14A) : ReservationsTable.tsx
  // n'a pas de route bulk dédiée — elle enchaîne cet endpoint DELETE/[id] par ligne
  // sélectionnée (Promise.allSettled). Ces tests valident donc directement le comportement
  // réel exercé par la sélection multiple, sans dupliquer un chemin API distinct.
  it("suppression multiple : plusieurs réservations PENDING sont toutes supprimées et journalisées individuellement", async () => {
    const ids = await Promise.all(
      [1, 2, 3].map(async () => {
        const res = await createReservation(adminA);
        return (await res.json()).reservation.id;
      })
    );

    const results = await Promise.all(
      ids.map((id) => apiFetch(`/api/reservations/${id}`, { method: "DELETE", headers: { Cookie: adminA.sessionCookie } }))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);

    for (const id of ids) {
      const getResponse = await apiFetch(`/api/reservations/${id}`, { headers: { Cookie: adminA.sessionCookie } });
      expect(getResponse.status).toBe(404);

      const audit = await prisma.auditLog.findFirst({
        where: { tenantId: adminA.tenantId, action: "reservation.deleted", resourceId: id },
      });
      expect(audit).toBeDefined();
    }
  });

  it("suppression multiple : résultat partiel — une réservation PENDING supprimée, une CONFIRMED refusée (409), aucune n'empêche l'autre", async () => {
    const deletableRes = await createReservation(adminA);
    const deletableId = (await deletableRes.json()).reservation.id;

    const blockedRes = await createReservation(adminA);
    const blockedId = (await blockedRes.json()).reservation.id;
    await apiFetch(`/api/reservations/${blockedId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const [deletableResult, blockedResult] = await Promise.all([
      apiFetch(`/api/reservations/${deletableId}`, { method: "DELETE", headers: { Cookie: adminA.sessionCookie } }),
      apiFetch(`/api/reservations/${blockedId}`, { method: "DELETE", headers: { Cookie: adminA.sessionCookie } }),
    ]);
    expect(deletableResult.status).toBe(200);
    expect(blockedResult.status).toBe(409);

    // La réservation refusée existe toujours, avec son statut inchangé.
    const stillThere = await apiFetch(`/api/reservations/${blockedId}`, { headers: { Cookie: adminA.sessionCookie } });
    expect(stillThere.status).toBe(200);
    expect((await stillThere.json()).reservation.status).toBe("CONFIRMED");
  });

  it("isolation agence : un MEMBER d'une autre agence ne peut pas supprimer une réservation via sélection multiple (404, agence de départ non accessible)", async () => {
    const otherAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Agence Isolation Bulk ${runId}`, slug: `agence-isolation-bulk-${runId}` }),
    });
    const otherAgencyId = (await otherAgencyResponse.json()).agency.id;
    const outsider = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Outsider Bulk Delete",
      email: `outsider-bulk-delete-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: outsider.userId, agencyId: otherAgencyId } });
    // Groupe AGENCE (a reservations.delete, contrairement à MEMBER par défaut) — nécessaire
    // pour que cette requête atteigne réellement la vérification d'isolation agence
    // (canEditReservationAgency) plutôt que d'échouer plus tôt sur la permission elle-même.
    const groupsResponse = await apiFetch("/api/permission-groups", { headers: { Cookie: adminA.sessionCookie } });
    const agenceGroupId = (await groupsResponse.json()).groups.find((g: { name: string }) => g.name === "AGENCE").id;
    await apiFetch(`/api/users/${outsider.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: agenceGroupId }),
    });

    const createResponse = await createReservation(adminA, { pickupAgency: "Agence A1" });
    const id = (await createResponse.json()).reservation.id;

    const deleteResponse = await apiFetch(`/api/reservations/${id}`, {
      method: "DELETE",
      headers: { Cookie: outsider.sessionCookie },
    });
    expect(deleteResponse.status).toBe(404);

    // La réservation existe toujours, visible par son agence réelle.
    const stillThere = await apiFetch(`/api/reservations/${id}`, { headers: { Cookie: adminA.sessionCookie } });
    expect(stillThere.status).toBe(200);
  });
});

describe("Sprint 19 — visibilité des réservations par agence de départ/retour (DOMAINRULES.md section 37)", () => {
  let agencyA2Id: string;
  let memberAgencyA1: AuthenticatedTestUser;
  let memberAgencyA2: AuthenticatedTestUser;

  beforeAll(async () => {
    const agencyA2Response = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence A2", slug: `agence-a2-${runId}` }),
    });
    agencyA2Id = (await agencyA2Response.json()).agency.id;

    memberAgencyA1 = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Member Agency A1",
      email: `member-agency-a1-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: memberAgencyA1.userId, agencyId: agencyA1Id } });

    memberAgencyA2 = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Member Agency A2",
      email: `member-agency-a2-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: memberAgencyA2.userId, agencyId: agencyA2Id } });
  });

  it("un MEMBER voit une réservation dont l'agence de départ lui est accessible", async () => {
    const createResponse = await createReservation(adminA, { pickupAgency: "Agence A1" });
    const id = (await createResponse.json()).reservation.id;

    const response = await apiFetch(`/api/reservations/${id}`, { headers: { Cookie: memberAgencyA1.sessionCookie } });
    expect(response.status).toBe(200);
  });

  it("un MEMBER ne voit pas une réservation dont ni l'agence de départ ni de retour ne lui sont accessibles", async () => {
    const createResponse = await createReservation(adminA, { pickupAgency: "Agence A1" });
    const id = (await createResponse.json()).reservation.id;

    const response = await apiFetch(`/api/reservations/${id}`, { headers: { Cookie: memberAgencyA2.sessionCookie } });
    expect(response.status).toBe(404);
  });

  it("un MEMBER voit une réservation via l'agence de retour même sans accès à l'agence de départ", async () => {
    const createResponse = await createReservation(adminA, { pickupAgency: "Agence A1", dropoffAgency: "Agence A2" });
    const id = (await createResponse.json()).reservation.id;

    const response = await apiFetch(`/api/reservations/${id}`, { headers: { Cookie: memberAgencyA2.sessionCookie } });
    expect(response.status).toBe(200);
  });

  it("seule l'agence de départ peut modifier une réservation — l'agence de retour reçoit 403", async () => {
    const createResponse = await createReservation(adminA, {
      pickupAgency: "Agence A1",
      dropoffAgency: "Agence A2",
      status: "CONFIRMED",
    });
    const id = (await createResponse.json()).reservation.id;

    const patchResponse = await apiFetch(`/api/reservations/${id}`, {
      method: "PATCH",
      headers: { Cookie: memberAgencyA2.sessionCookie },
      body: JSON.stringify({ notes: "tentative" }),
    });
    expect(patchResponse.status).toBe(403);
  });

  it("la liste des réservations est scopée par agence pour un MEMBER", async () => {
    // Pickup uniquement (pas de dropoff) — ne doit être visible qu'à l'agence de départ,
    // contrairement à la réservation pickup+dropoff du test précédent (visible aux deux).
    const createResponse = await createReservation(adminA, { pickupAgency: "Agence A1" });
    const id = (await createResponse.json()).reservation.id;

    const listResponse = await apiFetch("/api/reservations", { headers: { Cookie: memberAgencyA2.sessionCookie } });
    const { reservations } = await listResponse.json();
    expect((reservations as { id: string }[]).some((r) => r.id === id)).toBe(false);

    const listResponseA1 = await apiFetch("/api/reservations", { headers: { Cookie: memberAgencyA1.sessionCookie } });
    const { reservations: reservationsA1 } = await listResponseA1.json();
    expect((reservationsA1 as { id: string }[]).some((r) => r.id === id)).toBe(true);
  });
});

describe("POST /api/reservations/import", () => {
  it("importe les lignes valides, rapporte les erreurs et ignore les doublons de voucherNumber", async () => {
    const existingVoucher = `V-EXIST-${runId}`;
    const existingResponse = await createReservation(adminA, { voucherNumber: existingVoucher });
    expect(existingResponse.status).toBe(201);

    const rows = [
      importRow({
        voucherNumber: `V-IMPORT-1-${runId}`,
        clientFirstName: "Import",
        clientLastName: "Un",
        startDate: new Date("2030-07-01"),
        endDate: new Date("2030-07-03"),
      }),
      importRow({
        voucherNumber: `V-IMPORT-2-${runId}`,
        clientFirstName: "Import",
        clientLastName: "Deux",
        startDate: new Date("2030-07-05"),
        endDate: new Date("2030-07-06"),
      }),
      // Ligne invalide : clientLastName manquant.
      importRow({
        voucherNumber: `V-IMPORT-3-${runId}`,
        clientFirstName: "Import",
        startDate: new Date("2030-07-10"),
        endDate: new Date("2030-07-11"),
      }),
      // Doublon : voucherNumber déjà existant pour ce tenant.
      importRow({
        voucherNumber: existingVoucher,
        clientFirstName: "Import",
        clientLastName: "Doublon",
        startDate: new Date("2030-07-15"),
        endDate: new Date("2030-07-16"),
      }),
    ];

    const response = await importReservationsFile(adminA, rows, "commit");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.imported).toBe(2);
    expect(body.errors).toHaveLength(1);
    expect(body.duplicates).toHaveLength(1);

    const persisted = await prisma.reservation.findMany({
      where: { tenantId: adminA.tenantId, voucherNumber: `V-IMPORT-1-${runId}` },
    });
    expect(persisted).toHaveLength(1);
  });

  it("mode preview ne persiste rien", async () => {
    const voucherNumber = `V-PREVIEW-${runId}`;
    const rows = [
      importRow({
        voucherNumber,
        clientFirstName: "Preview",
        clientLastName: "Only",
        startDate: new Date("2030-08-01"),
        endDate: new Date("2030-08-02"),
      }),
    ];

    const response = await importReservationsFile(adminA, rows, "preview");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.imported).toBe(1);
    expect(body.preview).toHaveLength(1);

    const persisted = await prisma.reservation.findMany({ where: { tenantId: adminA.tenantId, voucherNumber } });
    expect(persisted).toHaveLength(0);
  });

  it("importe un code broker réel (TJS) sans le perdre — régression du bug Sprint 15", async () => {
    // Avant Sprint 15, seuls "BROKER"/"DIRECT" étaient acceptés à l'import : un code
    // broker réel comme "TJS" était silencieusement réduit à undefined (voir
    // normalizeSource/parseReservationImportRow, src/lib/reservations.ts).
    const voucherNumber = `V-BROKERCODE-${runId}`;
    const rows = [
      importRow({
        voucherNumber,
        clientFirstName: "Broker",
        clientLastName: "Code",
        startDate: new Date("2030-08-20"),
        endDate: new Date("2030-08-22"),
        source: "TJS",
      }),
    ];

    const response = await importReservationsFile(adminA, rows, "commit");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.errors).toHaveLength(0);
    expect(body.imported).toBe(1);

    const persisted = await prisma.reservation.findFirst({ where: { tenantId: adminA.tenantId, voucherNumber } });
    expect(persisted?.source).toBe("TJS");
  });

  it("refuse un fichier non .xlsx", async () => {
    const formData = new FormData();
    formData.append("file", new File(["not an excel file"], "reservations.txt"));
    const response = await fetch(`${TEST_BASE_URL}/api/reservations/import`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: formData,
    });
    expect(response.status).toBe(400);
  });

  it("Sprint 16 (audit sécurité) — refuse un fichier .xlsx dépassant la taille maximale autorisée", async () => {
    // Le contenu n'a pas besoin d'être un .xlsx valide : la vérification de taille intervient
    // avant tout parsing exceljs (src/app/api/reservations/import/route.ts).
    const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
    const formData = new FormData();
    formData.append("file", new File([oversized], "reservations.xlsx"));
    const response = await fetch(`${TEST_BASE_URL}/api/reservations/import`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: formData,
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/taille maximale/);
  });

  describe("robustesse dates/heures/villes (Sprint 14A)", () => {
    it("convertit un numéro de série Excel en date (cellule ayant perdu son format date)", async () => {
      const voucherNumber = `V-SERIAL-${runId}`;
      const startSerial = new Date("2030-07-20").getTime() / 86_400_000 + 25569;
      const endSerial = new Date("2030-07-22").getTime() / 86_400_000 + 25569;
      const rows = [
        importRow({
          voucherNumber,
          clientFirstName: "Serial",
          clientLastName: "Excel",
          startDate: startSerial,
          endDate: endSerial,
        }),
      ];

      const response = await importReservationsFile(adminA, rows, "commit");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.errors).toHaveLength(0);
      expect(body.imported).toBe(1);

      const persisted = await prisma.reservation.findFirst({ where: { tenantId: adminA.tenantId, voucherNumber } });
      expect(persisted?.startDate.toISOString().slice(0, 10)).toBe("2030-07-20");
      expect(persisted?.endDate.toISOString().slice(0, 10)).toBe("2030-07-22");
    });

    it("sérial Excel valide 46400 est accepté et converti correctement (2027-01-13)", async () => {
      const voucherNumber = `V-SERIAL46400-${runId}`;
      const rows = [
        importRow({
          voucherNumber,
          clientFirstName: "Serial",
          clientLastName: "Valide",
          startDate: 46400,
          endDate: 46405,
        }),
      ];

      const response = await importReservationsFile(adminA, rows, "commit");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.errors).toHaveLength(0);
      expect(body.imported).toBe(1);

      const persisted = await prisma.reservation.findFirst({ where: { tenantId: adminA.tenantId, voucherNumber } });
      expect(persisted?.startDate.toISOString().slice(0, 10)).toBe("2027-01-13");
      expect(persisted?.endDate.toISOString().slice(0, 10)).toBe("2027-01-18");
    });

    // Correctif (validation manuelle 2026-08-25, finding F-2) : une cellule date ayant perdu son
    // formatage Excel (copier-coller, valeur vidée puis retapée en numérique...) arrivait comme
    // un simple nombre, converti fidèlement par excelSerialToDate en une date syntaxiquement
    // valide mais jamais légitime (0 → 1899-12-30, le "jour 0" de l'époque Excel — voir le
    // commentaire de cellToDate/isPlausibleDate, src/lib/reservations.ts) — silencieusement
    // acceptée et persistée comme réservation réelle jusqu'ici, aucune erreur de ligne reportée.
    describe("date Excel numérique implausible (finding F-2)", () => {
      it("cellule date à 0 (bug 1899-12-30) : rejetée avec une erreur de ligne explicite, mode commit", async () => {
        const rows = [
          importRow({
            voucherNumber: `V-ZERODATE-${runId}`,
            clientFirstName: "Zero",
            clientLastName: "Date",
            startDate: 0,
            endDate: 46405,
          }),
        ];

        const response = await importReservationsFile(adminA, rows, "commit");
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.imported).toBe(0);
        expect(body.errors).toHaveLength(1);
        expect(body.errors[0].error).toContain("Colonne invalide: Date de départ");
        expect(body.errors[0].error).not.toContain("manquante");

        // Aucune ligne invalide persistée (pas de réservation avec une date de 1899, ni
        // aucune trace de cette ligne) — vérification directe en base, pas seulement la
        // réponse HTTP.
        const persisted = await prisma.reservation.findFirst({
          where: { tenantId: adminA.tenantId, clientFirstName: "Zero", clientLastName: "Date" },
        });
        expect(persisted).toBeNull();
      });

      it("cellule date à 0 : même rejet en mode aperçu (preview), sans écriture en base", async () => {
        const rows = [
          importRow({
            voucherNumber: `V-ZERODATE-PREVIEW-${runId}`,
            clientFirstName: "ZeroPreview",
            clientLastName: "Date",
            startDate: 0,
            endDate: 46405,
          }),
        ];

        const response = await importReservationsFile(adminA, rows, "preview");
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.imported).toBe(0);
        expect(body.errors).toHaveLength(1);
        expect(body.errors[0].error).toContain("Colonne invalide: Date de départ");

        const persisted = await prisma.reservation.findFirst({
          where: { tenantId: adminA.tenantId, clientFirstName: "ZeroPreview", clientLastName: "Date" },
        });
        expect(persisted).toBeNull();
      });

      it("valeur numérique négative : rejetée (date antérieure à 1900)", async () => {
        const rows = [
          importRow({
            voucherNumber: `V-NEGDATE-${runId}`,
            clientFirstName: "Negative",
            clientLastName: "Date",
            startDate: -100,
            endDate: 46405,
          }),
        ];

        const response = await importReservationsFile(adminA, rows, "commit");
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.imported).toBe(0);
        expect(body.errors).toHaveLength(1);
        expect(body.errors[0].error).toContain("Colonne invalide: Date de départ");

        const persisted = await prisma.reservation.findFirst({
          where: { tenantId: adminA.tenantId, clientFirstName: "Negative", clientLastName: "Date" },
        });
        expect(persisted).toBeNull();
      });

      it("cellule endDate à 0 : la colonne fautive (Date de retour) est bien identifiée dans l'erreur", async () => {
        const rows = [
          importRow({
            voucherNumber: `V-ZERODATE-END-${runId}`,
            clientFirstName: "ZeroEnd",
            clientLastName: "Date",
            startDate: 46400,
            endDate: 0,
          }),
        ];

        const response = await importReservationsFile(adminA, rows, "commit");
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.imported).toBe(0);
        expect(body.errors).toHaveLength(1);
        expect(body.errors[0].error).toContain("Colonne invalide: Date de retour");
      });

      it("date texte implausible (avant 1900) : rejetée avec le même message que les autres dates invalides", async () => {
        const rows = [
          importRow({
            voucherNumber: `V-OLDTEXT-${runId}`,
            clientFirstName: "Ancien",
            clientLastName: "Texte",
            startDate: "01/01/1850",
            endDate: "2030-07-30",
          }),
        ];

        const response = await importReservationsFile(adminA, rows, "commit");
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.imported).toBe(0);
        expect(body.errors).toHaveLength(1);
        expect(body.errors[0].error).toContain("Colonne invalide: Date de départ");
      });

      it("un fichier mêlant une ligne valide et une ligne à date 0 : la ligne valide est importée, seule l'invalide est rejetée", async () => {
        const validVoucher = `V-MIXED-VALID-${runId}`;
        const rows = [
          importRow({
            voucherNumber: validVoucher,
            clientFirstName: "Valide",
            clientLastName: "Ligne",
            startDate: 46400,
            endDate: 46405,
          }),
          importRow({
            voucherNumber: `V-MIXED-INVALID-${runId}`,
            clientFirstName: "Invalide",
            clientLastName: "Ligne",
            startDate: 0,
            endDate: 46405,
          }),
        ];

        const response = await importReservationsFile(adminA, rows, "commit");
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.imported).toBe(1);
        expect(body.errors).toHaveLength(1);
        expect(body.errors[0].row).toBe(3); // ligne 1 = en-têtes, ligne 2 = valide, ligne 3 = invalide

        const persistedValid = await prisma.reservation.findFirst({
          where: { tenantId: adminA.tenantId, voucherNumber: validVoucher },
        });
        expect(persistedValid).not.toBeNull();
        const persistedInvalid = await prisma.reservation.findFirst({
          where: { tenantId: adminA.tenantId, clientFirstName: "Invalide", clientLastName: "Ligne" },
        });
        expect(persistedInvalid).toBeNull();
      });
    });

    it("accepte une date au format DD/MM/YYYY en texte brut", async () => {
      const voucherNumber = `V-FR-DATE-${runId}`;
      const rows = [
        importRow({
          voucherNumber,
          clientFirstName: "Format",
          clientLastName: "Francais",
          startDate: "25/07/2030",
          endDate: "27/07/2030",
        }),
      ];

      const response = await importReservationsFile(adminA, rows, "commit");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.errors).toHaveLength(0);
      expect(body.imported).toBe(1);

      const persisted = await prisma.reservation.findFirst({ where: { tenantId: adminA.tenantId, voucherNumber } });
      expect(persisted?.startDate.toISOString().slice(0, 10)).toBe("2030-07-25");
      expect(persisted?.endDate.toISOString().slice(0, 10)).toBe("2030-07-27");
    });

    it("rapporte un message précis pour une date présente mais invalide (pas 'manquante')", async () => {
      const rows = [
        importRow({
          voucherNumber: `V-BADDATE-${runId}`,
          clientFirstName: "Mauvaise",
          clientLastName: "Date",
          startDate: "pas une date",
          endDate: "2030-07-30",
        }),
      ];

      const response = await importReservationsFile(adminA, rows, "commit");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].error).toContain("Colonne invalide: Date de départ");
      expect(body.errors[0].error).not.toContain("manquante");
    });

    it("nettoie une heure stockée comme cellule Date (correctif du bug de date parasite)", async () => {
      const voucherNumber = `V-TIME-${runId}`;
      const rows = [
        importRow({
          voucherNumber,
          clientFirstName: "Heure",
          clientLastName: "Propre",
          startDate: new Date("2030-08-05"),
          startTime: new Date(Date.UTC(1899, 11, 30, 14, 30)),
          endDate: new Date("2030-08-06"),
          endTime: new Date(Date.UTC(1899, 11, 30, 10, 0)),
        }),
      ];

      const response = await importReservationsFile(adminA, rows, "commit");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.errors).toHaveLength(0);

      const persisted = await prisma.reservation.findFirst({ where: { tenantId: adminA.tenantId, voucherNumber } });
      expect(persisted?.startTime).toBe("14:30");
      expect(persisted?.endTime).toBe("10:00");
    });

    it("accepte une ville de départ/retour correspondant au nom d'une agence (insensible à la casse)", async () => {
      const voucherNumber = `V-CITYOK-${runId}`;
      const rows = [
        importRow({
          voucherNumber,
          clientFirstName: "Ville",
          clientLastName: "Connue",
          startDate: new Date("2030-08-10"),
          endDate: new Date("2030-08-12"),
          pickupAgency: "agence a1",
          dropoffAgency: "AGENCE A1",
        }),
      ];

      const response = await importReservationsFile(adminA, rows, "commit");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.errors).toHaveLength(0);
      expect(body.imported).toBe(1);
    });

    it("refuse une ville de départ inconnue en précisant qu'il s'agit du départ", async () => {
      const rows = [
        importRow({
          voucherNumber: `V-CITYBAD-${runId}`,
          clientFirstName: "Ville",
          clientLastName: "Inconnue",
          startDate: new Date("2030-08-15"),
          endDate: new Date("2030-08-16"),
          pickupAgency: "Ville Qui N'Existe Pas",
        }),
      ];

      const response = await importReservationsFile(adminA, rows, "commit");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].error).toContain("Ville de départ inconnue");
    });

    it("refuse une ville de retour inconnue en précisant qu'il s'agit du retour", async () => {
      const rows = [
        importRow({
          voucherNumber: `V-CITYBAD2-${runId}`,
          clientFirstName: "Ville",
          clientLastName: "Retour",
          startDate: new Date("2030-08-17"),
          endDate: new Date("2030-08-18"),
          pickupAgency: "Agence A1",
          dropoffAgency: "Ville Qui N'Existe Pas Non Plus",
        }),
      ];

      const response = await importReservationsFile(adminA, rows, "commit");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].error).toContain("Ville de retour inconnue");
    });
  });
});

/** Corps minimal valide (véhicule + dates + identité client) — Sprint 13D, nouveau contrat de
 * POST /api/reservations/[id]/convert (formulaire de conversion pré-rempli, voir DOMAINRULES.md
 * section 26). Portée module (campagne QA, 2026-08-27) — déplacé hors de son describe d'origine
 * pour être réutilisé tel quel par le describe dédié au surclassement (même tenant/véhicule de
 * test, aucune raison de dupliquer ce helper). */
let convertBodyCounter = 0;

function convertBody(
  reservation: { startDate: string; endDate: string; clientFirstName: string; clientLastName: string; clientPhone?: string | null },
  overrides: Record<string, unknown> = {}
) {
  // Compteur local (Sprint 19) : idNumber/licenseNumber doivent être uniques par appel — sinon
  // findDuplicateClient (détection de doublon) rejette (409) tout appel après le premier au
  // sein de ce même tenant de test.
  convertBodyCounter += 1;
  return {
    vehicleId: vehicleAId,
    startDate: reservation.startDate,
    endDate: reservation.endDate,
    // Correctif F-3 (second passage, DOMAINRULES.md section 68) : startOdometer est
    // désormais obligatoire côté serveur — valeur par défaut réaliste ici pour ne pas
    // polluer les tests qui ne portent pas spécifiquement sur ce champ (voir le describe
    // dédié "kilométrage/carburant de départ à la conversion (finding F-3)" plus bas, qui
    // l'écrase explicitement via overrides pour couvrir les cas manquant/invalide).
    startOdometer: 10000,
    client: {
      firstName: reservation.clientFirstName,
      lastName: reservation.clientLastName,
      phone: reservation.clientPhone ?? undefined,
      // Sprint 19 (DOMAINRULES.md section 37) : désormais requis pour générer un contrat.
      address: "12 rue des Fleurs",
      city: "Casablanca",
      country: "Maroc",
      idNumber: `AB-${runId}-${convertBodyCounter}`,
      licenseNumber: `P-${runId}-${convertBodyCounter}`,
      licenseIssueDate: "2020-01-01",
      licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01",
    },
    ...overrides,
  };
}

describe("POST /api/reservations/[id]/convert", () => {

  it("refuse sans vehicleId", async () => {
    const createResponse = await createReservation(adminA);
    const id = (await createResponse.json()).reservation.id;

    const response = await apiFetch(`/api/reservations/${id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it("refuse sans prénom/nom client (client existant non réutilisé)", async () => {
    const createResponse = await createReservation(adminA);
    const reservation = (await createResponse.json()).reservation;

    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId: vehicleAId, startDate: reservation.startDate, endDate: reservation.endDate }),
    });
    expect(response.status).toBe(400);
  });

  it("convertit une réservation en Location + Invoice et marque CONVERTED", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "Nouveau",
      clientLastName: `Client-${runId}`,
      startDate: "2030-09-01",
      endDate: "2030-09-03",
    });
    const reservation = (await createResponse.json()).reservation;

    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(convertBody(reservation)),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.reservation.status).toBe("CONVERTED");
    expect(body.reservation.convertedLocationId).toBe(body.location.id);
    expect(body.location.vehicleId).toBe(vehicleAId);
    expect(body.location.agencyId).toBe(agencyA1Id);
    expect(body.invoice).not.toBeNull();
  });

  it("un pricePerDay explicite à la conversion prime sur le prix informatif du véhicule (Sprint 14A)", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "PrixExplicite",
      clientLastName: `Client-${runId}`,
      startDate: "2030-09-10",
      endDate: "2030-09-12",
    });
    const reservation = (await createResponse.json()).reservation;

    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(convertBody(reservation, { pricePerDay: 9000 })),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.pricePerDay).toBe(9000);
    expect(body.location.totalPrice).toBe(18000); // 2 jours × 9000
  });

  it("Sprint 19 : un totalPrice explicite à la conversion prime sur le calcul pricePerDay × jours", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "TotalExplicite",
      clientLastName: `Client-${runId}`,
      startDate: "2030-09-15",
      endDate: "2030-09-17",
    });
    const reservation = (await createResponse.json()).reservation;

    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(convertBody(reservation, { pricePerDay: 9000, totalPrice: 15000 })),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    // 2 jours × 9000 = 18000 normalement, mais totalPrice explicite (15000, ex. remise) prévaut.
    expect(body.location.totalPrice).toBe(15000);
  });

  it("Sprint 19 : ajoute un second conducteur au contrat à la conversion", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "AvecSecondConducteur",
      clientLastName: `Client-${runId}`,
      startDate: "2030-10-20",
      endDate: "2030-10-22",
    });
    const reservation = (await createResponse.json()).reservation;

    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, {
          secondDriver: {
            firstName: "Second",
            lastName: "Conducteur",
            phone: "+212600000000",
            birthDate: "1990-01-01",
          },
        })
      ),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.secondDriverId).toBeTruthy();

    const secondDriverClient = await prisma.client.findUnique({ where: { id: body.location.secondDriverId } });
    expect(secondDriverClient?.firstName).toBe("Second");
    expect(secondDriverClient?.lastName).toBe("Conducteur");
  });

  it("réutilise un second conducteur déjà existant sur correspondance exacte (idNumber) au lieu de créer un doublon (campagne QA, résolution du doublon Omar)", async () => {
    const existingResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        firstName: "Existant",
        lastName: `SecondConducteur-${runId}`,
        idNumber: `SD-EXACT-${runId}`,
        birthDate: "1990-01-01",
      }),
    });
    const existingClient = (await existingResponse.json()).client;

    const createResponse = await createReservation(adminA, {
      clientFirstName: "AvecSecondExistant",
      clientLastName: `Client-${runId}`,
      startDate: "2030-10-25",
      endDate: "2030-10-27",
    });
    const reservation = (await createResponse.json()).reservation;

    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, {
          // Nom volontairement différent : la correspondance porte sur idNumber (identifiant
          // fort), pas sur le nom — reproduit exactement le scénario du doublon Omar (identité
          // ressaisie légèrement différemment mais même pièce d'identité).
          secondDriver: { firstName: "Existant", lastName: "Retapé", idNumber: `SD-EXACT-${runId}`, birthDate: "1990-01-01" },
        })
      ),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.secondDriverId).toBe(existingClient.id);

    const clientCount = await prisma.client.count({ where: { idNumber: `SD-EXACT-${runId}` } });
    expect(clientCount).toBe(1);
  });

  it("journalise client.created pour un client réellement créé par la conversion (principal et second conducteur), jamais pour un client réutilisé (campagne QA, correctif audit INC-13)", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "AuditPrincipal",
      clientLastName: `Client-${runId}`,
      startDate: "2030-11-10",
      endDate: "2030-11-12",
    });
    const reservation = (await createResponse.json()).reservation;

    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, {
          // forceCreateClient : ce test porte sur la journalisation d'audit, pas sur la
          // détection de doublon — évite une collision floue accidentelle avec l'un des
          // nombreux autres clients "... Client-<runId>" créés ailleurs dans ce fichier lors
          // d'une exécution complète de la suite (même correctif que les autres tests touchés
          // par cette classe de collision, voir plus haut dans ce fichier).
          forceCreateClient: true,
          secondDriver: {
            firstName: "AuditSecond",
            lastName: `Conducteur-${runId}`,
            idNumber: `SD-AUDIT-${runId}`,
            birthDate: "1988-01-01",
          },
        })
      ),
    });
    expect(response.status).toBe(201);
    const body = await response.json();

    const primaryLog = await prisma.auditLog.findFirst({
      where: { action: "client.created", resourceId: body.location.clientId },
    });
    expect(primaryLog).not.toBeNull();
    const secondDriverLog = await prisma.auditLog.findFirst({
      where: { action: "client.created", resourceId: body.location.secondDriverId },
    });
    expect(secondDriverLog).not.toBeNull();

    // Réutilisation (correspondance exacte du second conducteur, même idNumber) : aucune
    // nouvelle écriture Client, donc aucun nouveau client.created — seulement le premier compte.
    const reuseReservation = (
      await (
        await createReservation(adminA, {
          clientFirstName: "AuditPrincipal2",
          clientLastName: `Client-${runId}`,
          startDate: "2030-11-13",
          endDate: "2030-11-14",
        })
      ).json()
    ).reservation;
    await apiFetch(`/api/reservations/${reuseReservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reuseReservation, {
          // forceCreateClient : "AuditPrincipal"/"AuditPrincipal2" (même lastName) déclenchent
          // sinon une correspondance floue sur le client PRINCIPAL — sans rapport avec ce que
          // ce test vérifie (l'absence de nouveau client.created pour le SECOND conducteur
          // réutilisé), même correctif que les autres tests de répétition de ce fichier.
          forceCreateClient: true,
          secondDriver: {
            firstName: "AuditSecond",
            lastName: "Retapé",
            idNumber: `SD-AUDIT-${runId}`,
            birthDate: "1988-01-01",
          },
        })
      ),
    });
    const secondDriverLogCount = await prisma.auditLog.count({
      where: { action: "client.created", resourceId: body.location.secondDriverId },
    });
    expect(secondDriverLogCount).toBe(1);
  });

  it("ne fusionne jamais automatiquement sur une correspondance floue (nom seul) — crée un nouveau second conducteur", async () => {
    await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        firstName: "Jean",
        lastName: `Dupont-Fuzzy-${runId}`,
        birthDate: "1985-01-01",
      }),
    });

    const createResponse = await createReservation(adminA, {
      clientFirstName: "AvecSecondFuzzy",
      clientLastName: `Client-${runId}`,
      startDate: "2030-10-28",
      endDate: "2030-10-30",
    });
    const reservation = (await createResponse.json()).reservation;

    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, {
          // Nom très proche (distance de Levenshtein < 3) mais aucun identifiant fort commun —
          // correspondance floue uniquement, jamais fusionnée automatiquement.
          secondDriver: { firstName: "Jean", lastName: `Dupont-Fuzzi-${runId}`, birthDate: "1985-01-01" },
        })
      ),
    });
    expect(response.status).toBe(201);
    const body = await response.json();

    const clientCount = await prisma.client.count({ where: { lastName: { in: [`Dupont-Fuzzy-${runId}`, `Dupont-Fuzzi-${runId}`] } } });
    expect(clientCount).toBe(2);
    expect(body.location.secondDriverId).not.toBeNull();
  });

  it("n'introduit jamais de doublon même en répétant la même conversion avec le même second conducteur (test de non-réapparition)", async () => {
    const first = await createReservation(adminA, {
      clientFirstName: "Repetition1",
      clientLastName: `Client-${runId}`,
      startDate: "2030-11-01",
      endDate: "2030-11-03",
    });
    const reservation1 = (await first.json()).reservation;
    const response1 = await apiFetch(`/api/reservations/${reservation1.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation1, {
          secondDriver: { firstName: "Repete", lastName: `Second-${runId}`, idNumber: `SD-REPEAT-${runId}`, birthDate: "1988-01-01" },
        })
      ),
    });
    expect(response1.status).toBe(201);
    const secondDriverId1 = (await response1.json()).location.secondDriverId;

    const second = await createReservation(adminA, {
      clientFirstName: "Repetition2",
      clientLastName: `Client-${runId}`,
      startDate: "2030-11-05",
      endDate: "2030-11-07",
    });
    const reservation2 = (await second.json()).reservation;
    const response2 = await apiFetch(`/api/reservations/${reservation2.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation2, {
          // forceCreateClient : "Repetition1"/"Repetition2" (même lastName) déclenchent sinon
          // une correspondance floue sur le CLIENT PRINCIPAL (distance de Levenshtein < 3,
          // section 9) — sans rapport avec ce test, qui porte uniquement sur le second
          // conducteur. Les deux clients principaux sont volontairement des personnes
          // distinctes ici.
          forceCreateClient: true,
          secondDriver: { firstName: "Repete", lastName: `Second-${runId}`, idNumber: `SD-REPEAT-${runId}`, birthDate: "1988-01-01" },
        })
      ),
    });
    expect(response2.status).toBe(201);
    const secondDriverId2 = (await response2.json()).location.secondDriverId;

    expect(secondDriverId2).toBe(secondDriverId1);
    const clientCount = await prisma.client.count({ where: { idNumber: `SD-REPEAT-${runId}` } });
    expect(clientCount).toBe(1);
  });

  it("convertit avec paiement intégré (mode simple) et alimente la Caisse", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "Payeur",
      clientLastName: `Client-${runId}`,
      startDate: "2030-09-05",
      endDate: "2030-09-06",
    });
    const reservation = (await createResponse.json()).reservation;

    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(convertBody(reservation, { payment: { method: "CASH", partial: false } })),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.paymentError).toBeNull();
    expect(body.payments).toHaveLength(1);
    expect(body.invoice.status).toBe("PAID");

    const cashEntries = await prisma.cashEntry.findMany({ where: { contractId: body.location.id } });
    expect(cashEntries).toHaveLength(1);
  });

  it("refuse de reconvertir une réservation déjà CONVERTED", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "Deja",
      clientLastName: `Converti-${runId}`,
      startDate: "2030-09-10",
      endDate: "2030-09-12",
    });
    const reservation = (await createResponse.json()).reservation;

    await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(convertBody(reservation)),
    });

    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(convertBody(reservation)),
    });
    expect(response.status).toBe(409);
  });

  it("détecte un client existant (téléphone) à la conversion et propose de le réutiliser", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "Duplicate",
      clientLastName: "Phone",
      clientPhone: clientAPhone,
      startDate: "2030-09-20",
      endDate: "2030-09-22",
    });
    const reservation = (await createResponse.json()).reservation;

    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(convertBody(reservation)),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.duplicate.field).toBe("phone");

    const retryResponse = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(convertBody(reservation, { useExistingClientId: body.duplicate.client.id })),
    });
    expect(retryResponse.status).toBe(201);
    const retryBody = await retryResponse.json();
    expect(retryBody.location.clientId).toBe(body.duplicate.client.id);
  });

  it("Sprint 22 : reservations.convert est indépendante de reservations.edit — un user n'ayant que .convert peut convertir une réservation PENDING sans jamais passer par .edit", async () => {
    const convertOnlyGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: `ConvertOnly-${runId}`,
        permissions: ["reservations.view", "reservations.convert", "vehicles.view", "agencies.view"],
      }),
    });
    const convertOnlyGroupId = (await convertOnlyGroupResponse.json()).group.id;

    const convertOnlyMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Convert Only Member",
      email: `convert-only-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: convertOnlyMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${convertOnlyMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: convertOnlyGroupId }),
    });

    const createResponse = await createReservation(adminA, {
      clientFirstName: "ConvertOnly",
      clientLastName: `Client-${runId}`,
      startDate: "2030-09-25",
      endDate: "2030-09-27",
      pickupAgency: "Agence A1",
    });
    const reservation = (await createResponse.json()).reservation;
    expect(reservation.status).toBe("PENDING");

    // Un PATCH de statut (Confirmer) échoue pour ce user — reservations.edit manquant.
    const patchResponse = await apiFetch(`/api/reservations/${reservation.id}`, {
      method: "PATCH",
      headers: { Cookie: convertOnlyMember.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(patchResponse.status).toBe(403);

    // La conversion réussit directement depuis PENDING (canTransition l'autorise, voir
    // src/lib/reservations.ts) sans jamais être passée par CONFIRMED.
    const convertResponse = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: convertOnlyMember.sessionCookie },
      body: JSON.stringify(convertBody(reservation)),
    });
    expect(convertResponse.status).toBe(201);
    const convertJson = await convertResponse.json();
    expect(convertJson.reservation.status).toBe("CONVERTED");
  });

  /** Sprint 28 (Finding E) : la conversion réutilise createLocation (Finding A/C) — même garde
   * véhicule MAINTENANCE/TRANSFERRING/ON_TRIP que POST /api/locations, aucune exception pour
   * cette route. Statuts « en mobilité » forcés directement en base (jamais assignables
   * manuellement via POST/PATCH /api/vehicles*, DOMAINRULES.md section 30), même convention que
   * locations.test.ts. */
  describe("Sprint 28 (Finding E) + campagne QA 2026-08-27 partie 2 — véhicule MAINTENANCE/TRANSFERRING/ON_TRIP bloque la conversion", () => {
    async function createVehicleWithStatus(status: "MAINTENANCE" | "TRANSFERRING" | "ON_TRIP" | "AVAILABLE") {
      const response = await apiFetch("/api/vehicles", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({
          agencyId: agencyA1Id,
          name: "Véhicule Finding E (conversion)",
          licensePlate: `RES-E-${status}-${runId}-${Math.floor(Math.random() * 100_000)}`,
          make: "Dacia",
          model: "Sandero",
          year: 2022,
          category: "Citadine",
          pricePerDay: 4000,
          chassisNumber: `VF1TESTE${Math.floor(Math.random() * 1_000_000)}`,
          color: "Blanc",
          doors: 5,
          seats: 5,
          horsepower: 5,
          powerKW: 55,
          engineSize: 1.0,
        }),
      });
      const vehicleId = (await response.json()).vehicle.id;
      if (status !== "AVAILABLE") {
        await prisma.vehicle.update({ where: { id: vehicleId }, data: { status } });
      }
      return vehicleId;
    }

    it.each(["MAINTENANCE", "TRANSFERRING", "ON_TRIP"] as const)(
      "refuse la conversion (409, VehicleUnavailableForLocationError) si le véhicule est %s — aucune Location ni conversion partielle",
      async (status) => {
        const vehicleId = await createVehicleWithStatus(status);
        const createResponse = await createReservation(adminA, {
          clientFirstName: "IndisponibleE",
          clientLastName: `Client-${runId}-${status}`,
          startDate: "2030-11-01",
          endDate: "2030-11-03",
        });
        const reservation = (await createResponse.json()).reservation;

        const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
          method: "POST",
          headers: { Cookie: adminA.sessionCookie },
          body: JSON.stringify(convertBody(reservation, { vehicleId })),
        });
        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body.error).toContain(status);

        // Aucune conversion partielle : ni Location pour ce véhicule, ni réservation marquée
        // CONVERTED (claimReservationConversion doit avoir été défaite par le rollback de la
        // transaction, même garantie que le reste du Finding A).
        const locationCount = await prisma.location.count({ where: { vehicleId } });
        expect(locationCount).toBe(0);

        const reservationAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
        expect(reservationAfter.status).toBe("PENDING");
        expect(reservationAfter.convertedLocationId).toBeNull();
      }
    );

    /** Sprint "statut opérationnel automatique" (2026-08-28) : la conversion réutilise
     * createLocation, hérite donc aussi du contrôle de désactivation administrative
     * (assertVehicleStatusAllowsLocation), sans exception pour cette route. */
    it("refuse la conversion (409) si le véhicule est désactivé — aucune Location ni conversion partielle", async () => {
      const vehicleId = await createVehicleWithStatus("AVAILABLE");
      await prisma.vehicle.update({
        where: { id: vehicleId },
        data: { deactivatedAt: new Date(), deactivatedReason: "Retrait de flotte", deactivatedById: adminA.userId },
      });
      const createResponse = await createReservation(adminA, {
        clientFirstName: "DesactiveE",
        clientLastName: `Client-${runId}`,
        startDate: "2030-11-08",
        endDate: "2030-11-09",
      });
      const reservation = (await createResponse.json()).reservation;

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(convertBody(reservation, { vehicleId })),
      });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toContain("désactivé");

      const locationCount = await prisma.location.count({ where: { vehicleId } });
      expect(locationCount).toBe(0);
      const reservationAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(reservationAfter.status).toBe("PENDING");
      expect(reservationAfter.convertedLocationId).toBeNull();
    });

    it("autorise la conversion si le véhicule est AVAILABLE", async () => {
      const vehicleId = await createVehicleWithStatus("AVAILABLE");
      const createResponse = await createReservation(adminA, {
        clientFirstName: "DisponibleE",
        clientLastName: `Client-${runId}`,
        startDate: "2030-11-05",
        endDate: "2030-11-07",
      });
      const reservation = (await createResponse.json()).reservation;

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(convertBody(reservation, { vehicleId })),
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.reservation.status).toBe("CONVERTED");
      expect(body.location.vehicleId).toBe(vehicleId);
    });
  });

  describe("Sprint 29 — permis du client principal doit couvrir la date de retour à la conversion (point 16, DOMAINRULES.md section 44)", () => {
    // Plage 2034-xx isolée : aucune autre réservation/location de ce fichier n'utilise l'année
    // 2034 (vérifié), élimine tout risque de conflit de disponibilité avec un test existant.
    it("refuse (400) la conversion si le permis du client n'expire pas au moins à la date de retour — transaction entièrement annulée", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "PermisExpire",
        clientLastName: `Convert-${runId}`,
        startDate: "2034-04-10",
        endDate: "2034-04-13",
      });
      const reservation = (await createResponse.json()).reservation;

      const body = convertBody(reservation);
      body.client.licenseExpiryDate = "2034-04-04"; // expire 9 jours avant le retour

      const clientCountBefore = await prisma.client.count({ where: { tenantId: adminA.tenantId } });

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      const responseBody = await response.json();
      expect(responseBody.error).toMatch(/expire avant la date de retour/i);

      // Rollback complet de la transaction partagée (Sprint 26A, Finding A) : ni Location, ni
      // réservation marquée CONVERTED, ni client orphelin créé par la tentative de conversion.
      const locationCount = await prisma.location.count({ where: { vehicleId: vehicleAId, startDate: new Date("2034-04-10") } });
      expect(locationCount).toBe(0);

      const reservationAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(reservationAfter.status).toBe("PENDING");
      expect(reservationAfter.convertedLocationId).toBeNull();

      const clientCountAfter = await prisma.client.count({ where: { tenantId: adminA.tenantId } });
      expect(clientCountAfter).toBe(clientCountBefore);
    });

    it("accepte la conversion lorsque le permis expire exactement à la date de retour (égalité UTC)", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "PermisEgal",
        clientLastName: `Convert-${runId}`,
        startDate: "2034-04-18T10:00:00.000Z",
        endDate: "2034-04-20T14:00:00.000Z",
      });
      const reservation = (await createResponse.json()).reservation;

      const body = convertBody(reservation);
      body.client.licenseExpiryDate = "2034-04-20";

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
    });

    it("non-régression : conversion avec permis valide (défaut convertBody, expiration 2099) toujours acceptée", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "PermisOk",
        clientLastName: `Convert-${runId}`,
        startDate: "2034-04-22",
        endDate: "2034-04-25",
      });
      const reservation = (await createResponse.json()).reservation;

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(convertBody(reservation)),
      });
      expect(response.status).toBe(201);
    });
  });

  describe("Campagne QA 2026-08-26 (partie 1) — cohérence chronologique des dates de permis à la conversion", () => {
    it("refuse (400) la conversion si la date d'expiration du permis est antérieure à sa date d'obtention — transaction entièrement annulée", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "PermisIncoherent",
        clientLastName: `Convert-${runId}`,
        startDate: "2034-05-10",
        endDate: "2034-05-13",
      });
      const reservation = (await createResponse.json()).reservation;

      const body = convertBody(reservation);
      body.client.licenseIssueDate = "2025-01-01";
      body.client.licenseExpiryDate = "2020-01-01";

      const clientCountBefore = await prisma.client.count({ where: { tenantId: adminA.tenantId } });

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      const responseBody = await response.json();
      expect(responseBody.error).toMatch(/postérieure à sa date d'obtention/);

      const reservationAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(reservationAfter.status).toBe("PENDING");
      expect(reservationAfter.convertedLocationId).toBeNull();

      const clientCountAfter = await prisma.client.count({ where: { tenantId: adminA.tenantId } });
      expect(clientCountAfter).toBe(clientCountBefore);
    });

    // Trouvé en revue stricte (2026-08-26) : sans validation de format explicite, une date non
    // parseable produisait une erreur 500 non contrôlée au lieu d'un refus propre (même défaut
    // que POST/PATCH /api/clients, voir clients.test.ts).
    it("refuse (400, jamais 500) une conversion avec une date de permis non parseable", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "PermisDateInvalide",
        clientLastName: `Convert-${runId}`,
        startDate: "2034-05-15",
        endDate: "2034-05-18",
      });
      const reservation = (await createResponse.json()).reservation;

      const body = convertBody(reservation);
      body.client.licenseIssueDate = "not-a-date";

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      const responseBody = await response.json();
      expect(responseBody.error).toMatch(/licenseIssueDate doit être une date ISO valide/);
    });

    // Trouvé en revue stricte (2026-08-26) : une chaîne composée uniquement d'espaces est
    // truthy en JavaScript — un simple contrôle `!champ` laissait passer un lastName incohérent.
    it("refuse (400) une conversion avec un lastName composé uniquement d'espaces — transaction annulée", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "EspacesSeuls",
        clientLastName: `Convert-${runId}`,
        startDate: "2034-05-20",
        endDate: "2034-05-23",
      });
      const reservation = (await createResponse.json()).reservation;

      const body = convertBody(reservation);
      body.client.lastName = "   ";

      const clientCountBefore = await prisma.client.count({ where: { tenantId: adminA.tenantId } });

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);

      const clientCountAfter = await prisma.client.count({ where: { tenantId: adminA.tenantId } });
      expect(clientCountAfter).toBe(clientCountBefore);
    });
  });

  describe("Sprint 30 — âge minimum du conducteur à la date de départ, à la conversion (point 7, DOMAINRULES.md section 45)", () => {
    // Plage 2034-06/07 isolée (aucune autre réservation/location de ce fichier n'utilise cette
    // plage, vérifié) — élimine tout risque de conflit de disponibilité avec un test existant.
    it("refuse (400) la conversion si le client principal (nouveau) a moins de 21 ans à la date de départ — transaction entièrement annulée", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "TropJeune",
        clientLastName: `Convert-${runId}`,
        startDate: "2034-06-15",
        endDate: "2034-06-17",
      });
      const reservation = (await createResponse.json()).reservation;

      const body = convertBody(reservation);
      // 21e anniversaire le 2034-06-16 (un jour après le départ) → 20 ans et 364 jours au départ.
      body.client.birthDate = "2013-06-16";

      const clientCountBefore = await prisma.client.count({ where: { tenantId: adminA.tenantId } });

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      const responseBody = await response.json();
      expect(responseBody.error).toMatch(/n'a pas encore 21 ans/i);

      // Rollback complet de la transaction partagée (Sprint 26A, Finding A) : ni Location, ni
      // réservation marquée CONVERTED, ni client orphelin créé par la tentative de conversion.
      const locationCount = await prisma.location.count({ where: { vehicleId: vehicleAId, startDate: new Date("2034-06-15") } });
      expect(locationCount).toBe(0);

      const reservationAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(reservationAfter.status).toBe("PENDING");
      expect(reservationAfter.convertedLocationId).toBeNull();

      const clientCountAfter = await prisma.client.count({ where: { tenantId: adminA.tenantId } });
      expect(clientCountAfter).toBe(clientCountBefore);
    });

    it("accepte la conversion lorsque le client principal a exactement 21 ans le jour de la date de départ", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "ExactementMajeur",
        clientLastName: `Convert-${runId}`,
        startDate: "2034-06-20",
        endDate: "2034-06-22",
      });
      const reservation = (await createResponse.json()).reservation;

      const body = convertBody(reservation);
      body.client.birthDate = "2013-06-20";

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
    });

    it("refuse (400) la conversion si birthDate est absente pour un nouveau client principal", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "SansNaissance",
        clientLastName: `Convert-${runId}`,
        startDate: "2034-06-25",
        endDate: "2034-06-27",
      });
      const reservation = (await createResponse.json()).reservation;

      const body = convertBody(reservation) as { client: Record<string, unknown> };
      delete body.client.birthDate;

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    });

    it("refuse (400) la conversion via useExistingClientId pointant vers un client existant sans birthDate connue", async () => {
      const existingClientResponse = await apiFetch("/api/clients", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ name: "Client Existant Sans Naissance", licenseExpiryDate: "2099-12-31" }),
      });
      const existingClientId = (await existingClientResponse.json()).client.id;

      const createResponse = await createReservation(adminA, {
        clientFirstName: "ExistantSansNaissance",
        clientLastName: `Convert-${runId}`,
        startDate: "2034-06-28",
        endDate: "2034-06-30",
      });
      const reservation = (await createResponse.json()).reservation;

      // convertBody() fournit par défaut client.birthDate (1990-01-01) — la mise à jour
      // automatique du client existant (voir POST /api/reservations/[id]/convert) l'aurait
      // sinon appliqué au client réutilisé, masquant le cas testé ici (client existant dont la
      // birthDate reste réellement inconnue après conversion).
      const body = convertBody(reservation, { useExistingClientId: existingClientId }) as {
        client: Record<string, unknown>;
      };
      delete body.client.birthDate;

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      const responseBody = await response.json();
      expect(responseBody.error).toMatch(/date de naissance.*n'est pas renseignée/i);
    });

    it("refuse (400) la conversion si le second conducteur a moins de 21 ans à la date de départ — transaction entièrement annulée", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "AvecSecondTropJeune",
        clientLastName: `Convert-${runId}`,
        startDate: "2034-07-02",
        endDate: "2034-07-04",
      });
      const reservation = (await createResponse.json()).reservation;

      const clientCountBefore = await prisma.client.count({ where: { tenantId: adminA.tenantId } });

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(
          convertBody(reservation, {
            // 21e anniversaire le 2034-07-03 (un jour après le départ) → 20 ans et 364 jours.
            secondDriver: { firstName: "Second", lastName: "TropJeune", birthDate: "2013-07-03" },
          })
        ),
      });
      expect(response.status).toBe(400);
      const responseBody = await response.json();
      expect(responseBody.error).toMatch(/n'a pas encore 21 ans/i);

      // Rollback complet : ni Location, ni réservation CONVERTED, ni client principal/second
      // conducteur orphelin créés par la tentative de conversion.
      const locationCount = await prisma.location.count({ where: { vehicleId: vehicleAId, startDate: new Date("2034-07-02") } });
      expect(locationCount).toBe(0);

      const reservationAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(reservationAfter.status).toBe("PENDING");

      const clientCountAfter = await prisma.client.count({ where: { tenantId: adminA.tenantId } });
      expect(clientCountAfter).toBe(clientCountBefore);
    });

    it("accepte la conversion lorsque le second conducteur a exactement 21 ans le jour de la date de départ", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "AvecSecondExactementMajeur",
        clientLastName: `Convert-${runId}`,
        startDate: "2034-07-06",
        endDate: "2034-07-08",
      });
      const reservation = (await createResponse.json()).reservation;

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(
          convertBody(reservation, {
            secondDriver: { firstName: "Second", lastName: "ExactementMajeur", birthDate: "2013-07-06" },
          })
        ),
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.location.secondDriverId).toBeTruthy();
    });

    it("refuse (400) la conversion si secondDriver.birthDate est absente", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "AvecSecondSansNaissance",
        clientLastName: `Convert-${runId}`,
        startDate: "2034-07-10",
        endDate: "2034-07-12",
      });
      const reservation = (await createResponse.json()).reservation;

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(
          convertBody(reservation, { secondDriver: { firstName: "Second", lastName: "SansNaissance" } })
        ),
      });
      expect(response.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Correctif (validation manuelle 2026-08-25, finding F-3) : kilométrage/carburant de départ à
  // la conversion — jusqu'ici jamais collectés par ce parcours, laissant Location.startOdometer
  // toujours null et désactivant silencieusement le contrôle du kilométrage au retour
  // (assertValidOdometer, src/lib/location-return.ts). Voir le commentaire de ConvertBody.
  // startOdometer (src/app/api/reservations/[id]/convert/route.ts).
  // -------------------------------------------------------------------------------------------
  describe("kilométrage/carburant de départ à la conversion (finding F-3)", () => {
    it("startOdometer/startFuelLevel valides sont persistés sur le contrat créé", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "OdometreValide",
        clientLastName: `Convert-${runId}`,
        startDate: "2036-02-01",
        endDate: "2036-02-03",
      });
      const reservation = (await createResponse.json()).reservation;

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(convertBody(reservation, { startOdometer: 12000, startFuelLevel: 80 })),
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.location.startOdometer).toBe(12000);
      expect(body.location.startFuelLevel).toBe(80);
    });

    // Re-correctif (second passage, DOMAINRULES.md section 68) : startOdometer est désormais
    // OBLIGATOIRE à la conversion — divergence assumée avec la création directe (POST
    // /api/locations, toujours optionnel là-bas). Ce test remplace l'ancien test "restent
    // optionnels" (comportement révisé, voir git history) : une conversion sans startOdometer
    // doit désormais être refusée, jamais créer de contrat avec startOdometer: null.
    it("refuse (400) une conversion sans startOdometer — aucun nouveau contrat converti ne doit pouvoir exister sans kilométrage de départ valide", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "OdometreAbsent",
        clientLastName: `Convert-${runId}`,
        startDate: "2036-02-05",
        endDate: "2036-02-07",
      });
      const reservation = (await createResponse.json()).reservation;

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(convertBody(reservation, { startOdometer: undefined })),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("startOdometer");

      // La réservation n'a pas été convertie (rollback complet, aucune écriture partielle) et
      // aucune Location n'a été créée pour ce client.
      const persistedReservation = await prisma.reservation.findUnique({ where: { id: reservation.id } });
      expect(persistedReservation?.status).toBe("PENDING");
      expect(persistedReservation?.convertedLocationId).toBeNull();
      const orphanLocation = await prisma.location.findFirst({
        where: { tenantId: adminA.tenantId, client: { firstName: "OdometreAbsent", lastName: `Convert-${runId}` } },
      });
      expect(orphanLocation).toBeNull();
    });

    // Sur-mesure véhicule sans historique exploitable : le préremplissage automatique
    // (GET /api/vehicles/[id]/last-known-state) peut lui-même renvoyer odometer: null pour un
    // véhicule neuf sans Location/VehicleTransfer/VehicleTrip antérieur et sans
    // currentOdometer connu — le serveur doit refuser la conversion dans ce cas comme dans
    // n'importe quel autre cas d'omission (même contrôle, indépendant de la cause de
    // l'absence de valeur).
    it("refuse (400) une conversion sans startOdometer pour un véhicule neuf sans kilométrage exploitable connu", async () => {
      const freshVehicleResponse = await apiFetch("/api/vehicles", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({
          agencyId: agencyA1Id,
          name: "Vehicule Neuf F3",
          licensePlate: `RES-F3-${runId}`,
          make: "Renault",
          model: "Clio",
          year: 2026,
          category: "Citadine",
          pricePerDay: 5000,
          chassisNumber: `VF1F3${Math.floor(Math.random() * 1_000_000)}`,
          color: "Blanc",
          doors: 5,
          seats: 5,
          horsepower: 6,
          powerKW: 75,
          engineSize: 1.5,
        }),
      });
      const freshVehicleId = (await freshVehicleResponse.json()).vehicle.id;

      const lastKnownState = await apiFetch(`/api/vehicles/${freshVehicleId}/last-known-state`, {
        headers: { Cookie: adminA.sessionCookie },
      });
      expect((await lastKnownState.json()).odometer).toBeNull();

      const createResponse = await createReservation(adminA, {
        clientFirstName: "VehiculeNeuf",
        clientLastName: `Convert-${runId}`,
        startDate: "2036-02-08",
        endDate: "2036-02-09",
      });
      const reservation = (await createResponse.json()).reservation;

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(convertBody(reservation, { vehicleId: freshVehicleId, startOdometer: undefined })),
      });
      expect(response.status).toBe(400);
    });

    it("refuse (400) un startOdometer négatif", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "OdometreNegatif",
        clientLastName: `Convert-${runId}`,
        startDate: "2036-02-10",
        endDate: "2036-02-12",
      });
      const reservation = (await createResponse.json()).reservation;

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(convertBody(reservation, { startOdometer: -50 })),
      });
      expect(response.status).toBe(400);
    });

    it("refuse (400) un startOdometer décimal (pas un entier)", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "OdometreDecimal",
        clientLastName: `Convert-${runId}`,
        startDate: "2036-02-14",
        endDate: "2036-02-16",
      });
      const reservation = (await createResponse.json()).reservation;

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(convertBody(reservation, { startOdometer: 12000.5 })),
      });
      expect(response.status).toBe(400);
    });

    it("refuse (400) un startFuelLevel hors de la plage 0-100", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "CarburantInvalide",
        clientLastName: `Convert-${runId}`,
        startDate: "2036-02-18",
        endDate: "2036-02-20",
      });
      const reservation = (await createResponse.json()).reservation;

      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(convertBody(reservation, { startFuelLevel: 150 })),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("carburant");
    });

    it("bout en bout : un contrat converti avec startOdometer refuse ensuite un retour à kilométrage inférieur ou égal, accepte un kilométrage strictement supérieur", async () => {
      const createResponse = await createReservation(adminA, {
        clientFirstName: "RetourE2E",
        clientLastName: `Convert-${runId}`,
        startDate: "2036-03-01",
        endDate: "2036-03-03",
      });
      const reservation = (await createResponse.json()).reservation;

      const convertResponse = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(convertBody(reservation, { startOdometer: 30000, startFuelLevel: 70 })),
      });
      expect(convertResponse.status).toBe(201);
      const { location } = await convertResponse.json();
      expect(location.startOdometer).toBe(30000);

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

      const equalReturn = await apiFetch(`/api/locations/${location.id}/return`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ endOdometer: 30000, endFuelLevel: 60, damages: [] }),
      });
      expect(equalReturn.status).toBe(400);

      const lowerReturn = await apiFetch(`/api/locations/${location.id}/return`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ endOdometer: 29999, endFuelLevel: 60, damages: [] }),
      });
      expect(lowerReturn.status).toBe(400);

      const higherReturn = await apiFetch(`/api/locations/${location.id}/return`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ endOdometer: 30150, endFuelLevel: 60, damages: [] }),
      });
      expect(higherReturn.status).toBe(200);
      const returned = await higherReturn.json();
      expect(returned.location.status).toBe("COMPLETED");
      expect(returned.location.endOdometer).toBe(30150);
    });

    it("limite historique documentée : un contrat converti AVANT ce correctif (startOdometer null) n'a toujours aucun contrôle de retour — comportement inchangé, pas falsifié rétroactivement", async () => {
      // POST /api/reservations/[id]/convert refuse désormais toute conversion sans
      // startOdometer (voir test ci-dessus) : il est donc impossible de reproduire un contrat
      // historique en passant par la route elle-même. On simule fidèlement l'état laissé par
      // l'ancien code en appelant directement `createLocation` (src/lib/locations.ts) sans
      // startOdometer — cette fonction, elle, n'a jamais imposé sa présence (seule la route
      // l'exige désormais) : c'est exactement le chemin qu'empruntait une conversion avant ce
      // correctif. Aucune donnée réelle n'est falsifiée : ce test construit son propre
      // contrat de test pour représenter l'état historique, il ne modifie aucun contrat
      // existant.
      const historicalClient = await createClient({
        tenantId: adminA.tenantId,
        name: `Historique SansOdometre ${runId}`,
        firstName: "HistoriqueSansOdometre",
        lastName: `Convert-${runId}`,
        licenseExpiryDate: new Date("2099-12-31"),
        birthDate: new Date("1990-01-01"),
      });
      const location = await createLocation({
        tenantId: adminA.tenantId,
        agencyId: agencyA1Id,
        vehicleId: vehicleAId,
        clientId: historicalClient.id,
        startDate: new Date("2036-03-05"),
        endDate: new Date("2036-03-07"),
      });
      expect(location.startOdometer).toBeNull();
      await createInvoice({ tenantId: adminA.tenantId, locationId: location.id });

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

      // Sans startOdometer connu, assertValidOdometer (src/lib/location-return.ts) ne peut pas
      // comparer — un retour à n'importe quel kilométrage reste accepté, limite historique
      // documentée (TESTREPORT.md), jamais résolue rétroactivement par falsification de données.
      const anyReturn = await apiFetch(`/api/locations/${location.id}/return`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ endOdometer: 1, endFuelLevel: 50, damages: [] }),
      });
      expect(anyReturn.status).toBe(200);
    });
  });
});

describe("POST /api/reservations/[id]/convert — surclassement (campagne QA, 2026-08-27, passe de correction obligatoire)", () => {
  let suvVehicleId: string;
  let citadineTwinVehicleId: string;
  // Catégorie dédiée, unique à cette exécution (jamais partagée avec vehicleAId/"Citadine" ni
  // aucune autre fixture du fichier) — nécessaire pour les tests UNAVAILABILITY, qui doivent
  // contrôler exhaustivement "combien de véhicules de cette catégorie existent et leur statut"
  // sans risquer l'interférence d'un véhicule "Citadine" créé par un describe sans rapport.
  const scarceCategoryName = `UpgradeScarce-${runId}`;
  let scarceVehicleId: string;

  // Compteur de dates (campagne QA, 2026-08-27) : chaque appel renvoie une période de 3 jours
  // non chevauchante avec la précédente — nécessaire car plusieurs tests de ce describe
  // réutilisent le même véhicule (suvVehicleId) ; sans cela, le contrôle de double réservation
  // (déjà couvert ailleurs, voir locations.test.ts) refuserait à tort des scénarios sans rapport
  // avec la disponibilité. Année 2036, jamais utilisée ailleurs dans ce fichier.
  let dateOffset = 0;
  function nextDateRange() {
    dateOffset += 10;
    const start = new Date(Date.UTC(2036, 0, 1 + dateOffset));
    const end = new Date(Date.UTC(2036, 0, 4 + dateOffset));
    return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
  }

  // Seconde agence (campagne QA, partie 3, 2026-08-28 — régression INC-16, isolation agence de
  // isCategoryReallyAvailable) : nécessaire pour prouver qu'un véhicule de la catégorie
  // réservée disponible dans une AUTRE agence du même tenant ne doit jamais empêcher une
  // déclaration UNAVAILABILITY par ailleurs exacte pour l'agence qui traite le contrat.
  let agencyA2Id: string;

  beforeAll(async () => {
    async function createTestVehicle(
      name: string,
      category: string,
      plateSuffix: string,
      vehicleAgencyId: string = agencyA1Id
    ) {
      const response = await apiFetch("/api/vehicles", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({
          agencyId: vehicleAgencyId,
          name,
          licensePlate: `UPG-${plateSuffix}-${runId}`,
          make: "Dacia",
          model: "Duster",
          year: 2023,
          category,
          pricePerDay: 8000,
          chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
          color: "Gris",
          doors: 5,
          seats: 5,
          horsepower: 8,
          powerKW: 90,
          engineSize: 1.5,
        }),
      });
      return (await response.json()).vehicle.id;
    }

    const agencyA2Response = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence A2 (surclassement)", slug: `agence-a2-upgrade-${runId}` }),
    });
    agencyA2Id = (await agencyA2Response.json()).agency.id;

    suvVehicleId = await createTestVehicle("SUV Surclassement", "SUV", "SUV");
    // Véhicule "Citadine" dédié et distinct de vehicleAId (partagé par tout le reste du
    // fichier, avec ses propres dates réservées ailleurs) — évite toute collision de
    // double réservation avec des tests sans rapport.
    citadineTwinVehicleId = await createTestVehicle("Citadine Jumelle", "Citadine", "TWIN");
    scarceVehicleId = await createTestVehicle("Véhicule Catégorie Rare", scarceCategoryName, "SCARCE");
    // Même catégorie que scarceVehicleId mais dans l'agence A2 — reste AVAILABLE en permanence
    // (jamais mis MAINTENANCE par les tests ci-dessous, contrairement à scarceVehicleId).
    await createTestVehicle("Véhicule Catégorie Rare (Agence A2)", scarceCategoryName, "SCARCE-A2", agencyA2Id);
  });

  async function createReservationWithCategory(category: string, overrides: Record<string, unknown> = {}) {
    const { startDate, endDate } = nextDateRange();
    const response = await createReservation(adminA, {
      clientFirstName: "Surclassement",
      clientLastName: `Client-${runId}-${Math.floor(Math.random() * 1_000_000)}`,
      startDate,
      endDate,
      ...overrides,
    });
    const reservation = (await response.json()).reservation;
    // vehicleCategory n'est pas accepté par createReservation() ci-dessus (helper partagé) —
    // renseigné directement via PATCH pour ce describe, sans dépendre d'un champ supplémentaire
    // ajouté au helper commun.
    await apiFetch(`/api/reservations/${reservation.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleCategory: category }),
    });
    return { ...reservation, startDate, endDate, vehicleCategory: category };
  }

  it("1. catégorie identique : aucun surclassement enregistré, prix inchangé", async () => {
    const reservation = await createReservationWithCategory("Citadine");
    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(convertBody(reservation, { vehicleId: citadineTwinVehicleId, pricePerDay: 5000 })),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.upgrade).toBeNull();
    expect(body.location.totalPrice).toBe(5000 * 3);

    const upgradeCount = await prisma.locationUpgrade.count({ where: { locationId: body.location.id } });
    expect(upgradeCount).toBe(0);
  });

  it("2. CUSTOMER_REQUEST : supplément payant, accord client, montant recalculé côté serveur (le total client est ignoré)", async () => {
    const reservation = await createReservationWithCategory("Citadine");
    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, {
          vehicleId: suvVehicleId,
          pricePerDay: 8000,
          upgrade: {
            type: "CUSTOMER_REQUEST",
            dailySupplement: 1500,
            customerConsent: true,
            reason: "Client demande une catégorie supérieure pour le confort.",
            // Champs falsifiés, ignorés par le type UpgradeInput (aucune propriété
            // correspondante) — le serveur ne peut de toute façon pas les lire.
            totalSupplement: 999999,
            assignedCategory: "Berline",
          },
        })
      ),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.upgrade).toBeTruthy();
    expect(body.upgrade.type).toBe("CUSTOMER_REQUEST");
    expect(body.upgrade.reservedCategory).toBe("Citadine");
    expect(body.upgrade.assignedCategory).toBe("SUV"); // jamais "Berline" (falsifié, ignoré)
    expect(body.upgrade.dailySupplement).toBe(1500);
    expect(body.upgrade.daysCount).toBe(3);
    expect(body.upgrade.totalSupplement).toBe(4500); // jamais 999999 (falsifié, ignoré)
    expect(body.upgrade.customerConsent).toBe(true);
    // Prix de base (8000 × 3 = 24000) + supplément (4500) = 28500, jamais un total falsifié.
    expect(body.location.totalPrice).toBe(24000 + 4500);
  });

  it("3. UNAVAILABILITY : gratuit par défaut, justification obligatoire, aucun supplément même si demandé", async () => {
    // Catégorie dédiée à un seul véhicule (scarceVehicleId), mis MAINTENANCE juste pour ce
    // test puis restauré — aucune autre fixture du fichier ne partage cette catégorie unique,
    // contrairement à "Citadine" (utilisée largement ailleurs).
    await prisma.vehicle.update({ where: { id: scarceVehicleId }, data: { status: "MAINTENANCE" } });
    try {
      const reservation = await createReservationWithCategory(scarceCategoryName);
      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(
          convertBody(reservation, {
            vehicleId: suvVehicleId,
            pricePerDay: 8000,
            upgrade: { type: "UNAVAILABILITY", reason: "Aucun véhicule de cette catégorie disponible sur la période." },
          })
        ),
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.upgrade.type).toBe("UNAVAILABILITY");
      expect(body.upgrade.dailySupplement).toBe(0);
      expect(body.upgrade.totalSupplement).toBe(0);
      expect(body.location.totalPrice).toBe(8000 * 3);

      // Un supplément explicitement demandé malgré UNAVAILABILITY est refusé (400), pas
      // silencieusement mis à zéro.
      const reservation2 = await createReservationWithCategory(scarceCategoryName);
      const refused = await apiFetch(`/api/reservations/${reservation2.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(
          convertBody(reservation2, {
            vehicleId: suvVehicleId,
            pricePerDay: 8000,
            upgrade: { type: "UNAVAILABILITY", dailySupplement: 500, reason: "Test" },
          })
        ),
      });
      expect(refused.status).toBe(400);
    } finally {
      await prisma.vehicle.update({ where: { id: scarceVehicleId }, data: { status: "AVAILABLE" } });
    }
  });

  it("refuse UNAVAILABILITY si la catégorie réservée est en réalité disponible (contrôle serveur, pas de confiance dans la déclaration cliente)", async () => {
    // scarceVehicleId reste AVAILABLE ici — la déclaration UNAVAILABILITY est donc fausse.
    const reservation = await createReservationWithCategory(scarceCategoryName);
    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, {
          vehicleId: suvVehicleId,
          pricePerDay: 8000,
          upgrade: { type: "UNAVAILABILITY", reason: "Prétendument indisponible." },
        })
      ),
    });
    expect(response.status).toBe(409);
  });

  it("accepte UNAVAILABILITY quand la catégorie réservée n'est disponible que dans une AUTRE agence du tenant (bug trouvé, campagne QA partie 3, isolation agence de isCategoryReallyAvailable)", async () => {
    // Le véhicule de catégorie scarceCategoryName créé dans agencyA2Id (beforeAll) reste
    // AVAILABLE en permanence. Avant le correctif, isCategoryReallyAvailable cherchait un
    // véhicule disponible sur tout le tenant (toutes agences confondues) et aurait donc trouvé
    // ce véhicule d'agence A2, refusant à tort (409) une déclaration UNAVAILABILITY pourtant
    // exacte pour l'agence A1 (aucun véhicule de cette catégorie n'y est disponible : le seul,
    // scarceVehicleId, est mis MAINTENANCE juste pour ce test puis restauré).
    await prisma.vehicle.update({ where: { id: scarceVehicleId }, data: { status: "MAINTENANCE" } });
    try {
      const reservation = await createReservationWithCategory(scarceCategoryName);
      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(
          convertBody(reservation, {
            vehicleId: suvVehicleId,
            pricePerDay: 8000,
            upgrade: {
              type: "UNAVAILABILITY",
              reason: "Aucun véhicule de cette catégorie disponible dans cette agence.",
            },
          })
        ),
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.upgrade.type).toBe("UNAVAILABILITY");
      expect(body.upgrade.totalSupplement).toBe(0);
    } finally {
      await prisma.vehicle.update({ where: { id: scarceVehicleId }, data: { status: "AVAILABLE" } });
    }
  });

  /** INC-19 (INCIDENTS.md) : `isCategoryReallyAvailable` (src/lib/location-upgrades.ts) ne
   * vérifiait jusqu'ici que `Vehicle.status` (MAINTENANCE/TRANSFERRING/ON_TRIP), jamais
   * `Vehicle.deactivatedAt` (état administratif séparé introduit par le sprint "statut
   * opérationnel automatique", 2026-08-28) — un véhicule désactivé mais opérationnellement
   * AVAILABLE aurait donc pu compter à tort comme "réellement disponible", refusant à tort
   * (409) une déclaration UNAVAILABILITY par ailleurs exacte. Testé au niveau de la route réelle
   * (POST /api/reservations/[id]/convert), le seul point d'entrée applicatif qui appelle
   * resolveLocationUpgrade/isCategoryReallyAvailable (fonction privée, non exportée) — même
   * convention que le test INC-16 ci-dessus, sur la même fonction. Désactivation/réactivation
   * effectuées par les routes métier réelles (POST /api/vehicles/[id]/deactivate|reactivate),
   * jamais par une écriture Prisma directe simulant l'état. */
  it("INC-19 : un véhicule désactivé administrativement n'est jamais compté comme réellement disponible pour UNAVAILABILITY — la réactivation restaure la vérification normale", async () => {
    const deactivateResponse = await apiFetch(`/api/vehicles/${scarceVehicleId}/deactivate`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "INC-19 : test de non-régression, véhicule rare désactivé" }),
    });
    expect(deactivateResponse.status).toBe(200);

    try {
      // Phase A : seul véhicule de la catégorie dans l'agence A1, mais désactivé — ne doit
      // jamais être retourné/compté par la logique d'upgrade comme "réellement disponible".
      // Sans le correctif INC-19, ce véhicule restant status=AVAILABLE, cette déclaration
      // UNAVAILABILITY aurait été refusée à tort (409, UpgradeCategoryStillAvailableError).
      const reservationDeactivated = await createReservationWithCategory(scarceCategoryName);
      const acceptedResponse = await apiFetch(`/api/reservations/${reservationDeactivated.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(
          convertBody(reservationDeactivated, {
            vehicleId: suvVehicleId,
            pricePerDay: 8000,
            upgrade: {
              type: "UNAVAILABILITY",
              reason: "Le seul véhicule de cette catégorie dans l'agence est désactivé.",
            },
          })
        ),
      });
      expect(acceptedResponse.status).toBe(201);
      const acceptedBody = await acceptedResponse.json();
      expect(acceptedBody.upgrade.type).toBe("UNAVAILABILITY");
      expect(acceptedBody.upgrade.totalSupplement).toBe(0);

      // Contournement direct de l'interface : sélectionner explicitement le véhicule désactivé
      // lui-même comme vehicleId du contrat (plutôt que le SUV) doit rester refusé, quel que
      // soit le surclassement déclaré — garde indépendante (assertVehicleStatusAllowsLocation,
      // src/lib/locations.ts), déjà vérifiée par ailleurs (voir le test "8." plus bas), revérifiée
      // ici pour ce véhicule précis par cohérence du scénario.
      const reservationBypass = await createReservationWithCategory(scarceCategoryName);
      const bypassResponse = await apiFetch(`/api/reservations/${reservationBypass.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(
          convertBody(reservationBypass, {
            vehicleId: scarceVehicleId,
            pricePerDay: 8000,
          })
        ),
      });
      expect(bypassResponse.status).toBe(409);

      // Phase B : réactivation par la route métier réelle — le véhicule redevient réellement
      // disponible, la vérification normale reprend (une déclaration UNAVAILABILITY désormais
      // fausse doit être refusée, exactement comme avant toute désactivation).
      const reactivateResponse = await apiFetch(`/api/vehicles/${scarceVehicleId}/reactivate`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
      });
      expect(reactivateResponse.status).toBe(200);

      const reservationReactivated = await createReservationWithCategory(scarceCategoryName);
      const refusedResponse = await apiFetch(`/api/reservations/${reservationReactivated.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(
          convertBody(reservationReactivated, {
            vehicleId: suvVehicleId,
            pricePerDay: 8000,
            upgrade: { type: "UNAVAILABILITY", reason: "Prétendument indisponible après réactivation." },
          })
        ),
      });
      expect(refusedResponse.status).toBe(409);
    } finally {
      // Restaure l'état de fixture attendu par les autres tests de ce describe (réactivé si la
      // Phase B n'a pas été atteinte à cause d'un échec d'assertion intermédiaire) — via la
      // route métier réelle, jamais une écriture Prisma directe ; sans effet (409, ignoré) si
      // déjà réactivé.
      await apiFetch(`/api/vehicles/${scarceVehicleId}/reactivate`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
      });
    }
  });

  it("4. COMMERCIAL_GESTURE : autorisé avec la permission dédiée, audité", async () => {
    const reservation = await createReservationWithCategory("Citadine");
    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie }, // adminA : ADMIN, bypass toute permission
      body: JSON.stringify(
        convertBody(reservation, {
          vehicleId: suvVehicleId,
          pricePerDay: 8000,
          upgrade: { type: "COMMERCIAL_GESTURE", dailySupplement: 200, reason: "Geste commercial client fidèle." },
        })
      ),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.upgrade.type).toBe("COMMERCIAL_GESTURE");
    expect(body.upgrade.totalSupplement).toBe(600);

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, action: "location.upgraded", resourceId: body.location.id },
    });
    expect(audit).toBeTruthy();
    const metadata = audit?.metadata as Record<string, unknown>;
    expect(metadata.upgradeType).toBe("COMMERCIAL_GESTURE");
    expect(metadata.reservedCategory).toBe("Citadine");
    expect(metadata.assignedCategory).toBe("SUV");
  });

  it("19. refuse COMMERCIAL_GESTURE sans la permission locations.upgrade.commercial_gesture (non accordée par défaut)", async () => {
    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: `NoCommercialGesture-${runId}`,
        permissions: ["reservations.view", "reservations.convert", "vehicles.view", "agencies.view"],
      }),
    });
    const groupId = (await groupResponse.json()).group.id;
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Commercial Gesture",
      email: `no-commercial-gesture-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${member.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: groupId }),
    });

    const reservation = await createReservationWithCategory("Citadine");
    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, {
          vehicleId: suvVehicleId,
          pricePerDay: 8000,
          upgrade: { type: "COMMERCIAL_GESTURE", dailySupplement: 0, reason: "Tentative sans permission." },
        })
      ),
    });
    expect(response.status).toBe(403);

    const reservationAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reservationAfter.status).toBe("PENDING");
    expect(reservationAfter.convertedLocationId).toBeNull();
  });

  it("5/6. refuse un changement de catégorie non déclaré (aucun objet upgrade fourni) — pas de hiérarchie de catégories dans le produit, voir src/lib/location-upgrades.ts", async () => {
    const reservation = await createReservationWithCategory("Citadine");
    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(convertBody(reservation, { vehicleId: suvVehicleId, pricePerDay: 8000 })),
    });
    expect(response.status).toBe(400);

    // Scopé aux dates de cette réservation précise (suvVehicleId est réutilisé par d'autres
    // tests de ce describe, avec leurs propres périodes non chevauchantes) — pas un décompte
    // absolu du véhicule.
    const locationCount = await prisma.location.count({
      where: { vehicleId: suvVehicleId, tenantId: adminA.tenantId, startDate: new Date(reservation.startDate) },
    });
    expect(locationCount).toBe(0);

    const reservationAfter = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(reservationAfter.status).toBe("PENDING");
  });

  it("refuse un objet upgrade fourni alors que les catégories concordent (rien à déclarer)", async () => {
    const reservation = await createReservationWithCategory("Citadine");
    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, {
          vehicleId: vehicleAId,
          pricePerDay: 5000,
          upgrade: { type: "CUSTOMER_REQUEST", dailySupplement: 100, customerConsent: true, reason: "Inutile" },
        })
      ),
    });
    expect(response.status).toBe(400);
  });

  it("type de surclassement invalide refusé", async () => {
    const reservation = await createReservationWithCategory("Citadine");
    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, {
          vehicleId: suvVehicleId,
          pricePerDay: 8000,
          upgrade: { type: "FREE_UPGRADE_INVENTED", reason: "Type inconnu" },
        })
      ),
    });
    expect(response.status).toBe(400);
  });

  it("12/14. motif absent refusé (les trois types)", async () => {
    for (const type of ["CUSTOMER_REQUEST", "UNAVAILABILITY", "COMMERCIAL_GESTURE"]) {
      const reservation = await createReservationWithCategory("Citadine");
      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(
          convertBody(reservation, {
            vehicleId: suvVehicleId,
            pricePerDay: 8000,
            upgrade: { type, dailySupplement: type === "UNAVAILABILITY" ? 0 : 100, customerConsent: true },
          })
        ),
      });
      expect(response.status).toBe(400);
    }
  });

  it("13. accord client absent refusé (CUSTOMER_REQUEST)", async () => {
    const reservation = await createReservationWithCategory("Citadine");
    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, {
          vehicleId: suvVehicleId,
          pricePerDay: 8000,
          upgrade: { type: "CUSTOMER_REQUEST", dailySupplement: 100, reason: "Sans accord" },
        })
      ),
    });
    expect(response.status).toBe(400);
  });

  it("16. supplément négatif refusé (CUSTOMER_REQUEST et COMMERCIAL_GESTURE)", async () => {
    for (const type of ["CUSTOMER_REQUEST", "COMMERCIAL_GESTURE"]) {
      const reservation = await createReservationWithCategory("Citadine");
      const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(
          convertBody(reservation, {
            vehicleId: suvVehicleId,
            pricePerDay: 8000,
            // forceCreateClient (même correctif que les tests de répétition second conducteur
            // plus haut) : ce test porte sur le rejet du supplément négatif, pas sur la
            // détection de doublon — évite une collision floue accidentelle (Levenshtein < 3)
            // avec l'un des nombreux autres clients "Surclassement Client-..." créés ailleurs
            // dans ce fichier lors d'une exécution complète de la suite.
            forceCreateClient: true,
            upgrade: { type, dailySupplement: -100, customerConsent: true, reason: "Négatif" },
          })
        ),
      });
      expect(response.status).toBe(400);
    }
  });

  it("CUSTOMER_REQUEST refuse un supplément nul ou absent (payant par défaut, distinct d'UNAVAILABILITY)", async () => {
    const reservation = await createReservationWithCategory("Citadine");
    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, {
          vehicleId: suvVehicleId,
          pricePerDay: 8000,
          upgrade: { type: "CUSTOMER_REQUEST", dailySupplement: 0, customerConsent: true, reason: "Gratuit demandé" },
        })
      ),
    });
    expect(response.status).toBe(400);
  });

  it("22/23/24/25. audit, facture et paiement cohérents avec le total recalculé (supplément inclus)", async () => {
    const reservation = await createReservationWithCategory("Citadine");
    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, {
          vehicleId: suvVehicleId,
          pricePerDay: 8000,
          upgrade: {
            type: "CUSTOMER_REQUEST",
            dailySupplement: 1000,
            customerConsent: true,
            reason: "Confort",
          },
          payment: { method: "CASH", amount: 27000 }, // 24000 + 3000 (1000 × 3 jours)
        })
      ),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.totalPrice).toBe(27000);
    expect(body.invoice.subtotal).toBe(27000);
    expect(body.invoice.totalAmount).toBe(27000);
    expect(body.invoice.status).toBe("PAID");
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0].amount).toBe(27000);

    // Catégorie réservée/attribuée conservées telles quelles (point 25).
    const stored = await prisma.locationUpgrade.findUnique({ where: { locationId: body.location.id } });
    expect(stored?.reservedCategory).toBe("Citadine");
    expect(stored?.assignedCategory).toBe("SUV");
    expect(stored?.validatedByUserId).toBe(adminA.userId);
  });

  it("8. véhicule désactivé refusé même avec un surclassement déclaré (la garde createLocation s'applique inchangée)", async () => {
    const deactivatedVehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId: agencyA1Id,
        name: "SUV Désactivé",
        licensePlate: `UPG-DEACTIVATED-${runId}`,
        make: "Dacia",
        model: "Duster",
        year: 2023,
        category: "SUV",
        pricePerDay: 8000,
        chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
        color: "Gris",
        doors: 5,
        seats: 5,
        horsepower: 8,
        powerKW: 90,
        engineSize: 1.5,
      }),
    });
    const deactivatedVehicleId = (await deactivatedVehicleResponse.json()).vehicle.id;
    await prisma.vehicle.update({
      where: { id: deactivatedVehicleId },
      data: { deactivatedAt: new Date(), deactivatedReason: "Test désactivation", deactivatedById: adminA.userId },
    });

    const reservation = await createReservationWithCategory("Citadine");
    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, {
          vehicleId: deactivatedVehicleId,
          pricePerDay: 8000,
          upgrade: { type: "CUSTOMER_REQUEST", dailySupplement: 100, customerConsent: true, reason: "Test désactivation" },
        })
      ),
    });
    expect(response.status).toBe(409);

    const upgradeCount = await prisma.locationUpgrade.count({ where: { vehicleId: deactivatedVehicleId } });
    expect(upgradeCount).toBe(0);
  });
});

describe("Sprint 26A (Finding A) — conversion atomique et idempotente sous concurrence", () => {
  let convertBodyCounter = 0;

  /** Même forme que `convertBody` du describe précédent (réimplémentée localement, hors de
   * portée) — corps minimal valide (véhicule + dates + identité client complète). */
  function convertBody(
    reservation: { startDate: string; endDate: string; clientFirstName: string; clientLastName: string },
    overrides: Record<string, unknown> = {}
  ) {
    convertBodyCounter += 1;
    return {
      vehicleId: vehicleAId,
      startDate: reservation.startDate,
      endDate: reservation.endDate,
      // Correctif F-3 (second passage, DOMAINRULES.md section 68) : startOdometer est
      // désormais obligatoire côté serveur — valeur par défaut réaliste ici pour ne pas
      // polluer les tests qui ne portent pas spécifiquement sur ce champ (voir le describe
      // dédié "kilométrage/carburant de départ à la conversion (finding F-3)" plus bas, qui
      // l'écrase explicitement via overrides pour couvrir les cas manquant/invalide).
      startOdometer: 10000,
      client: {
        firstName: reservation.clientFirstName,
        lastName: reservation.clientLastName,
        address: "12 rue des Fleurs",
        city: "Casablanca",
        country: "Maroc",
        idNumber: `S26A-${runId}-${convertBodyCounter}`,
        licenseNumber: `S26AP-${runId}-${convertBodyCounter}`,
        licenseIssueDate: "2020-01-01",
        licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01",
      },
      ...overrides,
    };
  }

  async function countMoneyRows(locationIds: string[]) {
    const [locations, invoices, payments, cashEntries] = await Promise.all([
      prisma.location.count({ where: { id: { in: locationIds.length > 0 ? locationIds : ["__none__"] } } }),
      prisma.invoice.count({ where: { locationId: { in: locationIds.length > 0 ? locationIds : ["__none__"] } } }),
      prisma.payment.count({
        where: { invoice: { locationId: { in: locationIds.length > 0 ? locationIds : ["__none__"] } } },
      }),
      prisma.cashEntry.count({ where: { contractId: { in: locationIds.length > 0 ? locationIds : ["__none__"] } } }),
    ]);
    return { locations, invoices, payments, cashEntries };
  }

  it("1/2/3/4/5 — deux conversions concurrentes de la même réservation sans paiement : une seule réussit, une seule Location/Invoice créée", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "Concurrent",
      clientLastName: `SansPaiement-${runId}`,
      startDate: "2031-01-05",
      endDate: "2031-01-07",
    });
    const reservation = (await createResponse.json()).reservation;

    const body = convertBody(reservation, { clientFirstName: "Concurrent", clientLastName: `SansPaiement-${runId}` });
    const [responseA, responseB] = await Promise.all([
      apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(body),
      }),
      apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(body),
      }),
    ]);

    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const [jsonA, jsonB] = await Promise.all([responseA.json(), responseB.json()]);
    const winnerJson = responseA.status === 201 ? jsonA : jsonB;

    // Vérification en base, pas seulement les codes HTTP.
    const finalReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(finalReservation.status).toBe("CONVERTED");
    expect(finalReservation.convertedLocationId).toBe(winnerJson.location.id);

    const locationsForVehicle = await prisma.location.findMany({
      where: { vehicleId: vehicleAId, startDate: new Date("2031-01-05") },
    });
    expect(locationsForVehicle).toHaveLength(1);
    expect(locationsForVehicle[0].id).toBe(winnerJson.location.id);

    const counts = await countMoneyRows([winnerJson.location.id]);
    expect(counts.locations).toBe(1);
    expect(counts.invoices).toBe(1);
    expect(counts.payments).toBe(0);
    expect(counts.cashEntries).toBe(0);
  });

  it("2/3/6/7 — deux conversions concurrentes avec paiement simple : un seul Payment, une seule CashEntry créés", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "Concurrent",
      clientLastName: `AvecPaiement-${runId}`,
      startDate: "2031-01-10",
      endDate: "2031-01-11",
    });
    const reservation = (await createResponse.json()).reservation;

    const body = convertBody(reservation, {
      clientFirstName: "Concurrent",
      clientLastName: `AvecPaiement-${runId}`,
      payment: { method: "CASH", partial: false },
    });
    const [responseA, responseB] = await Promise.all([
      apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(body),
      }),
      apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(body),
      }),
    ]);

    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winnerResponse = responseA.status === 201 ? responseA : responseB;
    const winnerJson = await winnerResponse.json();
    expect(winnerJson.paymentError).toBeNull();
    expect(winnerJson.payments).toHaveLength(1);
    expect(winnerJson.invoice.status).toBe("PAID");

    const counts = await countMoneyRows([winnerJson.location.id]);
    expect(counts.locations).toBe(1);
    expect(counts.invoices).toBe(1);
    expect(counts.payments).toBe(1);
    expect(counts.cashEntries).toBe(1);

    // Aucun client orphelin issu de la conversion perdante : un seul client "Concurrent
    // AvecPaiement-<runId>" doit exister au total (la conversion perdante n'a jamais atteint
    // l'étape de résolution du client, refusée dès le claim de la réservation).
    const matchingClients = await prisma.client.findMany({
      where: { tenantId: adminA.tenantId, lastName: `AvecPaiement-${runId}` },
    });
    expect(matchingClients).toHaveLength(1);
  });

  it("8 — rollback complet si une étape échoue après le claim (véhicule devenu indisponible)", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "Rollback",
      clientLastName: `Echec-${runId}`,
      startDate: "2031-02-01",
      endDate: "2031-02-03",
    });
    const reservation = (await createResponse.json()).reservation;
    expect(reservation.status).toBe("PENDING");

    // Un contrat déjà confirmé occupe le véhicule sur exactement la même période — createLocation
    // (appelée après le claim, à l'intérieur de la transaction) échouera donc avec
    // VehicleNotAvailableError, après que claimReservationConversion a déjà réservé la conversion.
    const conflictingLocationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId: vehicleAId,
        clientId: (
          await (
            await apiFetch("/api/clients", {
              method: "POST",
              headers: { Cookie: adminA.sessionCookie },
              body: JSON.stringify({ name: `Occupant-${runId}`, licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
            })
          ).json()
        ).client.id,
        startDate: "2031-02-01",
        endDate: "2031-02-03",
        status: "CONFIRMED",
      }),
    });
    expect(conflictingLocationResponse.status).toBe(201);

    const clientCountBefore = await prisma.client.count({ where: { tenantId: adminA.tenantId } });

    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(convertBody(reservation, { clientFirstName: "Rollback", clientLastName: `Echec-${runId}` })),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain("disponible");

    // Rollback complet : la réservation redevient PENDING (jamais restée bloquée à CONVERTED
    // sans Location associée), aucun client/Location/Invoice n'a été créé par cette tentative.
    const finalReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(finalReservation.status).toBe("PENDING");
    expect(finalReservation.convertedLocationId).toBeNull();

    const clientCountAfter = await prisma.client.count({ where: { tenantId: adminA.tenantId } });
    expect(clientCountAfter).toBe(clientCountBefore);

    const locationsForThisAttempt = await prisma.location.findMany({
      where: { vehicleId: vehicleAId, startDate: new Date("2031-02-01"), status: { not: "CONFIRMED" } },
    });
    expect(locationsForThisAttempt).toHaveLength(0);
  });

  it("9 — non-régression : une conversion simple valide fonctionne toujours de bout en bout", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "NonRegression",
      clientLastName: `Simple-${runId}`,
      startDate: "2031-03-01",
      endDate: "2031-03-03",
    });
    const reservation = (await createResponse.json()).reservation;

    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, { clientFirstName: "NonRegression", clientLastName: `Simple-${runId}` })
      ),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.reservation.status).toBe("CONVERTED");
    expect(body.reservation.convertedLocationId).toBe(body.location.id);
    expect(body.location.vehicleId).toBe(vehicleAId);
    expect(body.location.agencyId).toBe(agencyA1Id);
    expect(body.invoice).not.toBeNull();
    expect(body.invoice.locationId).toBe(body.location.id);
    expect(body.paymentError).toBeNull();
  });

  it("10 — isolation tenant/agence et permission préservées après le passage à la transaction partagée", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "Isolation",
      clientLastName: `Tenant-${runId}`,
      startDate: "2031-04-01",
      endDate: "2031-04-03",
    });
    const reservation = (await createResponse.json()).reservation;

    // Tenant B (aucun accès à cette réservation ni à ce véhicule) ne peut pas la convertir.
    const crossTenantResponse = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, { clientFirstName: "Isolation", clientLastName: `Tenant-${runId}` })
      ),
    });
    expect(crossTenantResponse.status).toBe(404);

    // La réservation reste intacte (jamais réclamée par une transaction qui échoue avant le
    // claim, faute d'accès) et reste convertible normalement par le bon tenant ensuite.
    const untouchedReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(untouchedReservation.status).toBe("PENDING");

    // Sans la permission reservations.convert (groupe personnalisé sans cette clé — un
    // nouveau MEMBER sans groupe assigné retombe par défaut sur le groupe MEMBER, qui
    // accorde reservations.convert, DOMAINRULES.md section 15/22 : il faut un groupe
    // explicite pour tester un vrai refus de permission), refus avant même l'ouverture de la
    // transaction.
    const noConvertGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoConvert-${runId}`, permissions: ["reservations.view"] }),
    });
    const noConvertGroupId = (await noConvertGroupResponse.json()).group.id;

    const noPermissionMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "No Convert Permission",
      email: `no-convert-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await apiFetch(`/api/users/${noPermissionMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: noConvertGroupId }),
    });

    const noPermissionResponse = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: noPermissionMember.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, { clientFirstName: "Isolation", clientLastName: `Tenant-${runId}` })
      ),
    });
    expect(noPermissionResponse.status).toBe(403);

    const stillUntouchedReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(stillUntouchedReservation.status).toBe("PENDING");

    // Conversion normale par adminA, toujours fonctionnelle.
    const okResponse = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, { clientFirstName: "Isolation", clientLastName: `Tenant-${runId}` })
      ),
    });
    expect(okResponse.status).toBe(201);
  });

  it("11 — rollback après échec d'un paiement simple (montant délibérément supérieur au solde restant) : réservation CONFIRMED restaurée, aucune donnée orpheline", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "RollbackPaiement",
      clientLastName: `Simple-${runId}`,
      startDate: "2031-05-01",
      endDate: "2031-05-03",
    });
    const reservation = (await createResponse.json()).reservation;
    expect(reservation.status).toBe("PENDING");

    // La réservation est initialement CONFIRMED (exigence du scénario).
    const confirmResponse = await apiFetch(`/api/reservations/${reservation.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(confirmResponse.status).toBe(200);
    expect((await confirmResponse.json()).reservation.status).toBe("CONFIRMED");

    const clientCountBefore = await prisma.client.count({ where: { tenantId: adminA.tenantId } });
    const registerBefore = await prisma.cashRegister.findUnique({ where: { tenantId: adminA.tenantId } });

    // Montant délibérément et déterministement supérieur au total facturé (véhicule à
    // 5000 centimes/jour × 2 jours = 10000) — déclenche, à l'intérieur de la transaction, le
    // contrôle de solde de processLocationPayment *après* que la Location et l'Invoice aient
    // déjà été créées (étapes 7/9 de la transaction de conversion), sans dépendre d'un
    // timing ni d'une concurrence réelle : ce montant dépasse le solde quel que soit l'ordre
    // d'exécution.
    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify(
        convertBody(reservation, {
          clientFirstName: "RollbackPaiement",
          clientLastName: `Simple-${runId}`,
          payment: { method: "CASH", partial: true, amount: 999_999 },
        })
      ),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain("dépasse");

    // Rollback complet : la réservation redevient CONFIRMED (son statut initial, jamais
    // restée bloquée à CONVERTED), aucune Location/Invoice/Payment/CashEntry issue de cette
    // tentative ne subsiste, aucun client créé uniquement pour elle ne reste, et le solde de
    // caisse persisté n'a pas bougé (comparé sans appeler recomputeCashRegisterBalance entre
    // les deux relevés, pour vérifier l'état brut réellement persisté).
    const finalReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(finalReservation.status).toBe("CONFIRMED");
    expect(finalReservation.convertedLocationId).toBeNull();

    const locationsForThisAttempt = await prisma.location.findMany({
      where: { vehicleId: vehicleAId, startDate: new Date("2031-05-01") },
    });
    expect(locationsForThisAttempt).toHaveLength(0);

    const clientCountAfter = await prisma.client.count({ where: { tenantId: adminA.tenantId } });
    expect(clientCountAfter).toBe(clientCountBefore);

    const registerAfter = await prisma.cashRegister.findUnique({ where: { tenantId: adminA.tenantId } });
    expect(registerAfter?.currentBalance).toBe(registerBefore?.currentBalance);
    expect(registerAfter?.previousBalance).toBe(registerBefore?.previousBalance);
  });

  it("12 — rollback après échec de la 2e ligne d'un paiement mixte : la 1re ligne réellement écrite dans la transaction est annulée avec le reste", async () => {
    // processLocationPayment (src/lib/location-payment.ts) valide le total d'un paiement
    // mixte contre le solde restant *avant* d'écrire la moindre ligne (correctif Sprint
    // 14B) — un scénario « 1re ligne déjà écrite, 2e ligne refusée » n'est donc plus jamais
    // atteignable via POST /api/reservations/[id]/convert lui-même, par construction (et par
    // conception : c'est précisément ce que ce correctif empêche, indépendamment du Finding
    // A — hors périmètre de modification ici, voir Finding B). Pour vérifier que le
    // mécanisme de rollback transactionnel du Finding A couvre bien ce cas si une 2e écriture
    // de paiement mixte échouait pour toute autre raison, ce test reproduit fidèlement —
    // avec les mêmes fonctions de production et sous la même transaction Prisma partagée que
    // la route — l'assemblage réel de la conversion jusqu'au paiement (Finding F : finalisation
    // DRAFT → SENT incluse, désormais requise avant tout createPayment), puis appelle
    // createPayment deux fois directement : la 1re ligne (6000) est un montant valide qui
    // s'écrit réellement dans la transaction encore ouverte ; la 2e ligne (5000) dépasse
    // délibérément le solde restant exact (10000 - 6000 = 4000), déclenchant de façon
    // déterministe et isolée PaymentExceedsRemainingBalanceError — sans dépendre d'un timing
    // ni d'une concurrence réelle.
    const createResponse = await createReservation(adminA, {
      clientFirstName: "RollbackMixte",
      clientLastName: `Ligne2-${runId}`,
      startDate: "2031-06-01",
      endDate: "2031-06-03",
    });
    const reservation = (await createResponse.json()).reservation;
    expect(reservation.status).toBe("PENDING");

    const confirmResponse = await apiFetch(`/api/reservations/${reservation.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(confirmResponse.status).toBe(200);

    const clientCountBefore = await prisma.client.count({ where: { tenantId: adminA.tenantId } });
    const registerBefore = await prisma.cashRegister.findUnique({ where: { tenantId: adminA.tenantId } });

    let thrownError: unknown;
    try {
      await prisma.$transaction(async (tx) => {
        await claimReservationConversion(adminA.tenantId, reservation.id, tx);

        const client = await createClient(
          {
            tenantId: adminA.tenantId,
            name: `RollbackMixte Ligne2-${runId}`,
            firstName: "RollbackMixte",
            lastName: `Ligne2-${runId}`,
            licenseExpiryDate: new Date("2099-12-31"),
            birthDate: new Date("1990-01-01"),
          },
          tx
        );

        const location = await createLocation(
          {
            tenantId: adminA.tenantId,
            agencyId: agencyA1Id,
            vehicleId: vehicleAId,
            clientId: client.id,
            startDate: new Date("2031-06-01"),
            endDate: new Date("2031-06-03"),
          },
          tx
        );

        await markReservationConverted(adminA.tenantId, reservation.id, location.id, tx);

        const invoice = await createInvoice({ tenantId: adminA.tenantId, locationId: location.id }, tx);

        // Finding F : un paiement direct est refusé sur une facture encore DRAFT
        // (InvoiceNotFinalizedError) — finalise d'abord dans la même transaction, exactement
        // ce que fait processLocationPayment/finalizeAndPay en production.
        await updateInvoice(adminA.tenantId, invoice.id, { status: "ISSUED" }, tx);

        // Ligne 1 : montant valide, écrite pour de vrai dans cette transaction encore ouverte.
        await createPayment(
          { tenantId: adminA.tenantId, invoiceId: invoice.id, amount: 6_000, method: "CASH" },
          tx
        );

        // Ligne 2 : dépasse délibérément le solde restant exact (10000 - 6000 = 4000).
        await createPayment(
          { tenantId: adminA.tenantId, invoiceId: invoice.id, amount: 5_000, method: "CARD" },
          tx
        );
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(PaymentExceedsRemainingBalanceError);

    // Rollback complet, y compris de la 1re ligne pourtant réellement écrite avant l'échec
    // de la 2e : réservation restaurée à CONFIRMED, aucune Location/Client/Payment/CashEntry
    // issus de cette tentative ne subsistent, et le solde de caisse brut persisté est inchangé.
    const finalReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(finalReservation.status).toBe("CONFIRMED");
    expect(finalReservation.convertedLocationId).toBeNull();

    const locationsForThisAttempt = await prisma.location.findMany({
      where: { vehicleId: vehicleAId, startDate: new Date("2031-06-01") },
    });
    expect(locationsForThisAttempt).toHaveLength(0);

    const clientCountAfter = await prisma.client.count({ where: { tenantId: adminA.tenantId } });
    expect(clientCountAfter).toBe(clientCountBefore);

    // Aucune trace de la 1re ligne (6000, CASH) réellement écrite dans la transaction avant
    // l'échec de la 2e — Invoice.amountPaid/status n'existent même plus (l'Invoice elle-même
    // a été annulée avec le reste, jamais laissée dans un état "partiellement payé").
    const paymentsForThisAttempt = await prisma.payment.count({
      where: { tenantId: adminA.tenantId, amount: 6_000, method: "CASH" },
    });
    expect(paymentsForThisAttempt).toBe(0);
    const cashEntriesForThisAttempt = await prisma.cashEntry.count({
      where: { tenantId: adminA.tenantId, amount: 6_000, paymentMethod: "CASH" },
    });
    expect(cashEntriesForThisAttempt).toBe(0);

    const registerAfter = await prisma.cashRegister.findUnique({ where: { tenantId: adminA.tenantId } });
    expect(registerAfter?.currentBalance).toBe(registerBefore?.currentBalance);
    expect(registerAfter?.previousBalance).toBe(registerBefore?.previousBalance);
  });
});

describe("Sprint 26C, Finding C — verrou Vehicle en conversion, sous concurrence avec une création directe ou une autre conversion", () => {
  let convertBodyCounter = 0;

  /** Même forme que `convertBody` du describe Finding A ci-dessus (réimplémentée localement,
   * hors de portée) — corps minimal valide (véhicule + dates + identité client complète). */
  function convertBody(
    reservation: { startDate: string; endDate: string; clientFirstName: string; clientLastName: string },
    overrides: Record<string, unknown> = {}
  ) {
    convertBodyCounter += 1;
    return {
      vehicleId: vehicleAId,
      startDate: reservation.startDate,
      endDate: reservation.endDate,
      // Correctif F-3 (second passage, DOMAINRULES.md section 68) : startOdometer est
      // désormais obligatoire côté serveur — valeur par défaut réaliste ici pour ne pas
      // polluer les tests qui ne portent pas spécifiquement sur ce champ (voir le describe
      // dédié "kilométrage/carburant de départ à la conversion (finding F-3)" plus bas, qui
      // l'écrase explicitement via overrides pour couvrir les cas manquant/invalide).
      startOdometer: 10000,
      client: {
        firstName: reservation.clientFirstName,
        lastName: reservation.clientLastName,
        address: "12 rue des Fleurs",
        city: "Casablanca",
        country: "Maroc",
        idNumber: `S26C-${runId}-${convertBodyCounter}`,
        licenseNumber: `S26CP-${runId}-${convertBodyCounter}`,
        licenseIssueDate: "2020-01-01",
        licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01",
      },
      ...overrides,
    };
  }

  it("Test 2 — conversion concurrente avec une création directe, même véhicule, dates chevauchantes : une seule réussite, aucune Location orpheline, écritures liées cohérentes", async () => {
    const createResponse = await createReservation(adminA, {
      clientFirstName: "ConvertVsDirect",
      clientLastName: `${runId}`,
      startDate: "2032-01-05",
      endDate: "2032-01-07",
    });
    const reservation = (await createResponse.json()).reservation;

    const directClient = await createClient({
      tenantId: adminA.tenantId,
      name: `Direct Client ${runId}`,
      firstName: "Direct",
      lastName: `Client-${runId}`,
      licenseExpiryDate: new Date("2099-12-31"),
      birthDate: new Date("1990-01-01"),
    });

    const [convertResponse, directResponse] = await Promise.all([
      apiFetch(`/api/reservations/${reservation.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(convertBody(reservation)),
      }),
      apiFetch("/api/locations", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({
          vehicleId: vehicleAId,
          clientId: directClient.id,
          startDate: "2032-01-06",
          endDate: "2032-01-09",
        }),
      }),
    ]);

    const statuses = [convertResponse.status, directResponse.status].sort();
    expect(statuses).toEqual([201, 409]);

    const finalReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });

    if (convertResponse.status === 201) {
      const convertedBody = await convertResponse.json();
      expect(finalReservation.status).toBe("CONVERTED");
      expect(finalReservation.convertedLocationId).toBe(convertedBody.location.id);

      // Écritures liées : exactement une Location et une Invoice pour ce contrat (aucun
      // paiement demandé dans ce scénario, donc pas de Payment/CashEntry à vérifier ici).
      const [locationCount, invoiceCount] = await Promise.all([
        prisma.location.count({ where: { id: convertedBody.location.id } }),
        prisma.invoice.count({ where: { locationId: convertedBody.location.id } }),
      ]);
      expect(locationCount).toBe(1);
      expect(invoiceCount).toBe(1);
    } else {
      // La conversion a perdu : rollback complet — la réservation n'est ni CONVERTED ni
      // partiellement rattachée à une Location (aucune Location orpheline pour cette tentative).
      expect(finalReservation.status).not.toBe("CONVERTED");
      expect(finalReservation.convertedLocationId).toBeNull();
    }

    // Dans les deux cas : une seule Location bloquante pour ce véhicule sur cette fenêtre.
    const blocking = await prisma.location.findMany({
      where: {
        vehicleId: vehicleAId,
        status: { in: ["PENDING", "CONFIRMED", "ACTIVE"] },
        startDate: { lt: new Date("2032-01-09") },
        endDate: { gt: new Date("2032-01-05") },
      },
    });
    expect(blocking).toHaveLength(1);
  });

  it("Test 3 — deux conversions de réservations distinctes concurrentes, même véhicule, dates chevauchantes : une seule réussite, état des réservations cohérent", async () => {
    const [createResponse1, createResponse2] = await Promise.all([
      createReservation(adminA, {
        clientFirstName: "ConvertVsConvert1",
        clientLastName: `${runId}`,
        startDate: "2032-02-05",
        endDate: "2032-02-07",
      }),
      createReservation(adminA, {
        clientFirstName: "ConvertVsConvert2",
        clientLastName: `${runId}`,
        startDate: "2032-02-06",
        endDate: "2032-02-09",
      }),
    ]);
    const reservation1 = (await createResponse1.json()).reservation;
    const reservation2 = (await createResponse2.json()).reservation;

    const [response1, response2] = await Promise.all([
      apiFetch(`/api/reservations/${reservation1.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(convertBody(reservation1)),
      }),
      apiFetch(`/api/reservations/${reservation2.id}/convert`, {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify(convertBody(reservation2)),
      }),
    ]);

    const statuses = [response1.status, response2.status].sort();
    expect(statuses).toEqual([201, 409]);

    const [finalReservation1, finalReservation2] = await Promise.all([
      prisma.reservation.findUniqueOrThrow({ where: { id: reservation1.id } }),
      prisma.reservation.findUniqueOrThrow({ where: { id: reservation2.id } }),
    ]);

    const winner = response1.status === 201 ? finalReservation1 : finalReservation2;
    const loser = response1.status === 201 ? finalReservation2 : finalReservation1;

    expect(winner.status).toBe("CONVERTED");
    expect(winner.convertedLocationId).not.toBeNull();

    // Rollback complet côté perdant : réservation revenue à son état d'avant tentative (jamais
    // CONVERTED, jamais rattachée) — preuve que claimReservationConversion (Finding A), pourtant
    // acquis avec succès pour les deux réservations distinctes (aucune contention entre elles,
    // deux lignes Reservation différentes), est bien défait quand le verrou Vehicle partagé
    // (Finding C) échoue plus loin dans la même transaction.
    expect(loser.status).toBe("PENDING");
    expect(loser.convertedLocationId).toBeNull();

    const blocking = await prisma.location.findMany({
      where: {
        vehicleId: vehicleAId,
        status: { in: ["PENDING", "CONFIRMED", "ACTIVE"] },
        startDate: { lt: new Date("2032-02-09") },
        endDate: { gt: new Date("2032-02-05") },
      },
    });
    expect(blocking).toHaveLength(1);
    expect(blocking[0].id).toBe(winner.convertedLocationId);
  });
});

describe("Sprint 24 — reservations.confirm/cancel/no_show séparées de reservations.edit", () => {
  /** Crée un groupe portant exactement `permissions`, un MEMBER rattaché à agencyA1Id et
   * assigné à ce groupe — même pattern que le test "convertOnlyMember" ci-dessus. */
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

  it("reservations.edit seul ne permet plus de confirmer, annuler, ni marquer No Show", async () => {
    const editOnly = await createGroupAndMember("EditOnly", [
      "reservations.view",
      "reservations.edit",
    ]);

    const createResponse = await createReservation(adminA, {
      clientLastName: `EditOnly-${runId}`,
      pickupAgency: "Agence A1",
    });
    const reservation = (await createResponse.json()).reservation;

    for (const status of ["CONFIRMED", "CANCELLED", "NO_SHOW"]) {
      const response = await apiFetch(`/api/reservations/${reservation.id}`, {
        method: "PATCH",
        headers: { Cookie: editOnly.sessionCookie },
        body: JSON.stringify({ status }),
      });
      expect(response.status).toBe(403);
    }

    // reservations.edit reste suffisant pour un champ générique (non lié au statut).
    const notesResponse = await apiFetch(`/api/reservations/${reservation.id}`, {
      method: "PATCH",
      headers: { Cookie: editOnly.sessionCookie },
      body: JSON.stringify({ notes: "Note ajoutée par EditOnly" }),
    });
    expect(notesResponse.status).toBe(200);
  });

  it("reservations.confirm seul permet de confirmer, sans reservations.edit", async () => {
    const confirmOnly = await createGroupAndMember("ConfirmOnly", [
      "reservations.view",
      "reservations.confirm",
    ]);

    const createResponse = await createReservation(adminA, {
      clientLastName: `ConfirmOnly-${runId}`,
      pickupAgency: "Agence A1",
    });
    const reservation = (await createResponse.json()).reservation;

    const confirmResponse = await apiFetch(`/api/reservations/${reservation.id}`, {
      method: "PATCH",
      headers: { Cookie: confirmOnly.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(confirmResponse.status).toBe(200);
    expect((await confirmResponse.json()).reservation.status).toBe("CONFIRMED");

    // Un champ générique reste refusé : reservations.edit n'est pas accordée.
    const notesResponse = await apiFetch(`/api/reservations/${reservation.id}`, {
      method: "PATCH",
      headers: { Cookie: confirmOnly.sessionCookie },
      body: JSON.stringify({ notes: "Tentative" }),
    });
    expect(notesResponse.status).toBe(403);
  });

  it("reservations.cancel seul permet d'annuler, sans reservations.edit", async () => {
    const cancelOnly = await createGroupAndMember("CancelOnly", [
      "reservations.view",
      "reservations.cancel",
    ]);

    const createResponse = await createReservation(adminA, {
      clientLastName: `CancelOnly-${runId}`,
      pickupAgency: "Agence A1",
    });
    const reservation = (await createResponse.json()).reservation;

    const cancelResponse = await apiFetch(`/api/reservations/${reservation.id}`, {
      method: "PATCH",
      headers: { Cookie: cancelOnly.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(cancelResponse.status).toBe(200);
    expect((await cancelResponse.json()).reservation.status).toBe("CANCELLED");
  });

  it("reservations.no_show seul permet de marquer No Show, sans reservations.edit", async () => {
    const noShowOnly = await createGroupAndMember("NoShowOnly", [
      "reservations.view",
      "reservations.no_show",
    ]);

    const createResponse = await createReservation(adminA, {
      clientLastName: `NoShowOnly-${runId}`,
      pickupAgency: "Agence A1",
    });
    const reservation = (await createResponse.json()).reservation;

    const noShowResponse = await apiFetch(`/api/reservations/${reservation.id}`, {
      method: "PATCH",
      headers: { Cookie: noShowOnly.sessionCookie },
      body: JSON.stringify({ status: "NO_SHOW" }),
    });
    expect(noShowResponse.status).toBe(200);
    expect((await noShowResponse.json()).reservation.status).toBe("NO_SHOW");
  });

  it("un ADMIN (super admin du tenant) confirme/annule/marque No Show sans aucun groupe de permissions", async () => {
    const confirmTarget = await createReservation(adminA, {
      clientLastName: `AdminConfirm-${runId}`,
      pickupAgency: "Agence A1",
    });
    const cancelTarget = await createReservation(adminA, {
      clientLastName: `AdminCancel-${runId}`,
      pickupAgency: "Agence A1",
    });
    const noShowTarget = await createReservation(adminA, {
      clientLastName: `AdminNoShow-${runId}`,
      pickupAgency: "Agence A1",
    });

    const confirmResponse = await apiFetch(`/api/reservations/${(await confirmTarget.json()).reservation.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(confirmResponse.status).toBe(200);

    const cancelResponse = await apiFetch(`/api/reservations/${(await cancelTarget.json()).reservation.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(cancelResponse.status).toBe(200);

    const noShowResponse = await apiFetch(`/api/reservations/${(await noShowTarget.json()).reservation.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "NO_SHOW" }),
    });
    expect(noShowResponse.status).toBe(200);
  });
});
