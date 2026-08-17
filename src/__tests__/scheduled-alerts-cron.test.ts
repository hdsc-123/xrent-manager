import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, type AuthenticatedTestUser } from "./helpers/fixtures";
import { maybeRunScheduledAlertChecks } from "@/lib/scheduled-tasks";

/**
 * Sprint 34 étape 2 (DOMAINRULES.md section 49) — POST /api/tasks/scheduled-alerts, le
 * déclencheur de service du scheduler horaire d'alertes (distinct de POST
 * /api/tasks/check-alerts, réservé ADMIN/un seul tenant/session). CRON_SECRET est déjà défini
 * dans .env.test (voir vitest.global-setup.ts, transmis au process next dev de test) — le cas
 * "CRON_SECRET absent" (503) n'est donc pas testable via ce serveur partagé, vérifié par
 * lecture de code (un seul `if (!secret) return 503` avant toute autre logique).
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];
const CRON_SECRET = "test-cron-secret-do-not-use-in-prod";

async function createTenantWithOverdueMaintenance(label: string): Promise<{
  admin: AuthenticatedTestUser;
  agencyId: string;
  vehicleId: string;
}> {
  const admin = await registerTenantAdmin({
    tenantName: `Scheduled Alerts ${label} ${runId}`,
    tenantSlug: `scheduled-alerts-${label}-${runId}`,
    name: "Admin",
    email: `admin-sa-${label}-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(admin.tenantId);

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: `Agence ${label}`, slug: `sa-agence-${label}-${runId}` }),
  });
  const agencyId = (await agencyResponse.json()).agency.id;

  const vehicleResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      agencyId,
      name: "Clio",
      licensePlate: `SA-${Math.floor(Math.random() * 1_000_000)}-${label}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay: 4500,
      chassisNumber: `VF1SA${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
    }),
  });
  const vehicle = (await vehicleResponse.json()).vehicle;

  await apiFetch("/api/maintenances", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      vehicleId: vehicle.id,
      type: "OIL_CHANGE",
      scheduledDate: new Date().toISOString().slice(0, 10),
    }),
  });

  return { admin, agencyId, vehicleId: vehicle.id };
}

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.maintenance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("POST /api/tasks/scheduled-alerts — authentification de service", () => {
  it("refuse (401) sans en-tête Authorization", async () => {
    const response = await apiFetch("/api/tasks/scheduled-alerts", { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("refuse (401) avec un secret invalide", async () => {
    const response = await apiFetch("/api/tasks/scheduled-alerts", {
      method: "POST",
      headers: { Authorization: "Bearer secret-invalide" },
    });
    expect(response.status).toBe(401);
  });

  it("refuse (401) avec un secret de longueur différente (jamais de fuite via timingSafeEqual)", async () => {
    const response = await apiFetch("/api/tasks/scheduled-alerts", {
      method: "POST",
      headers: { Authorization: "Bearer x" },
    });
    expect(response.status).toBe(401);
  });

  it("accepte (200) avec le secret valide", async () => {
    const response = await apiFetch("/api/tasks/scheduled-alerts", {
      method: "POST",
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.trigger).toBe("CRON");
    expect(typeof body.tenantsTotal).toBe("number");
    expect(typeof body.durationMs).toBe("number");
    expect(Array.isArray(body.errors)).toBe(true);
  });
});

describe("POST /api/tasks/scheduled-alerts — exécution multi-tenant, isolation, absence de doublons", () => {
  it("traite plusieurs tenants indépendamment, journalise chacun (AuditLog userId null), et ne recrée rien à un second appel immédiat", async () => {
    const tenantA = await createTenantWithOverdueMaintenance("A");
    const tenantB = await createTenantWithOverdueMaintenance("B");

    const first = await apiFetch("/api/tasks/scheduled-alerts", {
      method: "POST",
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(first.status).toBe(200);
    const firstSummary = await first.json();
    expect(firstSummary.tenantsTotal).toBeGreaterThanOrEqual(2);

    // Isolation : chaque tenant ne voit que sa propre alerte MAINTENANCE_DUE.
    const alertsA = await apiFetch("/api/alerts?type=MAINTENANCE_DUE", {
      headers: { Cookie: tenantA.admin.sessionCookie },
    });
    const { alerts: alertsAList } = await alertsA.json();
    expect(alertsAList.some((a: { entityType: string }) => a.entityType === "Maintenance")).toBe(true);

    const alertsB = await apiFetch("/api/alerts?type=MAINTENANCE_DUE", {
      headers: { Cookie: tenantB.admin.sessionCookie },
    });
    const { alerts: alertsBList } = await alertsB.json();
    expect(alertsBList.some((a: { entityType: string }) => a.entityType === "Maintenance")).toBe(true);

    // Journalisation : une entrée AuditLog "alert_check.scheduled_run", userId null (Système),
    // pour chacun des deux tenants — jamais mélangée entre eux.
    const logsA = await prisma.auditLog.findMany({
      where: { tenantId: tenantA.admin.tenantId, action: "alert_check.scheduled_run" },
    });
    expect(logsA).toHaveLength(1);
    expect(logsA[0].userId).toBeNull();
    expect((logsA[0].metadata as { trigger?: string })?.trigger).toBe("CRON");

    const logsB = await prisma.auditLog.findMany({
      where: { tenantId: tenantB.admin.tenantId, action: "alert_check.scheduled_run" },
    });
    expect(logsB).toHaveLength(1);

    const tenantAfterFirst = await prisma.tenant.findUnique({ where: { id: tenantA.admin.tenantId } });
    expect(tenantAfterFirst?.lastAlertCheckAt).not.toBeNull();

    // Second appel immédiat (même fenêtre horaire) : le throttle par tenant (réutilisé tel
    // quel de maybeRunScheduledAlertChecks) doit classer les deux tenants en "skipped", sans
    // nouvelle entrée AuditLog ni alerte dupliquée.
    const second = await apiFetch("/api/tasks/scheduled-alerts", {
      method: "POST",
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(second.status).toBe(200);

    const logsAAfterSecond = await prisma.auditLog.findMany({
      where: { tenantId: tenantA.admin.tenantId, action: "alert_check.scheduled_run" },
    });
    expect(logsAAfterSecond).toHaveLength(1);

    const alertsAAfterSecond = await apiFetch("/api/alerts?type=MAINTENANCE_DUE", {
      headers: { Cookie: tenantA.admin.sessionCookie },
    });
    const { alerts: alertsAAfterSecondList } = await alertsAAfterSecond.json();
    expect(alertsAAfterSecondList.length).toBe(alertsAList.length);

    const tenantAfterSecond = await prisma.tenant.findUnique({ where: { id: tenantA.admin.tenantId } });
    expect(tenantAfterSecond?.lastAlertCheckAt?.getTime()).toBe(tenantAfterFirst?.lastAlertCheckAt?.getTime());
  });

  it("deux appels réellement simultanés (Promise.all) ne produisent jamais de doublon pour un même tenant", async () => {
    // Contrairement au test ci-dessus (deux appels séquentiels awaited), celui-ci vérifie la
    // garde sous vraie concurrence — même méthode que les tests de concurrence déjà établis
    // ailleurs dans le projet (ex. vehicle-transfers.test.ts, Scénarios A/B/C, Promise.all
    // contre de vraies requêtes HTTP). La garde testée (Tenant.lastAlertCheckAt, updateMany
    // conditionné atomique côté Postgres) est celle de maybeRunScheduledAlertChecks
    // (Sprint 22/23), non modifiée par ce sprint — ce test comble une lacune de vérification
    // (aucun test existant, avant celui-ci, n'exerçait cette garde sous concurrence réelle).
    const tenant = await createTenantWithOverdueMaintenance("Concurrent");

    const [respA, respB] = await Promise.all([
      apiFetch("/api/tasks/scheduled-alerts", {
        method: "POST",
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      }),
      apiFetch("/api/tasks/scheduled-alerts", {
        method: "POST",
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      }),
    ]);
    expect(respA.status).toBe(200);
    expect(respB.status).toBe(200);

    // Une seule des deux invocations a pu "gagner" la garde horaire pour ce tenant — jamais
    // les deux : exactement une entrée AuditLog, exactement une alerte MAINTENANCE_DUE créée.
    const logs = await prisma.auditLog.findMany({
      where: { tenantId: tenant.admin.tenantId, action: "alert_check.scheduled_run" },
    });
    expect(logs).toHaveLength(1);

    const alertsResponse = await apiFetch("/api/alerts?type=MAINTENANCE_DUE", {
      headers: { Cookie: tenant.admin.sessionCookie },
    });
    const { alerts } = await alertsResponse.json();
    const maintenanceAlerts = alerts.filter((a: { entityType: string }) => a.entityType === "Maintenance");
    expect(maintenanceAlerts).toHaveLength(1);
  });

  it("ignore silencieusement un tenant déjà supprimé (aucune exception, aucun résidu) — vérifie la garde au niveau maybeRunScheduledAlertChecks, réutilisée telle quelle par le scheduler", async () => {
    // Le schéma Tenant n'a pas de notion de "désactivé" (pas de champ isActive/deletedAt) —
    // seule la suppression réelle existe (DELETE /api/tenants/[id]). La garde acquise via
    // updateMany({ where: { id, ... } }) ne peut matcher aucune ligne pour un id inexistant
    // (sémantique SQL standard, pas une logique métier propre à ce sprint) : appel direct de
    // la fonction lib (contournant volontairement la route HTTP, même patron que le Scénario F
    // de vehicle-transfers.test.ts) pour le prouver sans dépendre d'une fenêtre de course
    // difficile à provoquer de façon fiable en boîte noire.
    const admin = await registerTenantAdmin({
      tenantName: `Scheduled Alerts Deleted ${runId}`,
      tenantSlug: `scheduled-alerts-deleted-${runId}`,
      name: "Admin",
      email: `admin-sa-deleted-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.permissionGroup.deleteMany({ where: { tenantId: admin.tenantId } });
    await prisma.user.deleteMany({ where: { tenantId: admin.tenantId } });
    await prisma.tenant.delete({ where: { id: admin.tenantId } });

    const result = await maybeRunScheduledAlertChecks(admin.tenantId);
    expect(result).toEqual({ ran: false, alertsCreated: 0 });
  });
});
