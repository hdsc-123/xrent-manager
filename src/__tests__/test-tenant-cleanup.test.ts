import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTenantAdmin, deleteTestTenants } from "./helpers/fixtures";

/**
 * Nettoyage du 2026-08-31 (HANDOFF.md/INCIDENTS.md) — cause racine de l'accumulation de tenants
 * résiduels dans xrent_test : chaque fichier de test recopiait sa propre liste de `deleteMany`
 * en ordre de clés étrangères, jamais revérifiée contre le schéma complet au fil des sprints —
 * une table manquante y faisait échouer un `deleteMany` intermédiaire, interrompant le reste de
 * la chaîne `await` et laissant `prisma.tenant.deleteMany()` (toujours en dernier) ne jamais
 * s'exécuter. `deleteTestTenants` (src/__tests__/helpers/fixtures.ts) remplace toutes ces listes
 * par une seule source de vérité. Ce fichier construit délibérément un graphe couvrant la quasi-
 * totalité des tables rattachées à un tenant (y compris les auto-références à risque —
 * Location.parentLocationId/rootLocationId, Invoice.originalInvoiceId — et les tables sans
 * tenantId propre — DamageInvoiceLine, UserAgency, GroupPermission, UserPermission,
 * MfaRecoveryCode, MfaStepUpProof) pour prouver, contre une vraie base Postgres, que la
 * suppression réussit intégralement et n'affecte jamais un autre tenant.
 */
