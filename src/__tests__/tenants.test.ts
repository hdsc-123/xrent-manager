import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let memberA: AuthenticatedTestUser;

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Tenants Test A",
    tenantSlug: `tenants-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Tenants Test B",
    tenantSlug: `tenants-test-b-${runId}`,
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
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("GET /api/tenants", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/tenants");
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER", async () => {
    const response = await apiFetch("/api/tenants", {
      headers: { Cookie: memberA.sessionCookie },
    });
    expect(response.status).toBe(403);
  });

  it("un ADMIN ne voit jamais que son propre tenant (isolation multi-tenant)", async () => {
    const response = await apiFetch("/api/tenants", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    const ids: string[] = body.tenants.map((t: { id: string }) => t.id);
    expect(ids).toContain(adminA.tenantId);
    expect(ids).not.toContain(adminB.tenantId);
  });
});

describe("GET /api/tenants/[id]", () => {
  it("retourne le tenant de l'admin connecté", async () => {
    const response = await apiFetch(`/api/tenants/${adminA.tenantId}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tenant.id).toBe(adminA.tenantId);
  });

  it("retourne 404 pour le tenant d'un autre admin (pas de fuite inter-tenant)", async () => {
    const response = await apiFetch(`/api/tenants/${adminB.tenantId}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/tenants/[id]", () => {
  it("met à jour le tenant de l'admin connecté", async () => {
    const response = await apiFetch(`/api/tenants/${adminA.tenantId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Tenants Test A — renommé" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tenant.name).toBe("Tenants Test A — renommé");
  });

  it("refuse de modifier le tenant d'un autre admin", async () => {
    const response = await apiFetch(`/api/tenants/${adminB.tenantId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Hostile rename" }),
    });
    expect(response.status).toBe(404);
  });

  it("refuse un MEMBER même sur son propre tenant", async () => {
    const response = await apiFetch(`/api/tenants/${adminA.tenantId}`, {
      method: "PATCH",
      headers: { Cookie: memberA.sessionCookie },
      body: JSON.stringify({ name: "Member rename attempt" }),
    });
    expect(response.status).toBe(403);
  });
});

describe("POST /api/tenants", () => {
  it("refuse un MEMBER", async () => {
    const response = await apiFetch("/api/tenants", {
      method: "POST",
      headers: { Cookie: memberA.sessionCookie },
      body: JSON.stringify({ name: "Should Not Exist" }),
    });
    expect(response.status).toBe(403);
  });

  it("permet à un ADMIN de créer un tenant", async () => {
    const response = await apiFetch("/api/tenants", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Nouveau Tenant", slug: `nouveau-tenant-${runId}` }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    createdTenantIds.push(body.tenant.id);
  });
});

describe("DELETE /api/tenants/[id]", () => {
  it("refuse de supprimer le tenant d'un autre admin", async () => {
    const response = await apiFetch(`/api/tenants/${adminB.tenantId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });

  it("refuse la suppression d'un tenant ayant des utilisateurs actifs", async () => {
    const response = await apiFetch(`/api/tenants/${adminA.tenantId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(409);
  });
});
