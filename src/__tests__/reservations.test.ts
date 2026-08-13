import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { RESERVATION_IMPORT_COLUMNS, RESERVATION_IMPORT_COLUMN_MAP } from "@/lib/reservations";
import { apiFetch } from "./helpers/http";
import { TEST_BASE_URL } from "./helpers/testServer";
import { registerTenantAdmin, type AuthenticatedTestUser } from "./helpers/fixtures";

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

  it("refuse une source invalide", async () => {
    const response = await createReservation(adminA, { source: "AUTRE" });
    expect(response.status).toBe(400);
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
});

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
      body: JSON.stringify({ vehicleId: vehicleAId }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.reservation.status).toBe("CONVERTED");
    expect(body.reservation.convertedLocationId).toBe(body.location.id);
    expect(body.location.vehicleId).toBe(vehicleAId);
    expect(body.location.agencyId).toBe(agencyA1Id);
    expect(body.invoice).not.toBeNull();
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
      body: JSON.stringify({ vehicleId: vehicleAId }),
    });

    const response = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId: vehicleAId }),
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
      body: JSON.stringify({ vehicleId: vehicleAId }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.duplicate.field).toBe("phone");

    const retryResponse = await apiFetch(`/api/reservations/${reservation.id}/convert`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId: vehicleAId, useExistingClientId: body.duplicate.client.id }),
    });
    expect(retryResponse.status).toBe(201);
    const retryBody = await retryResponse.json();
    expect(retryBody.location.clientId).toBe(body.duplicate.client.id);
  });
});
