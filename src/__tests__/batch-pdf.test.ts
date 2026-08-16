import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let admin: AuthenticatedTestUser;
let otherAdmin: AuthenticatedTestUser;
let agencyId: string;
let otherAgencyId: string;
let vehicleId: string;
let clientId: string;

let locationId1: string;
let locationId2: string;
let contractNumber1: string;
let contractNumber2: string;
let invoiceId1: string;
let invoiceId2: string;

let dateOffset = 0;

async function createLocation() {
  dateOffset += 10;
  const base = new Date(Date.UTC(2032, 0, 1));
  const start = new Date(base.getTime() + dateOffset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);

  const response = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      vehicleId,
      clientId,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      payment: { deferred: true },
    }),
  });
  return response.json();
}

beforeAll(async () => {
  admin = await registerTenantAdmin({
    tenantName: "Batch PDF Test",
    tenantSlug: `batch-pdf-test-${runId}`,
    name: "Admin",
    email: `admin-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(admin.tenantId);

  otherAdmin = await registerTenantAdmin({
    tenantName: "Batch PDF Test Other",
    tenantSlug: `batch-pdf-test-other-${runId}`,
    name: "Admin Autre",
    email: `admin-other-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(otherAdmin.tenantId);

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: "Agence Test", slug: `agence-batch-${runId}` }),
  });
  agencyId = (await agencyResponse.json()).agency.id;

  // Sprint 15 : agence d'un autre tenant, utilisée pour vérifier le rejet de agencyId
  // inaccessible (canAccessAgency) sur la sélection par plage de numéros de contrat.
  const otherAgencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: otherAdmin.sessionCookie },
    body: JSON.stringify({ name: "Agence Test Autre Tenant", slug: `agence-batch-other-${runId}` }),
  });
  otherAgencyId = (await otherAgencyResponse.json()).agency.id;

  const vehicleResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      agencyId,
      name: "Clio",
      licensePlate: `BATCH-${runId}`,
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
  vehicleId = (await vehicleResponse.json()).vehicle.id;

  const clientResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: "Client Test", email: `client-batch-${runId}@test.local`, licenseExpiryDate: "2099-12-31" }),
  });
  clientId = (await clientResponse.json()).client.id;

  const first = await createLocation();
  locationId1 = first.location.id;
  contractNumber1 = first.location.contractNumber;
  invoiceId1 = first.invoice.id;

  const second = await createLocation();
  locationId2 = second.location.id;
  contractNumber2 = second.location.contractNumber;
  invoiceId2 = second.invoice.id;
});

