import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createAlert, getAlerts, getPendingAlerts, acknowledgeAlert, resolveAlert } from "@/lib/alerts";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let memberA: AuthenticatedTestUser;
let agencyA1Id: string;
let agencyA2Id: string;

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Alerts Test A",
    tenantSlug: `alerts-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Alerts Test B",
    tenantSlug: `alerts-test-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminB.tenantId);

  memberA = await createAndLoginMember({
    tenantId: adminA.tenantId,
    name: "Member A",
    email: `member-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });

  const agencyA1Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A1", slug: `al-agence-a1-${runId}` }),
  });
  agencyA1Id = (await agencyA1Response.json()).agency.id;

  const agencyA2Response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A2", slug: `al-agence-a2-${runId}` }),
  });
  agencyA2Id = (await agencyA2Response.json()).agency.id;

  await prisma.userAgency.create({ data: { userId: memberA.userId, agencyId: agencyA1Id } });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("createAlert / getAlerts (src/lib/alerts.ts)", () => {
  it("crée une alerte PENDING par défaut, priorité MEDIUM par défaut", async () => {
    const alert = await createAlert({
      tenantId: adminA.tenantId,
      type: "OTHER",
      message: "Test création alerte",
    });
    expect(alert.status).toBe("PENDING");
    expect(alert.priority).toBe("MEDIUM");
    expect(alert.tenantId).toBe(adminA.tenantId);
  });

  it("isole les alertes par tenant", async () => {
    const alertA = await createAlert({ tenantId: adminA.tenantId, type: "OTHER", message: "Alerte A" });
    const alertB = await createAlert({ tenantId: adminB.tenantId, type: "OTHER", message: "Alerte B" });

    const alertsA = await getAlerts(adminA.tenantId);
    const idsA = alertsA.map((a) => a.id);
    expect(idsA).toContain(alertA.id);
    expect(idsA).not.toContain(alertB.id);
  });

  it("trie par priorité (URGENT en premier)", async () => {
    await createAlert({ tenantId: adminA.tenantId, type: "OTHER", priority: "LOW", message: "Basse priorité" });
    const urgent = await createAlert({
      tenantId: adminA.tenantId,
      type: "OTHER",
      priority: "URGENT",
      message: "Priorité urgente",
    });

    const alerts = await getAlerts(adminA.tenantId);
    expect(alerts[0].id).toBe(urgent.id);
  });
});

describe("acknowledgeAlert / resolveAlert (src/lib/alerts.ts)", () => {
  it("PENDING -> ACKNOWLEDGED -> RESOLVED", async () => {
    const alert = await createAlert({ tenantId: adminA.tenantId, type: "OTHER", message: "Cycle de vie" });

    const acknowledged = await acknowledgeAlert(adminA.tenantId, alert.id, adminA.userId);
    expect(acknowledged.status).toBe("ACKNOWLEDGED");
    expect(acknowledged.acknowledgedByUserId).toBe(adminA.userId);

    const resolved = await resolveAlert(adminA.tenantId, alert.id, adminA.userId);
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolvedByUserId).toBe(adminA.userId);
  });

  it("permet de résoudre directement depuis PENDING (sans passer par ACKNOWLEDGED)", async () => {
    const alert = await createAlert({ tenantId: adminA.tenantId, type: "OTHER", message: "Résolution directe" });
    const resolved = await resolveAlert(adminA.tenantId, alert.id, adminA.userId);
    expect(resolved.status).toBe("RESOLVED");
  });

  it("refuse de rouvrir une alerte RESOLVED (état terminal)", async () => {
    const alert = await createAlert({ tenantId: adminA.tenantId, type: "OTHER", message: "Terminal" });
    await resolveAlert(adminA.tenantId, alert.id, adminA.userId);

    await expect(acknowledgeAlert(adminA.tenantId, alert.id, adminA.userId)).rejects.toThrow();
  });

  it("getPendingAlerts exclut les alertes résolues", async () => {
    const alert = await createAlert({ tenantId: adminA.tenantId, type: "OTHER", message: "Pending check" });
    const pendingBefore = await getPendingAlerts(adminA.tenantId);
    expect(pendingBefore.map((a) => a.id)).toContain(alert.id);

    await resolveAlert(adminA.tenantId, alert.id, adminA.userId);
    const pendingAfter = await getPendingAlerts(adminA.tenantId);
    expect(pendingAfter.map((a) => a.id)).not.toContain(alert.id);
  });
});

describe("PATCH /api/alerts/[id]/acknowledge et /resolve", () => {
  it("refuse une requête non authentifiée", async () => {
    const alert = await createAlert({ tenantId: adminA.tenantId, type: "OTHER", message: "Non auth" });
    const response = await apiFetch(`/api/alerts/${alert.id}/acknowledge`, { method: "PATCH" });
    expect(response.status).toBe(401);
  });

  it("retourne 404 pour une alerte d'un autre tenant", async () => {
    const alertB = await createAlert({ tenantId: adminB.tenantId, type: "OTHER", message: "Autre tenant" });
    const response = await apiFetch(`/api/alerts/${alertB.id}/acknowledge`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });

  it("refuse un MEMBER non rattaché à l'agence de l'alerte", async () => {
    const alert = await createAlert({
      tenantId: adminA.tenantId,
      agencyId: agencyA2Id,
      type: "OTHER",
      message: "Agence non rattachée",
    });
    const response = await apiFetch(`/api/alerts/${alert.id}/acknowledge`, {
      method: "PATCH",
      headers: { Cookie: memberA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });

  it("autorise l'acquittement puis la résolution via HTTP", async () => {
    const alert = await createAlert({ tenantId: adminA.tenantId, type: "OTHER", message: "Cycle HTTP" });

    const ackResponse = await apiFetch(`/api/alerts/${alert.id}/acknowledge`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(ackResponse.status).toBe(200);
    expect((await ackResponse.json()).alert.status).toBe("ACKNOWLEDGED");

    const resolveResponse = await apiFetch(`/api/alerts/${alert.id}/resolve`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(resolveResponse.status).toBe(200);
    expect((await resolveResponse.json()).alert.status).toBe("RESOLVED");
  });

  it("refuse de résoudre une alerte déjà résolue", async () => {
    const alert = await createAlert({ tenantId: adminA.tenantId, type: "OTHER", message: "Déjà résolue" });
    await resolveAlert(adminA.tenantId, alert.id, adminA.userId);

    const response = await apiFetch(`/api/alerts/${alert.id}/resolve`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(409);
  });
});

describe("GET /api/alerts (filtrage par priorité/status)", () => {
  it("filtre par priorité", async () => {
    await createAlert({ tenantId: adminA.tenantId, type: "OTHER", priority: "URGENT", message: "Filtrage urgent" });

    const response = await apiFetch("/api/alerts?priority=URGENT", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.alerts.length).toBeGreaterThanOrEqual(1);
    expect(body.alerts.every((a: { priority: string }) => a.priority === "URGENT")).toBe(true);
  });

  it("filtre par status", async () => {
    const alert = await createAlert({ tenantId: adminA.tenantId, type: "OTHER", message: "Filtrage status" });
    await resolveAlert(adminA.tenantId, alert.id, adminA.userId);

    const response = await apiFetch("/api/alerts?status=RESOLVED", { headers: { Cookie: adminA.sessionCookie } });
    const body = await response.json();
    const ids: string[] = body.alerts.map((a: { id: string }) => a.id);
    expect(ids).toContain(alert.id);
    expect(body.alerts.every((a: { status: string }) => a.status === "RESOLVED")).toBe(true);
  });

  it("rejette un status invalide", async () => {
    const response = await apiFetch("/api/alerts?status=BOGUS", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(400);
  });
});

describe("Sprint 15 — permissions granulaires (alerts.acknowledge)", () => {
  it("refuse un MEMBER rattaché à l'agence mais dont le groupe personnalisé n'a pas alerts.acknowledge", async () => {
    const alert = await createAlert({
      tenantId: adminA.tenantId,
      agencyId: agencyA1Id,
      type: "OTHER",
      message: "Permissions — refusé",
    });

    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoAlertAck-${runId}`, permissions: ["alerts.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Member",
      email: `restricted-alerts-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: restrictedMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const response = await apiFetch(`/api/alerts/${alert.id}/acknowledge`, {
      method: "PATCH",
      headers: { Cookie: restrictedMember.sessionCookie },
    });
    expect(response.status).toBe(403);
  });

  it("autorise un MEMBER dont le groupe personnalisé accorde alerts.acknowledge", async () => {
    const alert = await createAlert({
      tenantId: adminA.tenantId,
      agencyId: agencyA1Id,
      type: "OTHER",
      message: "Permissions — accordé",
    });

    const grantedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `WithAlertAck-${runId}`, permissions: ["alerts.view", "alerts.acknowledge"] }),
    });
    const grantedGroupId = (await grantedGroupResponse.json()).group.id;

    const grantedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Granted Member",
      email: `granted-alerts-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: grantedMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${grantedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: grantedGroupId }),
    });

    const response = await apiFetch(`/api/alerts/${alert.id}/acknowledge`, {
      method: "PATCH",
      headers: { Cookie: grantedMember.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("un ADMIN acquitte une alerte même rattaché à un groupe personnalisé vide (bypass systématique)", async () => {
    const alert = await createAlert({
      tenantId: adminA.tenantId,
      agencyId: agencyA1Id,
      type: "OTHER",
      message: "Permissions — admin",
    });

    const emptyGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `EmptyAdminGroup-${runId}`, permissions: [] }),
    });
    const emptyGroupId = (await emptyGroupResponse.json()).group.id;

    await apiFetch(`/api/users/${adminA.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: emptyGroupId }),
    });

    try {
      const response = await apiFetch(`/api/alerts/${alert.id}/acknowledge`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
      });
      expect(response.status).toBe(200);
    } finally {
      await apiFetch(`/api/users/${adminA.userId}/permissions`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ permissionGroupId: null }),
      });
    }
  });
});
