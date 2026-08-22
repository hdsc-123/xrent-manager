import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, type AuthenticatedTestUser } from "./helpers/fixtures";

/**
 * Sprint 14C (DOMAINRULES.md section 30) : nouvelles alertes métier (checkStockInconsistencies,
 * checkOverdueReturns — deux des six nouvelles vérifications de src/lib/scheduled-tasks.ts) et
 * revue de l'onglet Maintenance (état réel des véhicules).
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let admin: AuthenticatedTestUser;
let agencyId: string;
let clientId: string;

async function createVehicle(overrides: Record<string, unknown> = {}) {
  const response = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      agencyId,
      name: "Clio",
      licensePlate: `AL-${Math.floor(Math.random() * 1_000_000)}-AL`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay: 4500,
      chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
      ...overrides,
    }),
  });
  return (await response.json()).vehicle as { id: string; licensePlate: string };
}

beforeAll(async () => {
  admin = await registerTenantAdmin({
    tenantName: "Mobility Alerts Test",
    tenantSlug: `mobility-alerts-test-${runId}`,
    name: "Admin",
    email: `admin-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(admin.tenantId);

  // Sprint 13E tâche 2 (revue INC-3) : réclame préventivement le throttle horaire de
  // `maybeRunScheduledAlertChecks` pour ce tenant, dès sa création. Le CRON global
  // (`runScheduledAlertChecksForAllTenants`, scheduled-alerts-cron.test.ts) scanne tous les
  // tenants de la base de test à chaque exécution et ignore silencieusement (sans erreur) tout
  // tenant dont le throttle a déjà été réclamé dans l'heure — ce tenant devient donc
  // structurellement invisible à ce CRON pour toute la durée (bien plus courte qu'une heure) de
  // ce fichier, éliminant complètement (pas seulement en probabilité) le risque qu'il crée en
  // avance, pour le compte d'un autre process, une alerte que les tests ci-dessous s'attendent à
  // voir créée par leur propre appel explicite à `POST /api/tasks/check-alerts` (endpoint
  // distinct, non throttlé, donc jamais affecté par cette réclamation). Sans effet sur le test
  // dédié au déclenchement automatique plus bas, qui utilise son propre tenant `freshAdmin`,
  // jamais touché ici.
  await prisma.tenant.update({ where: { id: admin.tenantId }, data: { lastAlertCheckAt: new Date() } });

  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: "Agence Alertes", slug: `al-agence-${runId}` }),
  });
  agencyId = (await agencyResponse.json()).agency.id;

  const clientResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: "Client Alertes", email: `client-al-${runId}@test.local`, licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
  });
  clientId = (await clientResponse.json()).client.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.maintenance.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicleTransfer.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicleTrip.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("POST /api/tasks/check-alerts — nouvelles vérifications Sprint 14C", () => {
  it("crée STOCK_INCONSISTENCY quand un véhicule AVAILABLE a une location ACTIVE, et RETURN_OVERDUE pour un retour dépassé", async () => {
    const vehicle = await createVehicle();

    const locationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({
        vehicleId: vehicle.id,
        clientId,
        // Période déjà entièrement passée : le retour est donc en retard une fois ACTIVE.
        startDate: "2020-01-10",
        endDate: "2020-01-13",
      }),
    });
    const locationId = (await locationResponse.json()).location.id;

    // ACTIVE (via CONFIRMED, transitions autorisées quel que soit le statut des dates).
    await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    // Désynchronisation délibérée : le véhicule reste marqué "AVAILABLE" alors qu'une location
    // ACTIVE existe désormais (reproduit le scénario réel visé par STOCK_INCONSISTENCY).
    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { status: "AVAILABLE" } });

    // Sprint 13E tâche 2 (revue INC-3) : le CRON global (`runScheduledAlertChecksForAllTenants`,
    // scheduled-alerts-cron.test.ts) scanne tous les tenants de la base de test — sous la suite
    // complète, il peut créer ces mêmes alertes (dédoublonnage correct, comportement production
    // voulu) entre la désynchronisation ci-dessus et l'appel explicite ci-dessous, faisant
    // légitimement remonter ces compteurs à 0 pour CET appel précis. On garantit donc la
    // précondition explicitement — n'affaiblit aucune assertion.
    await prisma.alert.deleteMany({
      where: {
        tenantId: admin.tenantId,
        OR: [
          { entityType: "VehicleStockInconsistency", entityId: vehicle.id },
          { entityType: "LocationOverdueReturn", entityId: locationId },
        ],
      },
    });

    const response = await apiFetch("/api/tasks/check-alerts", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.created.stockInconsistencies).toBeGreaterThanOrEqual(1);
    expect(body.created.overdueReturns).toBeGreaterThanOrEqual(1);

    const stockAlerts = await apiFetch("/api/alerts?type=STOCK_INCONSISTENCY", {
      headers: { Cookie: admin.sessionCookie },
    });
    const stockAlertsBody = await stockAlerts.json();
    const stockAlert = stockAlertsBody.alerts.find((alert: { entityId: string }) => alert.entityId === vehicle.id);
    expect(stockAlert).toBeDefined();
    expect(stockAlert.status).toBe("PENDING");

    const returnAlerts = await apiFetch("/api/alerts?type=RETURN_OVERDUE", {
      headers: { Cookie: admin.sessionCookie },
    });
    const returnAlertsBody = await returnAlerts.json();
    const returnAlert = returnAlertsBody.alerts.find((alert: { entityId: string }) => alert.entityId === locationId);
    expect(returnAlert).toBeDefined();
    expect(returnAlert.priority).toBe("URGENT");

    // Consultation + traitement (acknowledge puis resolve) — même machine à états que les
    // alertes existantes (src/lib/alerts.ts), déjà testée génériquement dans alerts.test.ts.
    const ack = await apiFetch(`/api/alerts/${stockAlert.id}/acknowledge`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
    });
    expect(ack.status).toBe(200);
    const resolve = await apiFetch(`/api/alerts/${stockAlert.id}/resolve`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
    });
    expect(resolve.status).toBe(200);
    expect((await resolve.json()).alert.status).toBe("RESOLVED");
  });
});

describe("GET /dashboard/maintenances — état réel des véhicules", () => {
  it("affiche l'immatriculation, l'état et la disponibilité de chaque véhicule", async () => {
    const available = await createVehicle({ licensePlate: `AL-DISPO-${runId}` });
    const maintenance = await createVehicle({ licensePlate: `AL-MAINT-${runId}`, status: "MAINTENANCE" });

    const response = await apiFetch("/dashboard/maintenances", { headers: { Cookie: admin.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain("État des véhicules");
    expect(html).toContain(available.licensePlate);
    expect(html).toContain(maintenance.licensePlate);
    expect(html).toContain("Disponible");
    expect(html).toContain("Maintenance");
  });
});

describe("Sprint 19 — fiche véhicule : historique maintenance + mouvements (DOMAINRULES.md section 37)", () => {
  it("affiche l'historique maintenance et les mouvements (transferts/déplacements) du véhicule", async () => {
    const vehicle = await createVehicle({ licensePlate: `HIST-${runId}` });

    const agency2Response = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: "Agence Historique 2", slug: `al-agence2-${runId}` }),
    });
    const agency2Id = (await agency2Response.json()).agency.id;

    await apiFetch("/api/maintenances", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ vehicleId: vehicle.id, type: "OIL_CHANGE", scheduledDate: "2030-01-15" }),
    });

    await apiFetch("/api/vehicle-transfers", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ vehicleId: vehicle.id, toAgencyId: agency2Id, responsibleUserId: admin.userId }),
    });

    const response = await apiFetch(`/dashboard/vehicles/${vehicle.id}`, { headers: { Cookie: admin.sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain("Historique maintenance");
    expect(html).toContain("Vidange");
    expect(html).toContain("Historique des mouvements");
    expect(html).toContain("Transfert");
    expect(html).toContain("Agence Historique 2");
  });
});

describe("Sprint 22 — déclenchement automatique des vérifications d'alertes (maybeRunScheduledAlertChecks)", () => {
  it("une maintenance planifiée du jour génère réellement une alerte MAINTENANCE_DUE au simple chargement du dashboard, sans jamais appeler POST /api/tasks/check-alerts", async () => {
    // Tenant dédié (pas le tenant partagé `admin` de ce fichier) : le throttle en mémoire de
    // maybeRunScheduledAlertChecks (une exécution par heure et par tenant) aurait sinon déjà
    // été "chauffé" par les tests précédents de ce fichier qui chargent aussi des pages
    // /dashboard/* du même tenant, rendant ce test non déterministe.
    const freshAdmin = await registerTenantAdmin({
      tenantName: "Mobility Alerts Auto-Trigger",
      tenantSlug: `mobility-alerts-auto-${runId}`,
      name: "Admin Auto",
      email: `admin-auto-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    createdTenantIds.push(freshAdmin.tenantId);

    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: freshAdmin.sessionCookie },
      body: JSON.stringify({ name: "Agence Auto-Trigger", slug: `at-agence-${runId}` }),
    });
    const freshAgencyId = (await agencyResponse.json()).agency.id;

    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: freshAdmin.sessionCookie },
      body: JSON.stringify({
        agencyId: freshAgencyId,
        name: "Clio",
        licensePlate: `AT-${Math.floor(Math.random() * 1_000_000)}-AT`,
        make: "Renault",
        model: "Clio",
        year: 2022,
        category: "Citadine",
        pricePerDay: 4500,
        chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
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
      headers: { Cookie: freshAdmin.sessionCookie },
      body: JSON.stringify({
        vehicleId: vehicle.id,
        type: "OIL_CHANGE",
        scheduledDate: new Date().toISOString().slice(0, 10),
      }),
    });

    // Sprint 13E tâche 2 (revue INC-3) : le throttle horaire (`Tenant.lastAlertCheckAt`) est un
    // état partagé au niveau de la base de test entière, pas propre à ce fichier — le CRON
    // global (`runScheduledAlertChecksForAllTenants`, `scheduled-alerts-cron.test.ts`) scanne
    // littéralement tous les tenants de la base de test à chaque exécution (comportement
    // production correct : un vrai CRON doit balayer tous les tenants). Sous la suite complète
    // (fichiers exécutés en parallèle), ce CRON peut donc réclamer le throttle de CE tenant
    // fraîchement créé pendant la fenêtre entre son enregistrement et la création de la
    // maintenance ci-dessus (avant qu'il n'y ait quoi que ce soit à détecter) — la vérification
    // ci-dessous, déclenchée par le chargement de page, échouerait alors silencieusement
    // (throttle déjà consommé, donc jamais réexécuté dans cette même heure), sans rapport avec
    // le comportement testé lui-même. Observé une fois sur 8 exécutions de la suite complète
    // (`npx vitest run`), jamais en isolation ni en groupe (surface d'interférence minimale
    // hors de la suite complète). Ce n'est ni INC-3 (aucune erreur de connexion), ni une
    // régression de `Promise.allSettled` (aucune exception journalisée). Puisque cette
    // précondition (throttle jamais réclamé) est exactement ce que ce test a toujours eu
    // l'intention de garantir avec un tenant « frais » (voir commentaire au-dessus), on la
    // rétablit explicitement ici plutôt que de supposer qu'aucun autre processus global n'a pu
    // interférer entre-temps — ne modifie aucune assertion, ne masque aucun échec réel.
    await prisma.tenant.update({ where: { id: freshAdmin.tenantId }, data: { lastAlertCheckAt: null } });

    // Avant ce sprint, rien ne générait jamais cette alerte en usage réel (seul un POST
    // ADMIN manuel sur /api/tasks/check-alerts, jamais exposé par aucune UI, le faisait) —
    // voir src/lib/scheduled-tasks.ts, maybeRunScheduledAlertChecks. Le simple chargement
    // d'une page du dashboard (ici /dashboard/vehicles/[id]) doit désormais suffire.
    const pageResponse = await apiFetch(`/dashboard/vehicles/${vehicle.id}`, {
      headers: { Cookie: freshAdmin.sessionCookie },
    });
    expect(pageResponse.status).toBe(200);

    const alertsResponse = await apiFetch("/api/alerts?type=MAINTENANCE_DUE", {
      headers: { Cookie: freshAdmin.sessionCookie },
    });
    const { alerts } = await alertsResponse.json();
    const alert = alerts.find((a: { entityType: string | null }) => a.entityType === "Maintenance");
    expect(alert).toBeDefined();
  });
});

describe("Sprint 23 — throttle des vérifications d'alertes porté en base, multi-instance (DOMAINRULES.md section 39, remplace le Map en mémoire du Sprint 22)", () => {
  it("Tenant.lastAlertCheckAt est posé au premier appel et n'est plus mis à jour par un second appel immédiat (throttle actif)", async () => {
    const { maybeRunScheduledAlertChecks } = await import("@/lib/scheduled-tasks");

    const freshAdmin = await registerTenantAdmin({
      tenantName: "Alert Throttle DB",
      tenantSlug: `alert-throttle-db-${runId}`,
      name: "Admin Throttle",
      email: `admin-throttle-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    createdTenantIds.push(freshAdmin.tenantId);

    const before = await prisma.tenant.findUnique({ where: { id: freshAdmin.tenantId } });
    expect(before?.lastAlertCheckAt).toBeNull();

    await maybeRunScheduledAlertChecks(freshAdmin.tenantId);
    const afterFirst = await prisma.tenant.findUnique({ where: { id: freshAdmin.tenantId } });
    expect(afterFirst?.lastAlertCheckAt).not.toBeNull();

    await maybeRunScheduledAlertChecks(freshAdmin.tenantId);
    const afterSecond = await prisma.tenant.findUnique({ where: { id: freshAdmin.tenantId } });
    // Un second appel immédiat (dans la fenêtre d'une heure) ne doit jamais réclamer la garde
    // à nouveau — la valeur reste strictement identique, jamais réécrite. Le mécanisme
    // (updateMany conditionné, atomique côté Postgres) est le même que celui déjà testé pour
    // les transitions de statut concurrentes (locations/reservations/vehicle-trips) — seule sa
    // persistance en base (au lieu d'un Map en mémoire) est nouvelle ici, ce qui la rend
    // effective sur un déploiement multi-instance (chaque instance partage la même base).
    expect(afterSecond?.lastAlertCheckAt?.getTime()).toBe(afterFirst?.lastAlertCheckAt?.getTime());
  });
});