afterAll(async () => {
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

describe("POST /api/documents/batch-pdf", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/documents/batch-pdf", {
      method: "POST",
      body: JSON.stringify({ type: "CONTRACT", ids: [locationId1] }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un type invalide", async () => {
    const response = await apiFetch("/api/documents/batch-pdf", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ type: "FOO" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse quand aucun mode de sélection n'est fourni", async () => {
    const response = await apiFetch("/api/documents/batch-pdf", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ type: "CONTRACT" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse quand plusieurs modes de sélection sont fournis à la fois", async () => {
    const response = await apiFetch("/api/documents/batch-pdf", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ type: "CONTRACT", ids: [locationId1], from: "2032-01-01" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse la plage de numéros pour une facture (contrats uniquement)", async () => {
    const response = await apiFetch("/api/documents/batch-pdf", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ type: "INVOICE", contractNumberFrom: 1, contractNumberTo: 2 }),
    });
    expect(response.status).toBe(400);
  });

  it("génère un lot de contrats par sélection d'identifiants", async () => {
    const response = await apiFetch("/api/documents/batch-pdf", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ type: "CONTRACT", ids: [locationId1, locationId2] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });

  it("génère un lot de contrats par plage de numéros", async () => {
    const n1 = Number(contractNumber1.split("-").pop());
    const n2 = Number(contractNumber2.split("-").pop());
    const response = await apiFetch("/api/documents/batch-pdf", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({
        type: "CONTRACT",
        contractNumberFrom: Math.min(n1, n2),
        contractNumberTo: Math.max(n1, n2),
        agencyId,
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });

  it("Sprint 15 — refuse la sélection par plage de numéros sans agencyId", async () => {
    const n1 = Number(contractNumber1.split("-").pop());
    const n2 = Number(contractNumber2.split("-").pop());
    const response = await apiFetch("/api/documents/batch-pdf", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({
        type: "CONTRACT",
        contractNumberFrom: Math.min(n1, n2),
        contractNumberTo: Math.max(n1, n2),
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("agencyId est requis pour la sélection par plage de numéros de contrat.");
  });

  it("Sprint 15 — refuse la sélection par plage de numéros avec un agencyId inaccessible", async () => {
    const n1 = Number(contractNumber1.split("-").pop());
    const n2 = Number(contractNumber2.split("-").pop());
    const response = await apiFetch("/api/documents/batch-pdf", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({
        type: "CONTRACT",
        contractNumberFrom: Math.min(n1, n2),
        contractNumberTo: Math.max(n1, n2),
        agencyId: otherAgencyId,
      }),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Agence introuvable ou inaccessible.");
  });

  it("génère un lot de contrats par plage de dates", async () => {
    const response = await apiFetch("/api/documents/batch-pdf", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ type: "CONTRACT", from: "2032-01-01", to: "2032-12-31" }),
    });
    expect(response.status).toBe(200);
  });

  it("génère un lot de factures par sélection d'identifiants", async () => {
    const response = await apiFetch("/api/documents/batch-pdf", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ type: "INVOICE", ids: [invoiceId1, invoiceId2] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });

  it("isolation multi-tenant : un lot demandé avec des identifiants d'un autre tenant ne retourne rien", async () => {
    const response = await apiFetch("/api/documents/batch-pdf", {
      method: "POST",
      headers: { Cookie: otherAdmin.sessionCookie },
      body: JSON.stringify({ type: "CONTRACT", ids: [locationId1, locationId2] }),
    });
    expect(response.status).toBe(404);
  });

  // Sprint 16 (audit sécurité) : cette route ne vérifiait jusqu'ici aucune permission
  // granulaire (commentaire obsolète, voir route.tsx), contrairement à GET /api/locations et
  // GET /api/invoices — un MEMBER sans locations.view/invoices.view pouvait donc contourner ce
  // gate simplement en passant par le PDF de lot.
  describe("Sprint 16 — permissions granulaires (locations.view/invoices.view)", () => {
    it("refuse un MEMBER sans locations.view (groupe personnalisé vide) sur un lot de contrats", async () => {
      const emptyGroupResponse = await apiFetch("/api/permission-groups", {
        method: "POST",
        headers: { Cookie: admin.sessionCookie },
        body: JSON.stringify({ name: `Empty-BatchPdf-${runId}`, permissions: [] }),
      });
      const emptyGroupId = (await emptyGroupResponse.json()).group.id;

      const noPerms = await createAndLoginMember({
        tenantId: admin.tenantId,
        name: "No Perms Batch PDF",
        email: `no-perms-batch-${runId}@test.local`,
        password: "Correct-Horse-Battery-Staple9!",
      });
      await apiFetch(`/api/users/${noPerms.userId}/permissions`, {
        method: "PATCH",
        headers: { Cookie: admin.sessionCookie },
        body: JSON.stringify({ permissionGroupId: emptyGroupId }),
      });

      const contractResponse = await apiFetch("/api/documents/batch-pdf", {
        method: "POST",
        headers: { Cookie: noPerms.sessionCookie },
        body: JSON.stringify({ type: "CONTRACT", ids: [locationId1] }),
      });
      expect(contractResponse.status).toBe(403);

      const invoiceResponse = await apiFetch("/api/documents/batch-pdf", {
        method: "POST",
        headers: { Cookie: noPerms.sessionCookie },
        body: JSON.stringify({ type: "INVOICE", ids: [invoiceId1] }),
      });
      expect(invoiceResponse.status).toBe(403);
    });
  });
});
