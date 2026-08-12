import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const password = "Correct-Horse-Battery-Staple9!";
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Audit Test A",
    tenantSlug: `audit-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Audit Test B",
    tenantSlug: `audit-test-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(adminB.tenantId);
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invitation.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("Journal d'audit (Sprint 9)", () => {
  it("enregistre une entrée lors d'un changement de rôle", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Audited Member",
      email: `audited-role-${runId}@test.local`,
      password,
    });

    await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ role: "ADMIN" }),
    });

    const logs = await prisma.auditLog.findMany({
      where: { tenantId: adminA.tenantId, resource: "User", resourceId: member.userId },
    });
    expect(logs.some((log) => log.action === "user.role_changed")).toBe(true);
  });

  it("enregistre une entrée lors de la création d'une invitation", async () => {
    const response = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email: `audit-invite-${runId}@test.local` }),
    });
    const invitationId = (await response.json()).invitation.id;

    const logs = await prisma.auditLog.findMany({
      where: { tenantId: adminA.tenantId, resource: "Invitation", resourceId: invitationId },
    });
    expect(logs.some((log) => log.action === "invitation.created")).toBe(true);
  });

  it("GET /api/audit refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/audit");
    expect(response.status).toBe(401);
  });

  it("GET /api/audit refuse un MEMBER", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Audit Reader",
      email: `audit-reader-${runId}@test.local`,
      password,
    });
    const response = await apiFetch("/api/audit", { headers: { Cookie: member.sessionCookie } });
    expect(response.status).toBe(403);
  });

  it("GET /api/audit ne retourne que les logs du tenant connecté (isolation)", async () => {
    await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({ email: `audit-b-${runId}@test.local` }),
    });

    const response = await apiFetch("/api/audit", { headers: { Cookie: adminA.sessionCookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.logs.every((log: { tenantId: string }) => log.tenantId === adminA.tenantId)).toBe(true);
  });
});
