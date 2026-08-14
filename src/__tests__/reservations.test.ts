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
  function convertBody(
    reservation: { startDate: string; endDate: string; clientFirstName: string; clientLastName: string; clientPhone?: string | null },
    overrides: Record<string, unknown> = {}
  ) {
    return {
      vehicleId: vehicleAId,
      startDate: reservation.startDate,
      endDate: reservation.endDate,
      client: {
        firstName: reservation.clientFirstName,
        lastName: reservation.clientLastName,
        phone: reservation.clientPhone ?? undefined,
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
});
