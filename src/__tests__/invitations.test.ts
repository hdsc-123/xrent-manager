import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const password = "Correct-Horse-Battery-Staple9!";
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Invitations Test A",
    tenantSlug: `invitations-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(adminA.tenantId);
});

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
  await prisma.$disconnect();
});

describe("POST /api/invitations", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/invitations", {
      method: "POST",
      body: JSON.stringify({ email: "invited@test.local" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un MEMBER (réservé ADMIN)", async () => {
    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Member A",
      email: `member-invite-${runId}@test.local`,
      password,
    });
    const response = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ email: "invited-by-member@test.local" }),
    });
    expect(response.status).toBe(403);
  });

  it("crée une invitation avec le rôle demandé", async () => {
    const response = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email: `invited-${runId}@test.local`, role: "ADMIN" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.invitation.email).toBe(`invited-${runId}@test.local`);
    expect(body.invitation.role).toBe("ADMIN");
    expect(body.invitation.status).toBe("PENDING");
  });

  it("refuse d'inviter un email déjà utilisateur du tenant", async () => {
    const response = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email: adminA.email }),
    });
    expect(response.status).toBe(409);
  });
});

describe("GET /api/invitations/[id]", () => {
  it("expose les champs non sensibles publiquement (pas de session requise)", async () => {
    const createResponse = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email: `public-view-${runId}@test.local` }),
    });
    const invitationId = (await createResponse.json()).invitation.id;

    const response = await apiFetch(`/api/invitations/${invitationId}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.invitation.email).toBe(`public-view-${runId}@test.local`);
    expect(body.invitation.tenantName).toBe("Invitations Test A");
  });
});

describe("POST /api/invitations/[id]/accept", () => {
  it("refuse un corps de requête disproportionné avant toute lecture (413, revue OWASP Phase 6, 2026-08-31)", async () => {
    // Route publique (aucune session) — un corps disproportionné était jusqu'ici intégralement
    // bufferisé par request.json() avant toute autre vérification. Id d'invitation arbitraire :
    // le refus intervient avant toute recherche en base (src/lib/request-guards.ts).
    const response = await apiFetch("/api/invitations/does-not-exist/accept", {
      method: "POST",
      body: JSON.stringify({ name: "X", password: "A".repeat(2 * 1024 * 1024) }),
    });
    expect(response.status).toBe(413);
  });

  it("crée le user avec l'email et le rôle de l'invitation, ignore l'email fourni par le client", async () => {
    const email = `accept-${runId}@test.local`;
    const createResponse = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email, role: "MEMBER" }),
    });
    const invitationId = (await createResponse.json()).invitation.id;

    const response = await apiFetch(`/api/invitations/${invitationId}/accept`, {
      method: "POST",
      body: JSON.stringify({
        name: "Nouvel utilisateur",
        password,
        email: "attacker-supplied@test.local",
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.email).toBe(email);
    expect(body.user.tenantId).toBe(adminA.tenantId);

    const stored = await prisma.user.findUnique({
      where: { tenantId_email: { tenantId: adminA.tenantId, email } },
    });
    expect(stored?.role).toBe("MEMBER");

    const invitation = await prisma.invitation.findUnique({ where: { id: invitationId } });
    expect(invitation?.status).toBe("ACCEPTED");
  });

  it("refuse une invitation déjà acceptée", async () => {
    const email = `accept-twice-${runId}@test.local`;
    const createResponse = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email }),
    });
    const invitationId = (await createResponse.json()).invitation.id;

    await apiFetch(`/api/invitations/${invitationId}/accept`, {
      method: "POST",
      body: JSON.stringify({ name: "Premier", password }),
    });

    const response = await apiFetch(`/api/invitations/${invitationId}/accept`, {
      method: "POST",
      body: JSON.stringify({ name: "Second", password }),
    });
    expect(response.status).toBe(409);
  });

  it("deux acceptations concurrentes de la même invitation : une seule réussit (200), l'autre reçoit un 409 propre (jamais un 500 brut), un seul user créé", async () => {
    const email = `accept-race-${runId}@test.local`;
    const createResponse = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email }),
    });
    const invitationId = (await createResponse.json()).invitation.id;

    const [responseA, responseB] = await Promise.all([
      apiFetch(`/api/invitations/${invitationId}/accept`, {
        method: "POST",
        body: JSON.stringify({ name: "Concurrent A", password }),
      }),
      apiFetch(`/api/invitations/${invitationId}/accept`, {
        method: "POST",
        body: JSON.stringify({ name: "Concurrent B", password }),
      }),
    ]);

    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const users = await prisma.user.findMany({
      where: { tenantId: adminA.tenantId, email },
    });
    expect(users).toHaveLength(1);

    const invitation = await prisma.invitation.findUnique({ where: { id: invitationId } });
    expect(invitation?.status).toBe("ACCEPTED");
  });

  it("refuse une invitation expirée", async () => {
    const email = `expired-${runId}@test.local`;
    const createResponse = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email }),
    });
    const invitationId = (await createResponse.json()).invitation.id;

    await prisma.invitation.update({
      where: { id: invitationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await apiFetch(`/api/invitations/${invitationId}/accept`, {
      method: "POST",
      body: JSON.stringify({ name: "Trop tard", password }),
    });
    expect(response.status).toBe(410);
  });

  it("rejette un mot de passe non conforme", async () => {
    const email = `weak-accept-${runId}@test.local`;
    const createResponse = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email }),
    });
    const invitationId = (await createResponse.json()).invitation.id;

    const response = await apiFetch(`/api/invitations/${invitationId}/accept`, {
      method: "POST",
      body: JSON.stringify({ name: "Faible", password: "weak" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("POST /api/invitations/[id]/decline", () => {
  it("marque l'invitation comme déclinée", async () => {
    const email = `decline-${runId}@test.local`;
    const createResponse = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email }),
    });
    const invitationId = (await createResponse.json()).invitation.id;

    const response = await apiFetch(`/api/invitations/${invitationId}/decline`, { method: "POST" });
    expect(response.status).toBe(200);

    const invitation = await prisma.invitation.findUnique({ where: { id: invitationId } });
    expect(invitation?.status).toBe("DECLINED");
  });
});

describe("DELETE /api/invitations/[id]", () => {
  it("révoque une invitation en attente (ADMIN only)", async () => {
    const email = `revoke-${runId}@test.local`;
    const createResponse = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email }),
    });
    const invitationId = (await createResponse.json()).invitation.id;

    const response = await apiFetch(`/api/invitations/${invitationId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);

    const invitation = await prisma.invitation.findUnique({ where: { id: invitationId } });
    expect(invitation).toBeNull();
  });
});
