import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { RESERVATION_IMPORT_COLUMNS, RESERVATION_IMPORT_COLUMN_MAP } from "@/lib/reservations";
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
      body: JSON.stringify({ name: `Client Convert ${runId}`, phone: `+21262${runId.slice(-7)}` }),
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
        licenseExpiryDate: "2030-01-01",
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
