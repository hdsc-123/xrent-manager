import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";
import { createCashEntry } from "@/lib/cash-register";
import {
  DataResetInProgressError,
  DataResetNotAllowedInProductionError,
  getDataResetSummary,
  resetTenantData,
} from "@/lib/data-reset";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const password = "Correct-Horse-Battery-Staple9!";
const createdTenantIds: string[] = [];

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invitation.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashEntry.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.cashRegister.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.payment.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.maintenance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicleTransfer.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicleTrip.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.reservation.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.expenseCategory.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

/** Seed complet : une agence, un véhicule, un client, une location facturée/payée, une maintenance, un transfert, un déplacement, une alerte, une invitation, une réservation, une écriture de caisse. */
async function seedFullTenantData(admin: AuthenticatedTestUser, suffix: string) {
  const agency = await prisma.agency.create({
    data: { tenantId: admin.tenantId, name: `Agence ${suffix}`, slug: `agence-${suffix}` },
  });
  const agency2 = await prisma.agency.create({
    data: { tenantId: admin.tenantId, name: `Agence 2 ${suffix}`, slug: `agence-2-${suffix}` },
  });
  const vehicle = await prisma.vehicle.create({
    data: {
      tenantId: admin.tenantId,
      agencyId: agency.id,
      name: `Véhicule ${suffix}`,
      licensePlate: `RESET-${suffix}`,
      make: "Dacia",
      model: "Logan",
      year: 2024,
      category: "Économique",
    },
  });
  const client = await prisma.client.create({
    data: { tenantId: admin.tenantId, name: `Client ${suffix}` },
  });
  const location = await prisma.location.create({
    data: {
      tenantId: admin.tenantId,
      agencyId: agency.id,
      vehicleId: vehicle.id,
      clientId: client.id,
      startDate: new Date(),
      endDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      pricePerDay: 10000,
      totalPrice: 30000,
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      tenantId: admin.tenantId,
      agencyId: agency.id,
      locationId: location.id,
      clientId: client.id,
      number: `INV-RESET-${suffix}`,
      subtotal: 30000,
      totalAmount: 30000,
    },
  });
  await prisma.payment.create({
    data: { tenantId: admin.tenantId, invoiceId: invoice.id, amount: 30000, method: "CASH" },
  });
  await prisma.maintenance.create({
    data: {
      tenantId: admin.tenantId,
      agencyId: agency.id,
      vehicleId: vehicle.id,
      type: "OTHER",
      scheduledDate: new Date(),
    },
  });
  await prisma.vehicleTransfer.create({
    data: {
      tenantId: admin.tenantId,
      vehicleId: vehicle.id,
      fromAgencyId: agency.id,
      toAgencyId: agency2.id,
      responsibleUserId: admin.userId,
    },
  });
  await prisma.vehicleTrip.create({
    data: {
      tenantId: admin.tenantId,
      vehicleId: vehicle.id,
      agencyId: agency.id,
      employeeUserId: admin.userId,
      reason: "Test",
      destination: "Test",
      startOdometer: 100,
    },
  });
  await prisma.alert.create({
    data: { tenantId: admin.tenantId, type: "OTHER", message: "Alerte de test" },
  });
  await prisma.invitation.create({
    data: {
      tenantId: admin.tenantId,
      email: `invite-${suffix}@test.local`,
      invitedByUserId: admin.userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  await prisma.reservation.create({
    data: {
      tenantId: admin.tenantId,
      voucherNumber: `V-${suffix}`,
      clientFirstName: "Jean",
      clientLastName: "Test",
      startDate: new Date(),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  await createCashEntry({ tenantId: admin.tenantId, type: "ENTRY", amount: 5000, description: "Test" });
  await prisma.expenseCategory.create({ data: { tenantId: admin.tenantId, name: `Carburant ${suffix}` } });
  // Sprint 15 : la numérotation de contrat est désormais par agence (DOMAINRULES.md section
  // 29), plus sur Tenant — les deux agences du tenant sont mises à jour pour vérifier que le
  // reset remet bien lastContractNumber à 0 sur chacune.
  await prisma.agency.update({ where: { id: agency.id }, data: { lastContractNumber: 7 } });
  await prisma.agency.update({ where: { id: agency2.id }, data: { lastContractNumber: 3 } });
}

describe("GET /api/data-reset", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/data-reset");
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER (réservé ADMIN)", async () => {
    const admin = await registerTenantAdmin({
      tenantName: "Reset GET Member",
      tenantSlug: `reset-get-member-${runId}`,
      name: "Admin",
      email: `reset-get-member-admin-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(admin.tenantId);
    const member = await createAndLoginMember({
      tenantId: admin.tenantId,
      name: "Member",
      email: `reset-get-member-${runId}@test.local`,
      password,
    });

    const response = await apiFetch("/api/data-reset", { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(403);
  });

  it("retourne les comptages réels avant confirmation", async () => {
    const admin = await registerTenantAdmin({
      tenantName: "Reset GET Summary",
      tenantSlug: `reset-get-summary-${runId}`,
      name: "Admin",
      email: `reset-get-summary-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(admin.tenantId);
    await seedFullTenantData(admin, `getsum-${runId}`);

    const response = await apiFetch("/api/data-reset", { headers: { Cookie: admin.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tenantName).toBe("Reset GET Summary");
    expect(body.toDelete).toMatchObject({
      client: 1,
      vehicle: 1,
      location: 1,
      invoice: 1,
      payment: 1,
      maintenance: 1,
      vehicleTransfer: 1,
      vehicleTrip: 1,
      alert: 1,
      invitation: 1,
      reservation: 1,
      cashEntry: 1,
    });
  });
});

describe("POST /api/data-reset", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/data-reset", {
      method: "POST",
      body: JSON.stringify({ confirmTenantName: "x" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER (réservé ADMIN)", async () => {
    const admin = await registerTenantAdmin({
      tenantName: "Reset POST Member",
      tenantSlug: `reset-post-member-${runId}`,
      name: "Admin",
      email: `reset-post-member-admin-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(admin.tenantId);
    const member = await createAndLoginMember({
      tenantId: admin.tenantId,
      name: "Member",
      email: `reset-post-member-${runId}@test.local`,
      password,
    });

    const response = await apiFetch("/api/data-reset", {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ confirmTenantName: "Reset POST Member" }),
    });
    expect(response.status).toBe(403);
  });

  it("refuse un corps sans confirmTenantName", async () => {
    const admin = await registerTenantAdmin({
      tenantName: "Reset POST Missing",
      tenantSlug: `reset-post-missing-${runId}`,
      name: "Admin",
      email: `reset-post-missing-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(admin.tenantId);

    const response = await apiFetch("/api/data-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it("refuse une confirmation dont le nom ne correspond pas", async () => {
    const admin = await registerTenantAdmin({
      tenantName: "Reset POST Wrong Name",
      tenantSlug: `reset-post-wrong-${runId}`,
      name: "Admin",
      email: `reset-post-wrong-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(admin.tenantId);

    const response = await apiFetch("/api/data-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ confirmTenantName: "Nom incorrect" }),
    });
    expect(response.status).toBe(400);

    // Sprint 16 (audit sécurité) : une tentative refusée doit désormais laisser une trace
    // (auparavant, seul un reset réussi était journalisé — aucune visibilité sur les tentatives
    // répétées de deviner le nom exact du tenant).
    const failedLog = await prisma.auditLog.findFirst({
      where: { tenantId: admin.tenantId, action: "data.reset_failed" },
    });
    expect(failedLog).not.toBeNull();
    expect(failedLog?.userId).toBe(admin.userId);
  });

  it("vide les données métier du tenant, conserve la config, préserve les autres tenants", async () => {
    const admin = await registerTenantAdmin({
      tenantName: "Reset POST Full",
      tenantSlug: `reset-post-full-${runId}`,
      name: "Admin",
      email: `reset-post-full-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(admin.tenantId);
    await seedFullTenantData(admin, `full-${runId}`);

    const otherAdmin = await registerTenantAdmin({
      tenantName: "Reset POST Other Tenant",
      tenantSlug: `reset-post-other-${runId}`,
      name: "Admin",
      email: `reset-post-other-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(otherAdmin.tenantId);
    await seedFullTenantData(otherAdmin, `other-${runId}`);

    const response = await apiFetch("/api/data-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ confirmTenantName: "Reset POST Full" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.deleted).toMatchObject({
      client: 1,
      vehicle: 1,
      location: 1,
      invoice: 1,
      payment: 1,
      maintenance: 1,
      vehicleTransfer: 1,
      vehicleTrip: 1,
      alert: 1,
      invitation: 1,
      reservation: 1,
      cashEntry: 1,
    });

    const [
      clientCount,
      vehicleCount,
      locationCount,
      invoiceCount,
      paymentCount,
      maintenanceCount,
      transferCount,
      tripCount,
      alertCount,
      invitationCount,
      reservationCount,
      cashEntryCount,
      agencyCount,
      userCount,
      expenseCategoryCount,
      agencies,
      cashRegister,
    ] = await Promise.all([
      prisma.client.count({ where: { tenantId: admin.tenantId } }),
      prisma.vehicle.count({ where: { tenantId: admin.tenantId } }),
      prisma.location.count({ where: { tenantId: admin.tenantId } }),
      prisma.invoice.count({ where: { tenantId: admin.tenantId } }),
      prisma.payment.count({ where: { tenantId: admin.tenantId } }),
      prisma.maintenance.count({ where: { tenantId: admin.tenantId } }),
      prisma.vehicleTransfer.count({ where: { tenantId: admin.tenantId } }),
      prisma.vehicleTrip.count({ where: { tenantId: admin.tenantId } }),
      prisma.alert.count({ where: { tenantId: admin.tenantId } }),
      prisma.invitation.count({ where: { tenantId: admin.tenantId } }),
      prisma.reservation.count({ where: { tenantId: admin.tenantId } }),
      prisma.cashEntry.count({ where: { tenantId: admin.tenantId } }),
      prisma.agency.count({ where: { tenantId: admin.tenantId } }),
      prisma.user.count({ where: { tenantId: admin.tenantId } }),
      prisma.expenseCategory.count({ where: { tenantId: admin.tenantId } }),
      prisma.agency.findMany({ where: { tenantId: admin.tenantId } }),
      prisma.cashRegister.findUnique({ where: { tenantId: admin.tenantId } }),
    ]);

    expect(clientCount).toBe(0);
    expect(vehicleCount).toBe(0);
    expect(locationCount).toBe(0);
    expect(invoiceCount).toBe(0);
    expect(paymentCount).toBe(0);
    expect(maintenanceCount).toBe(0);
    expect(transferCount).toBe(0);
    expect(tripCount).toBe(0);
    expect(alertCount).toBe(0);
    expect(invitationCount).toBe(0);
    expect(reservationCount).toBe(0);
    expect(cashEntryCount).toBe(0);

    // Configuration préservée.
    expect(agencyCount).toBe(2);
    expect(userCount).toBe(1);
    expect(expenseCategoryCount).toBe(1);
    expect(agencies.every((agency) => agency.lastContractNumber === 0)).toBe(true);
    expect(cashRegister?.currentBalance).toBe(0);

    // Journal d'audit préservé par défaut (includeAuditLog non fourni), et contient
    // désormais l'entrée décrivant le reset lui-même.
    const resetAuditEntry = await prisma.auditLog.findFirst({
      where: { tenantId: admin.tenantId, action: "data.reset" },
    });
    expect(resetAuditEntry).not.toBeNull();

    // Isolation : l'autre tenant n'est pas affecté.
    const [otherClientCount, otherVehicleCount] = await Promise.all([
      prisma.client.count({ where: { tenantId: otherAdmin.tenantId } }),
      prisma.vehicle.count({ where: { tenantId: otherAdmin.tenantId } }),
    ]);
    expect(otherClientCount).toBe(1);
    expect(otherVehicleCount).toBe(1);
  });

  it("Sprint 24-2 — non-régression : un véhicule créé via l'API (avec les 7 champs techniques désormais obligatoires) est purgé sans orphelin par le reset", async () => {
    const admin = await registerTenantAdmin({
      tenantName: "Reset Sprint24-2 Vehicle",
      tenantSlug: `reset-s242-vehicle-${runId}`,
      name: "Admin",
      email: `reset-s242-vehicle-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(admin.tenantId);

    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: "Agence Reset S24-2", slug: `agence-reset-s242-${runId}` }),
    });
    const agencyId = (await agencyResponse.json()).agency.id;

    // Passe par la route API réelle (POST /api/vehicles), désormais stricte sur ces 7 champs —
    // vérifie que le reset continue de purger un véhicule créé par le chemin normal de
    // production, pas seulement un véhicule injecté directement en base via prisma.vehicle.create
    // comme le fait seedFullTenantData ci-dessus.
    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({
        agencyId,
        name: "Clio",
        licensePlate: `RESET-S242-${runId}`,
        make: "Renault",
        model: "Clio",
        year: 2022,
        category: "Citadine",
        chassisNumber: `VF1RESET${runId}`,
        color: "Blanc",
        doors: 5,
        seats: 5,
        horsepower: 6,
        powerKW: 75,
        engineSize: 1.5,
      }),
    });
    expect(vehicleResponse.status).toBe(201);

    expect(await prisma.vehicle.count({ where: { tenantId: admin.tenantId } })).toBe(1);

    const deleted = await resetTenantData({
      tenantId: admin.tenantId,
      userId: admin.userId,
      confirmTenantName: "Reset Sprint24-2 Vehicle",
      includeAuditLog: false,
    });
    expect(deleted.vehicle).toBe(1);
    expect(await prisma.vehicle.count({ where: { tenantId: admin.tenantId } })).toBe(0);
    // L'agence (configuration) reste en place, aucune donnée orpheline ne référence le véhicule
    // supprimé.
    expect(await prisma.agency.count({ where: { tenantId: admin.tenantId } })).toBe(1);
  });

  it("supprime aussi le journal d'audit existant quand includeAuditLog est vrai, mais garde une trace du reset", async () => {
    const admin = await registerTenantAdmin({
      tenantName: "Reset POST Full Audit",
      tenantSlug: `reset-post-full-audit-${runId}`,
      name: "Admin",
      email: `reset-post-full-audit-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(admin.tenantId);
    await seedFullTenantData(admin, `fullaudit-${runId}`);

    // Une entrée d'audit préexistante, distincte de celle générée par le reset.
    await prisma.auditLog.create({
      data: { tenantId: admin.tenantId, userId: admin.userId, action: "test.prior", resource: "Test" },
    });

    const response = await apiFetch("/api/data-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ confirmTenantName: "Reset POST Full Audit", includeAuditLog: true }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deleted.auditLog).toBe(1);

    const remainingLogs = await prisma.auditLog.findMany({ where: { tenantId: admin.tenantId } });
    expect(remainingLogs).toHaveLength(1);
    expect(remainingLogs[0].action).toBe("data.reset");
  });

  it("refuse un double lancement concurrent sur le même tenant (verrou)", async () => {
    const admin = await registerTenantAdmin({
      tenantName: "Reset Concurrent",
      tenantSlug: `reset-concurrent-${runId}`,
      name: "Admin",
      email: `reset-concurrent-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(admin.tenantId);

    const first = resetTenantData({
      tenantId: admin.tenantId,
      userId: admin.userId,
      confirmTenantName: "Reset Concurrent",
      includeAuditLog: false,
    });

    await expect(
      resetTenantData({
        tenantId: admin.tenantId,
        userId: admin.userId,
        confirmTenantName: "Reset Concurrent",
        includeAuditLog: false,
      })
    ).rejects.toThrow(DataResetInProgressError);

    await first;
  });

  it("refuse tout reset en environnement de production (SECURITY.md section 17)", async () => {
    const admin = await registerTenantAdmin({
      tenantName: "Reset Production Guard",
      tenantSlug: `reset-prod-guard-${runId}`,
      name: "Admin",
      email: `reset-prod-guard-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(admin.tenantId);

    // `NODE_ENV` est typé en lecture seule (@types/node) mais reste une variable
    // d'environnement mutable à l'exécution — cast local pour ce test uniquement.
    const mutableEnv = process.env as { NODE_ENV?: string };
    const originalNodeEnv = mutableEnv.NODE_ENV;
    mutableEnv.NODE_ENV = "production";
    try {
      await expect(getDataResetSummary(admin.tenantId)).rejects.toThrow(
        DataResetNotAllowedInProductionError
      );
      await expect(
        resetTenantData({
          tenantId: admin.tenantId,
          userId: admin.userId,
          confirmTenantName: "Reset Production Guard",
          includeAuditLog: false,
        })
      ).rejects.toThrow(DataResetNotAllowedInProductionError);
    } finally {
      mutableEnv.NODE_ENV = originalNodeEnv;
    }
  });
});
