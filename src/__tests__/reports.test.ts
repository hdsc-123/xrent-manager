import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getRevenueReport, getVehicleUtilizationReport, getTopVehicles } from "@/lib/reports";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let admin: AuthenticatedTestUser;
let member: AuthenticatedTestUser;
let vehicleId: string;
let clientId: string;

async function createLocation(overrides: Record<string, unknown>) {
  const response = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ vehicleId, clientId, startDate: "2030-01-10", endDate: "2030-01-13", ...overrides }),
  });
  return (await response.json()).location as { id: string; totalPrice: number };
}

beforeAll(async () => {
  admin = await registerTenantAdmin({
    tenantName: "Reports Test",
    tenantSlug: `reports-test-${runId}`,
    name: "Admin",
    email: `admin-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(admin.tenantId);

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: "Agence", slug: `agence-${runId}` }),
  });
  const agencyId = (await agencyResponse.json()).agency.id;

  const vehicleResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      agencyId,
      name: "Clio",
      licensePlate: `REP-${runId}`,
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
    body: JSON.stringify({ name: "Client", email: `client-${runId}@test.local` }),
  });
  clientId = (await clientResponse.json()).client.id;

  member = await createAndLoginMember({
    tenantId: admin.tenantId,
    name: "Member",
    email: `member-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
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

describe("GET /api/reports/* — désormais gated par can(user, \"reports.view\") (Sprint 15)", () => {
  it("GET /api/reports/revenue refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/reports/revenue?from=2030-01-01&to=2030-12-31");
    expect(response.status).toBe(401);
  });

  it("GET /api/reports/revenue autorise un MEMBER (reports.view est dans le groupe MEMBER par défaut, Sprint 15)", async () => {
    const response = await apiFetch("/api/reports/revenue?from=2030-01-01&to=2030-12-31", {
      headers: { Cookie: member.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("GET /api/reports/revenue autorise un ADMIN", async () => {
    const response = await apiFetch("/api/reports/revenue?from=2030-01-01&to=2030-12-31", {
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("GET /api/reports/vehicles refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/reports/vehicles?from=2030-01-01&to=2030-12-31");
    expect(response.status).toBe(401);
  });

  it("GET /api/reports/vehicles autorise un MEMBER (reports.view est dans le groupe MEMBER par défaut, Sprint 15)", async () => {
    const response = await apiFetch("/api/reports/vehicles?from=2030-01-01&to=2030-12-31", {
      headers: { Cookie: member.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("GET /api/reports/vehicles autorise un ADMIN", async () => {
    const response = await apiFetch("/api/reports/vehicles?from=2030-01-01&to=2030-12-31", {
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(200);
  });
});

describe("Sprint 15 — permissions granulaires (reports.view via un groupe personnalisé restrictif)", () => {
  it("refuse un MEMBER dont le groupe personnalisé n'a pas reports.view", async () => {
    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: `NoReportsView-${runId}`, permissions: ["vehicles.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    await apiFetch(`/api/users/${member.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    try {
      const revenueResponse = await apiFetch("/api/reports/revenue?from=2030-01-01&to=2030-12-31", {
        headers: { Cookie: member.sessionCookie },
      });
      expect(revenueResponse.status).toBe(403);

      const vehiclesResponse = await apiFetch("/api/reports/vehicles?from=2030-01-01&to=2030-12-31", {
        headers: { Cookie: member.sessionCookie },
      });
      expect(vehiclesResponse.status).toBe(403);
    } finally {
      // Nettoyage : on retire le groupe personnalisé pour ne pas affecter les tests suivants.
      await apiFetch(`/api/users/${member.userId}/permissions`, {
        method: "PATCH",
        headers: { Cookie: admin.sessionCookie },
        body: JSON.stringify({ permissionGroupId: null }),
      });
    }
  });
});

describe("getRevenueReport", () => {
  it("ignore un tenant vide", async () => {
    const report = await getRevenueReport("nonexistent-tenant-id", new Date("2030-01-01"), new Date("2030-12-31"));
    expect(report.totalRevenue).toBe(0);
    expect(report.byMonth).toHaveLength(0);
  });

  it("agrège les paiements par mois sur la période, isolé par tenant", async () => {
    const location = await createLocation({ startDate: "2030-03-01", endDate: "2030-03-04" });
    const invoiceResponse = await apiFetch("/api/invoices", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ locationId: location.id }),
    });
    const invoice = (await invoiceResponse.json()).invoice;

    // Finding F : un paiement direct est refusé sur une facture encore DRAFT — finalise
    // d'abord (DRAFT → SENT, inconditionnel vis-à-vis du solde).
    await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ status: "SENT" }),
    });

    await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({
        invoiceId: invoice.id,
        amount: invoice.totalAmount,
        method: "CASH",
        paidAt: "2030-03-15",
      }),
    });

    const report = await getRevenueReport(admin.tenantId, new Date("2030-03-01"), new Date("2030-03-31"));
    expect(report.totalRevenue).toBe(invoice.totalAmount);
    expect(report.currency).toBe("MAD");
    expect(report.byMonth).toEqual([{ month: "2030-03", revenue: invoice.totalAmount }]);
  });
});

describe("getVehicleUtilizationReport", () => {
  it("calcule les jours loués comme le chevauchement entre la location et la période demandée", async () => {
    await createLocation({ startDate: "2030-04-10", endDate: "2030-04-15", status: "CONFIRMED" });

    // La transition CONFIRMED -> ACTIVE nécessite de récupérer la location créée : on filtre par véhicule.
    const locations = await prisma.location.findMany({ where: { vehicleId, tenantId: admin.tenantId } });
    const target = locations.find((l) => l.startDate.toISOString().startsWith("2030-04-10"));
    if (target) {
      await prisma.location.update({ where: { id: target.id }, data: { status: "ACTIVE" } });
    }

    const report = await getVehicleUtilizationReport(admin.tenantId, new Date("2030-04-01"), new Date("2030-04-30"));
    const entry = report.find((r) => r.vehicleId === vehicleId);
    expect(entry).toBeDefined();
    expect(entry?.rentedDays).toBeGreaterThanOrEqual(5);
    // 2030-04-01 -> 2030-04-30 = 29 (même convention que calculateTotalPrice dans
    // src/lib/locations.ts : différence de temps, pas un décompte inclusif des jours).
    expect(entry?.periodDays).toBe(29);
  });

  it("ignore les locations PENDING/CANCELLED (pas encore une occupation réelle)", async () => {
    await createLocation({ startDate: "2030-05-01", endDate: "2030-05-05" });

    const report = await getVehicleUtilizationReport(admin.tenantId, new Date("2030-05-01"), new Date("2030-05-31"));
    const entry = report.find((r) => r.vehicleId === vehicleId);
    // La location de mai reste PENDING (jamais confirmée) : elle ne doit pas compter.
    expect(entry?.rentedDays).toBe(0);
  });
});

describe("getTopVehicles", () => {
  it("classe les véhicules par revenu facturé décroissant, limité au tenant", async () => {
    const location = await createLocation({ startDate: "2030-06-01", endDate: "2030-06-04", status: "CONFIRMED" });
    await prisma.location.update({ where: { id: location.id }, data: { status: "COMPLETED" } });

    const top = await getTopVehicles(admin.tenantId, 5);
    const entry = top.find((v) => v.vehicleId === vehicleId);
    expect(entry).toBeDefined();
    expect(entry!.revenue).toBeGreaterThanOrEqual(location.totalPrice);
  });

  it("respecte la limite demandée", async () => {
    const top = await getTopVehicles(admin.tenantId, 1);
    expect(top.length).toBeLessThanOrEqual(1);
  });
});
