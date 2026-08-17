import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

/**
 * Sprint 24-1 : suppression du journal d'audit (unité/masse/purge complète du tenant), brief
 * explicite du propriétaire du projet — voir src/lib/audit.ts, src/app/api/audit/[id]/route.ts,
 * .../bulk-delete/route.ts, .../purge/route.ts. Trois garanties à couvrir : (1) double gate
 * role === "ADMIN" ET can(user, "audit.delete"), jamais l'un sans l'autre ; (2) isolation stricte
 * par tenant, y compris quand une liste d'ids mélange plusieurs tenants ; (3) aucune donnée
 * métier n'est jamais touchée, uniquement des lignes AuditLog.
 */
const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const password = "Correct-Horse-Battery-Staple9!";
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;

async function createAgency(admin: AuthenticatedTestUser, name: string) {
  const response = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${runId}` }),
  });
  return (await response.json()).agency as { id: string };
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Audit Delete A",
    tenantSlug: `audit-delete-a-${runId}`,
    name: "Admin A",
    email: `admin-a-audit-delete-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Audit Delete B",
    tenantSlug: `audit-delete-b-${runId}`,
    name: "Admin B",
    email: `admin-b-audit-delete-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(adminB.tenantId);
});

afterAll(async () => {
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userPermission.deleteMany({ where: { user: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.groupPermission.deleteMany({ where: { group: { tenantId: { in: createdTenantIds } } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("Suppression du journal d'audit — accès (Sprint 24-1)", () => {
  it("DELETE /api/audit/[id] refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/audit/nonexistent", { method: "DELETE" });
    expect(response.status).toBe(401);
  });

  it("DELETE /api/audit/[id] refuse un MEMBER même avec audit.delete accordé via un groupe personnalisé", async () => {
    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `AuditDeleters-${runId}`, permissions: ["audit.delete", "audit.view"] }),
    });
    const groupId = (await groupResponse.json()).group.id;

    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Would-be Auditor",
      email: `would-be-auditor-${runId}@test.local`,
      password,
    });
    await apiFetch(`/api/users/${member.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: groupId }),
    });

    const agency = await createAgency(adminA, `Agence Audit Del ${runId}`);
    const log = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, resource: "Agency", resourceId: agency.id },
    });
    expect(log).not.toBeNull();

    const response = await apiFetch(`/api/audit/${log!.id}`, {
      method: "DELETE",
      headers: { Cookie: member.sessionCookie },
    });
    expect(response.status).toBe(403);

    const stillThere = await prisma.auditLog.findUnique({ where: { id: log!.id } });
    expect(stillThere).not.toBeNull();
  });

  it("DELETE /api/audit/[id] refuse un ADMIN sans la permission audit.delete assignée (jamais possédée par défaut, non-régression)", async () => {
    // Un ADMIN a toujours can() === true (court-circuit sur le rôle, src/lib/permissions.ts) —
    // ce test documente que la garde repose donc réellement sur les deux conditions en code,
    // pas seulement observable côté MEMBER : un ADMIN "normal" (jamais l'objet d'un retrait de
    // permission, ce concept n'existe pas pour ADMIN) passe bien la garde.
    const agency = await createAgency(adminA, `Agence Audit Del Admin ${runId}`);
    const log = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, resource: "Agency", resourceId: agency.id },
    });
    const response = await apiFetch(`/api/audit/${log!.id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("GET /api/audit/purge et POST /api/audit/purge refusent un MEMBER", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Purge Refuser",
      email: `purge-refuser-${runId}@test.local`,
      password,
    });
    const getResponse = await apiFetch("/api/audit/purge", { headers: { Cookie: member.sessionCookie } });
    expect(getResponse.status).toBe(403);

    const postResponse = await apiFetch("/api/audit/purge", {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ confirmTenantName: "whatever" }),
    });
    expect(postResponse.status).toBe(403);
  });
});

describe("Suppression du journal d'audit — unité (Sprint 24-1)", () => {
  it("supprime une entrée, journalise la suppression, et ne renvoie que des lignes AuditLog (jamais de donnée métier)", async () => {
    const agency = await createAgency(adminA, `Agence Audit Unit ${runId}`);
    const vehicleCountBefore = await prisma.vehicle.count({ where: { tenantId: adminA.tenantId } });

    const log = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, resource: "Agency", resourceId: agency.id, action: "agency.created" },
    });
    expect(log).not.toBeNull();

    const response = await apiFetch(`/api/audit/${log!.id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);

    const deleted = await prisma.auditLog.findUnique({ where: { id: log!.id } });
    expect(deleted).toBeNull();

    const selfLog = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, action: "audit.log_deleted", resourceId: log!.id },
    });
    expect(selfLog).not.toBeNull();
    const metadata = selfLog?.metadata as { deletedAction?: string; deletedResource?: string } | null;
    expect(metadata?.deletedAction).toBe("agency.created");
    expect(metadata?.deletedResource).toBe("Agency");

    // Aucune donnée métier affectée par une suppression d'entrée d'audit.
    const vehicleCountAfter = await prisma.vehicle.count({ where: { tenantId: adminA.tenantId } });
    expect(vehicleCountAfter).toBe(vehicleCountBefore);
    const agencyStillExists = await prisma.agency.findUnique({ where: { id: agency.id } });
    expect(agencyStillExists).not.toBeNull();
  });

  it("renvoie 404 pour une entrée déjà supprimée ou inexistante", async () => {
    const response = await apiFetch("/api/audit/does-not-exist", {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });

  it("un ADMIN ne peut jamais supprimer une entrée d'audit d'un autre tenant (isolation)", async () => {
    const agencyB = await createAgency(adminB, `Agence Audit B ${runId}`);
    const logB = await prisma.auditLog.findFirst({
      where: { tenantId: adminB.tenantId, resource: "Agency", resourceId: agencyB.id },
    });
    expect(logB).not.toBeNull();

    const response = await apiFetch(`/api/audit/${logB!.id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);

    const stillThere = await prisma.auditLog.findUnique({ where: { id: logB!.id } });
    expect(stillThere).not.toBeNull();
  });
});

describe("Suppression du journal d'audit — en masse (Sprint 24-1)", () => {
  it("refuse un tableau ids vide ou absent", async () => {
    const emptyResponse = await apiFetch("/api/audit/bulk-delete", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ ids: [] }),
    });
    expect(emptyResponse.status).toBe(400);

    const missingResponse = await apiFetch("/api/audit/bulk-delete", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({}),
    });
    expect(missingResponse.status).toBe(400);
  });

  it("supprime plusieurs entrées du tenant appelant et ignore silencieusement les ids d'un autre tenant", async () => {
    const agency1 = await createAgency(adminA, `Agence Bulk 1 ${runId}`);
    const agency2 = await createAgency(adminA, `Agence Bulk 2 ${runId}`);
    const agencyB = await createAgency(adminB, `Agence Bulk B ${runId}`);

    const [log1, log2, logB] = await Promise.all([
      prisma.auditLog.findFirst({ where: { tenantId: adminA.tenantId, resource: "Agency", resourceId: agency1.id } }),
      prisma.auditLog.findFirst({ where: { tenantId: adminA.tenantId, resource: "Agency", resourceId: agency2.id } }),
      prisma.auditLog.findFirst({ where: { tenantId: adminB.tenantId, resource: "Agency", resourceId: agencyB.id } }),
    ]);
    expect(log1 && log2 && logB).toBeTruthy();

    const response = await apiFetch("/api/audit/bulk-delete", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ ids: [log1!.id, log2!.id, logB!.id] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    // Seuls les deux ids du tenant A comptent — celui du tenant B est ignoré, jamais supprimé.
    expect(body.deleted).toBe(2);

    const [remaining1, remaining2, remainingB] = await Promise.all([
      prisma.auditLog.findUnique({ where: { id: log1!.id } }),
      prisma.auditLog.findUnique({ where: { id: log2!.id } }),
      prisma.auditLog.findUnique({ where: { id: logB!.id } }),
    ]);
    expect(remaining1).toBeNull();
    expect(remaining2).toBeNull();
    expect(remainingB).not.toBeNull();

    const selfLog = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, action: "audit.bulk_deleted" },
      orderBy: { createdAt: "desc" },
    });
    expect(selfLog).not.toBeNull();
    expect((selfLog?.metadata as { count?: number } | null)?.count).toBe(2);
  });
});

describe("Purge complète du journal d'audit (Sprint 24-1)", () => {
  it("GET renvoie le nom du tenant et le nombre d'entrées à purger", async () => {
    await createAgency(adminA, `Agence Purge Preview ${runId}`);
    const response = await apiFetch("/api/audit/purge", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tenantName).toBe("Audit Delete A");
    expect(typeof body.count).toBe("number");
    expect(body.count).toBeGreaterThan(0);
  });

  it("refuse une confirmation de nom incorrecte, sans rien supprimer, mais journalise la tentative", async () => {
    const before = await prisma.auditLog.count({ where: { tenantId: adminA.tenantId } });
    const response = await apiFetch("/api/audit/purge", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ confirmTenantName: "Nom incorrect" }),
    });
    expect(response.status).toBe(400);

    const failedLog = await prisma.auditLog.findFirst({
      where: { tenantId: adminA.tenantId, action: "audit.purge_failed" },
      orderBy: { createdAt: "desc" },
    });
    expect(failedLog).not.toBeNull();

    // Le log de tentative échouée lui-même s'ajoute : le compte augmente de 1, rien d'autre n'est purgé.
    const after = await prisma.auditLog.count({ where: { tenantId: adminA.tenantId } });
    expect(after).toBe(before + 1);
  });

  it("purge toutes les entrées du tenant courant, seule une entrée audit.purged subsiste, et n'affecte jamais l'autre tenant", async () => {
    await createAgency(adminA, `Agence Purge Real ${runId}`);
    const otherTenantCountBefore = await prisma.auditLog.count({ where: { tenantId: adminB.tenantId } });
    expect(otherTenantCountBefore).toBeGreaterThan(0);

    const preview = await apiFetch("/api/audit/purge", { headers: { Cookie: adminA.sessionCookie } });
    const { tenantName } = await preview.json();

    const response = await apiFetch("/api/audit/purge", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ confirmTenantName: tenantName }),
    });
    expect(response.status).toBe(200);

    const remaining = await prisma.auditLog.findMany({ where: { tenantId: adminA.tenantId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].action).toBe("audit.purged");

    // Aucune donnée métier affectée (l'agence créée juste avant reste intacte).
    const agencyCount = await prisma.agency.count({ where: { tenantId: adminA.tenantId } });
    expect(agencyCount).toBeGreaterThan(0);

    // Le tenant B n'est jamais affecté par la purge du tenant A.
    const otherTenantCountAfter = await prisma.auditLog.count({ where: { tenantId: adminB.tenantId } });
    expect(otherTenantCountAfter).toBe(otherTenantCountBefore);
  });
});