describe("deleteTestTenants — nettoyage complet et isolation", () => {
  it("supprime un tenant et l'intégralité de son graphe de données sans erreur de clé étrangère", async () => {
    const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
    const password = "Correct-Horse-Battery-Staple9!";

    const admin = await createTenantAdmin({
      tenantName: `Cleanup ${runId}`,
      tenantSlug: `cleanup-${runId}`,
      name: "Admin",
      email: `admin-cleanup-${runId}@test.local`,
      password,
    });
    const tenantId = admin.tenantId;

    const agency = await prisma.agency.create({
      data: { tenantId, name: "Agence", slug: `agence-${runId}` },
    });
    const otherAgency = await prisma.agency.create({
      data: { tenantId, name: "Agence 2", slug: `agence2-${runId}` },
    });

    const member = await prisma.user.create({
      data: { tenantId, email: `member-cleanup-${runId}@test.local`, name: "Membre", role: "MEMBER" },
    });
    await prisma.userAgency.create({ data: { userId: member.id, agencyId: agency.id } });

    const permissionGroup = await prisma.permissionGroup.create({
      data: { tenantId, name: `Groupe ${runId}` },
    });
    await prisma.groupPermission.create({
      data: { groupId: permissionGroup.id, permissionKey: "vehicles.view" },
    });
    await prisma.userPermission.create({
      data: { userId: member.id, permissionKey: "vehicles.edit" },
    });

    const client = await prisma.client.create({ data: { tenantId, name: "Client Test" } });
    const secondDriver = await prisma.client.create({ data: { tenantId, name: "Second conducteur" } });

    const vehicle = await prisma.vehicle.create({
      data: {
        tenantId,
        agencyId: agency.id,
        name: "Véhicule",
        licensePlate: `PLATE-${runId}`,
        make: "Marque",
        model: "Modèle",
        year: 2020,
        category: "Eco",
      },
    });

    const location = await prisma.location.create({
      data: {
        tenantId,
        agencyId: agency.id,
        vehicleId: vehicle.id,
        clientId: client.id,
        secondDriverId: secondDriver.id,
        startDate: new Date(),
        endDate: new Date(Date.now() + 86_400_000),
        pricePerDay: 10_000,
        totalPrice: 10_000,
      },
    });
    await prisma.location.update({ where: { id: location.id }, data: { rootLocationId: location.id } });

    // Prolongation (Location.parentLocationId/rootLocationId — auto-référence à ON DELETE
    // RESTRICT explicite, voir prisma/schema.prisma) — même tenant, doit disparaître dans le
    // même deleteMany que le contrat racine, sans jamais bloquer sur sa propre contrainte.
    const extension = await prisma.location.create({
      data: {
        tenantId,
        agencyId: agency.id,
        vehicleId: vehicle.id,
        clientId: client.id,
        startDate: new Date(),
        endDate: new Date(Date.now() + 2 * 86_400_000),
        pricePerDay: 10_000,
        totalPrice: 10_000,
        contractKind: "EXTENSION",
        parentLocationId: location.id,
        rootLocationId: location.id,
      },
    });

    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        agencyId: agency.id,
        locationId: location.id,
        clientId: client.id,
        number: `INV-${runId}`,
        subtotal: 10_000,
        totalAmount: 10_000,
      },
    });
    // Invoice.originalInvoiceId — auto-référence à ON DELETE RESTRICT explicite.
    const creditNote = await prisma.invoice.create({
      data: {
        tenantId,
        agencyId: agency.id,
        locationId: location.id,
        clientId: client.id,
        number: `INV-${runId}-AVOIR`,
        subtotal: 10_000,
        totalAmount: 10_000,
        type: "CREDIT_NOTE",
        status: "CREDIT_NOTE",
        originalInvoiceId: invoice.id,
        reason: "Test",
      },
    });

    const payment = await prisma.payment.create({
      data: { tenantId, invoiceId: invoice.id, amount: 10_000, method: "CASH" },
    });

    const cashRegister = await prisma.cashRegister.create({
      data: { tenantId, currentMonth: "2026-08" },
    });
    await prisma.cashEntry.create({
      data: {
        tenantId,
        cashRegisterId: cashRegister.id,
        type: "ENTRY",
        amount: 10_000,
        paymentId: payment.id,
        creditNoteId: creditNote.id,
      },
    });

    const damage = await prisma.damage.create({
      data: { tenantId, vehicleId: vehicle.id, locationId: location.id, nature: "Rayure", billableAmount: 5_000 },
    });
    const damageInvoice = await prisma.damageInvoice.create({
      data: {
        tenantId,
        agencyId: agency.id,
        locationId: location.id,
        clientId: client.id,
        number: `FACT-DEG-${runId}`,
        subtotal: 5_000,
        totalAmount: 5_000,
      },
    });
    await prisma.damageInvoiceLine.create({
      data: { damageInvoiceId: damageInvoice.id, damageId: damage.id, nature: "Rayure", billableAmount: 5_000 },
    });
    await prisma.damage.update({ where: { id: damage.id }, data: { damageInvoiceId: damageInvoice.id } });
    await prisma.payment.create({
      data: { tenantId, damageInvoiceId: damageInvoice.id, amount: 5_000, method: "CASH" },
    });

    const reservation = await prisma.reservation.create({
      data: {
        tenantId,
        voucherNumber: `VOU-${runId}`,
        clientFirstName: "A",
        clientLastName: "B",
        startDate: new Date(),
        endDate: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.locationUpgrade.create({
      data: {
        tenantId,
        locationId: extension.id,
        reservationId: reservation.id,
        vehicleId: vehicle.id,
        type: "UNAVAILABILITY",
        reservedCategory: "Eco",
        assignedCategory: "Confort",
        dailySupplement: 0,
        daysCount: 1,
        totalSupplement: 0,
        operationalReason: "Test",
        validatedByUserId: admin.userId,
      },
    });

    await prisma.maintenance.create({
      data: { tenantId, agencyId: agency.id, vehicleId: vehicle.id, type: "OIL_CHANGE", scheduledDate: new Date() },
    });
    await prisma.vehicleTransfer.create({
      data: {
        tenantId,
        vehicleId: vehicle.id,
        fromAgencyId: agency.id,
        toAgencyId: otherAgency.id,
        responsibleUserId: admin.userId,
      },
    });
    await prisma.vehicleTrip.create({
      data: {
        tenantId,
        vehicleId: vehicle.id,
        agencyId: agency.id,
        employeeUserId: admin.userId,
        reason: "Test",
        destination: "Test",
        startOdometer: 0,
      },
    });
    await prisma.alert.create({
      data: { tenantId, agencyId: agency.id, userId: admin.userId, type: "OTHER", message: "Test" },
    });
    await prisma.invitation.create({
      data: {
        tenantId,
        email: `invite-${runId}@test.local`,
        invitedByUserId: admin.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.auditLog.create({ data: { tenantId, action: "test.action", resource: "Test" } });
    await prisma.expenseCategory.create({ data: { tenantId, name: `Cat ${runId}` } });
    await prisma.securityNotification.create({
      data: { tenantId, userId: admin.userId, type: "PASSWORD_CHANGED", message: "Test" },
    });
    await prisma.mfaRecoveryCode.create({ data: { userId: admin.userId, codeHash: "hash" } });
    await prisma.mfaStepUpProof.create({
      data: { userId: admin.userId, sessionId: `session-${runId}`, expiresAt: new Date(Date.now() + 600_000) },
    });

    await deleteTestTenants([tenantId]);

    const counts = await Promise.all([
      prisma.tenant.count({ where: { id: tenantId } }),
      prisma.agency.count({ where: { tenantId } }),
      prisma.user.count({ where: { tenantId } }),
      prisma.userAgency.count({ where: { userId: member.id } }),
      prisma.permissionGroup.count({ where: { tenantId } }),
      prisma.groupPermission.count({ where: { groupId: permissionGroup.id } }),
      prisma.userPermission.count({ where: { userId: member.id } }),
      prisma.client.count({ where: { tenantId } }),
      prisma.vehicle.count({ where: { tenantId } }),
      prisma.location.count({ where: { tenantId } }),
      prisma.invoice.count({ where: { tenantId } }),
      prisma.payment.count({ where: { tenantId } }),
      prisma.cashRegister.count({ where: { tenantId } }),
      prisma.cashEntry.count({ where: { tenantId } }),
      prisma.damage.count({ where: { tenantId } }),
      prisma.damageInvoice.count({ where: { tenantId } }),
      prisma.damageInvoiceLine.count({ where: { damageId: damage.id } }),
      prisma.reservation.count({ where: { tenantId } }),
      prisma.locationUpgrade.count({ where: { tenantId } }),
      prisma.maintenance.count({ where: { tenantId } }),
      prisma.vehicleTransfer.count({ where: { tenantId } }),
      prisma.vehicleTrip.count({ where: { tenantId } }),
      prisma.alert.count({ where: { tenantId } }),
      prisma.invitation.count({ where: { tenantId } }),
      prisma.auditLog.count({ where: { tenantId } }),
      prisma.expenseCategory.count({ where: { tenantId } }),
      prisma.securityNotification.count({ where: { tenantId } }),
      prisma.mfaRecoveryCode.count({ where: { userId: admin.userId } }),
      prisma.mfaStepUpProof.count({ where: { userId: admin.userId } }),
    ]);

    expect(counts.every((count) => count === 0)).toBe(true);
  });

  it("ne supprime jamais les données d'un autre tenant (isolation)", async () => {
    const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
    const password = "Correct-Horse-Battery-Staple9!";

    const kept = await createTenantAdmin({
      tenantName: `Kept ${runId}`,
      tenantSlug: `kept-${runId}`,
      name: "Admin",
      email: `admin-kept-${runId}@test.local`,
      password,
    });
    const toDelete = await createTenantAdmin({
      tenantName: `ToDelete ${runId}`,
      tenantSlug: `to-delete-${runId}`,
      name: "Admin",
      email: `admin-todelete-${runId}@test.local`,
      password,
    });

    await deleteTestTenants([toDelete.tenantId]);

    const [keptTenant, deletedTenant] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: kept.tenantId } }),
      prisma.tenant.findUnique({ where: { id: toDelete.tenantId } }),
    ]);
    expect(keptTenant).not.toBeNull();
    expect(deletedTenant).toBeNull();

    await deleteTestTenants([kept.tenantId]);
  });

  it("est idempotent — un tenantId déjà supprimé (ou inexistant) ne fait jamais échouer l'appel", async () => {
    await expect(deleteTestTenants(["not-a-real-tenant-id"])).resolves.toBeUndefined();
    await expect(deleteTestTenants([])).resolves.toBeUndefined();
  });
});
