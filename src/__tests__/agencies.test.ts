import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let memberA: AuthenticatedTestUser;
let agencyA1Id: string;
let agencyB1Id: string;

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Agencies Test A",
    tenantSlug: `agencies-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Agencies Test B",
    tenantSlug: `agencies-test-b-${runId}`,
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

  const agencyAResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A1", slug: "agence-a1" }),
  });
  agencyA1Id = (await agencyAResponse.json()).agency.id;

  const agencyBResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Agence B1", slug: "agence-b1" }),
  });
  agencyB1Id = (await agencyBResponse.json()).agency.id;
});

afterAll(async () => {
  await prisma.userAgency.deleteMany({
    where: { agency: { tenantId: { in: createdTenantIds } } },
  });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("POST /api/agencies", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/agencies", {
      method: "POST",
      body: JSON.stringify({ name: "Sans auth" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER", async () => {
    const response = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: memberA.sessionCookie },
      body: JSON.stringify({ name: "Interdit" }),
    });
    expect(response.status).toBe(403);
  });

  it("crée l'agence rattachée au tenant de l'ADMIN connecté", async () => {
    expect(agencyA1Id).toBeDefined();
  });

  it("persiste les champs professionnels (ville, adresse, contact, responsable) — Sprint 12A", async () => {
    const response = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: "Agence complète",
        city: "Casablanca",
        address: "12 rue des Fleurs",
        phone: "+212612345678",
        email: "agence@example.test",
        managerName: "Fatima Zahra",
        managerPhone: "+212698765432",
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.agency.city).toBe("Casablanca");
    expect(body.agency.address).toBe("12 rue des Fleurs");
    expect(body.agency.phone).toBe("+212612345678");
    expect(body.agency.email).toBe("agence@example.test");
    expect(body.agency.managerName).toBe("Fatima Zahra");
    expect(body.agency.managerPhone).toBe("+212698765432");
  });

  it("accepte toujours une création minimale sans les nouveaux champs (rétrocompatibilité)", async () => {
    const response = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence minimale" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.agency.city).toBeNull();
  });
});

describe("GET /api/agencies", () => {
  it("liste uniquement les agences du tenant connecté (isolation multi-tenant)", async () => {
    const response = await apiFetch("/api/agencies", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    const ids: string[] = body.agencies.map((a: { id: string }) => a.id);
    expect(ids).toContain(agencyA1Id);
    expect(ids).not.toContain(agencyB1Id);
  });
});

describe("GET /api/agencies/[id]", () => {
  it("un ADMIN accède à toute agence de son tenant", async () => {
    const response = await apiFetch(`/api/agencies/${agencyA1Id}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("retourne 404 pour une agence d'un autre tenant (isolation multi-tenant)", async () => {
    const response = await apiFetch(`/api/agencies/${agencyB1Id}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });

  it("retourne 404 pour un MEMBER non rattaché à l'agence (isolation multi-agence)", async () => {
    const response = await apiFetch(`/api/agencies/${agencyA1Id}`, {
      headers: { Cookie: memberA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });

  it("autorise un MEMBER une fois explicitement rattaché à l'agence", async () => {
    await prisma.userAgency.create({
      data: { userId: memberA.userId, agencyId: agencyA1Id },
    });

    const response = await apiFetch(`/api/agencies/${agencyA1Id}`, {
      headers: { Cookie: memberA.sessionCookie },
    });
    expect(response.status).toBe(200);
  });
});

describe("PATCH /api/agencies/[id]", () => {
  it("refuse un MEMBER même rattaché à l'agence", async () => {
    const response = await apiFetch(`/api/agencies/${agencyA1Id}`, {
      method: "PATCH",
      headers: { Cookie: memberA.sessionCookie },
      body: JSON.stringify({ name: "Tentative membre" }),
    });
    expect(response.status).toBe(403);
  });

  it("permet à l'ADMIN du tenant de modifier l'agence", async () => {
    const response = await apiFetch(`/api/agencies/${agencyA1Id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence A1 renommée" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agency.name).toBe("Agence A1 renommée");
  });

  it("met à jour les champs professionnels sans exiger name (Sprint 12A)", async () => {
    const response = await apiFetch(`/api/agencies/${agencyA1Id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ city: "Rabat", phone: "+212611111111" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agency.city).toBe("Rabat");
    expect(body.agency.phone).toBe("+212611111111");
  });
});

describe("DELETE /api/agencies/[id]", () => {
  it("retourne 404 pour une agence d'un autre tenant", async () => {
    const response = await apiFetch(`/api/agencies/${agencyB1Id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });

  it("refuse la suppression d'une agence ayant des utilisateurs rattachés", async () => {
    const response = await apiFetch(`/api/agencies/${agencyA1Id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(409);
  });

  it("supprime une agence sans utilisateur rattaché", async () => {
    const createResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence A2", slug: "agence-a2" }),
    });
    const agencyA2Id = (await createResponse.json()).agency.id;

    const deleteResponse = await apiFetch(`/api/agencies/${agencyA2Id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(200);
  });
});
