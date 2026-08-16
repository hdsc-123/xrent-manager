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
        licenseExpiryDate: "2099-12-31",
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
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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

describe("POST /api/reservations/[id]/convert", () => {
  /** Corps minimal valide (véhicule + dates + identité client) — Sprint 13D, nouveau
   * contrat de POST /api/reservations/[id]/convert (formulaire de conversion pré-rempli,
   * voir DOMAINRULES.md section 26). */
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
        licenseExpiryDate: "2099-12-31",
      },
      ...overrides,
    };
  }

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
          secondDriver: { firstName: "Second", lastName: "Conducteur", phone: "+212600000000" },
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
  describe("Sprint 28 (Finding E) — véhicule MAINTENANCE/TRANSFERRING/ON_TRIP bloque la conversion", () => {
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
      client: {
        firstName: reservation.clientFirstName,
        lastName: reservation.clientLastName,
        address: "12 rue des Fleurs",
        city: "Casablanca",
        country: "Maroc",
        idNumber: `S26A-${runId}-${convertBodyCounter}`,
        licenseNumber: `S26AP-${runId}-${convertBodyCounter}`,
        licenseIssueDate: "2020-01-01",
        licenseExpiryDate: "2099-12-31",
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
              body: JSON.stringify({ name: `Occupant-${runId}`, licenseExpiryDate: "2099-12-31" }),
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
        await updateInvoice(adminA.tenantId, invoice.id, { status: "SENT" }, tx);

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
      client: {
        firstName: reservation.clientFirstName,
        lastName: reservation.clientLastName,
        address: "12 rue des Fleurs",
        city: "Casablanca",
        country: "Maroc",
        idNumber: `S26C-${runId}-${convertBodyCounter}`,
        licenseNumber: `S26CP-${runId}-${convertBodyCounter}`,
        licenseIssueDate: "2020-01-01",
        licenseExpiryDate: "2099-12-31",
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
