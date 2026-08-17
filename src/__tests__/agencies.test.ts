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
  // Sprint 15 — le bloc "numérotation de contrat par agence" ci-dessous crée des
  // véhicules/clients/locations (contrats) : nettoyage étendu par rapport à la version
  // d'origine de ce fichier, même ordre que src/__tests__/locations.test.ts (FK).
  await prisma.payment.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({
    where: { agency: { tenantId: { in: createdTenantIds } } },
  });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
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

describe("Sprint 15 — numérotation de contrat par agence (déplacée depuis Tenant)", () => {
  it("accepte et persiste contractNumberPrefix/lastContractNumber", async () => {
    const response = await apiFetch(`/api/agencies/${agencyA1Id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ contractNumberPrefix: "RAK", lastContractNumber: 42 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agency.contractNumberPrefix).toBe("RAK");
    expect(body.agency.lastContractNumber).toBe(42);
  });

  it("refuse un lastContractNumber négatif ou non entier", async () => {
    const response = await apiFetch(`/api/agencies/${agencyA1Id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ lastContractNumber: -1 }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("lastContractNumber doit être un entier positif ou nul.");

    const nonInteger = await apiFetch(`/api/agencies/${agencyA1Id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ lastContractNumber: 1.5 }),
    });
    expect(nonInteger.status).toBe(400);
    const nonIntegerBody = await nonInteger.json();
    expect(nonIntegerBody.error).toBe("lastContractNumber doit être un entier positif ou nul.");
  });

  it("deux agences du même tenant ont des compteurs de contrat indépendants et simultanés", async () => {
    const rakAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence RAK", slug: `agence-rak-${runId}` }),
    });
    const rakAgencyId = (await rakAgencyResponse.json()).agency.id;

    const casaAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Agence CASA", slug: `agence-casa-${runId}` }),
    });
    const casaAgencyId = (await casaAgencyResponse.json()).agency.id;

    await apiFetch(`/api/agencies/${rakAgencyId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ contractNumberPrefix: "RAK" }),
    });
    await apiFetch(`/api/agencies/${casaAgencyId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ contractNumberPrefix: "CASA" }),
    });

    const rakVehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId: rakAgencyId,
        name: "Clio RAK",
        licensePlate: `NUM-RAK-${runId}`,
        make: "Renault",
        model: "Clio",
        year: 2022,
        category: "Citadine",
        pricePerDay: 5000,
        chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
        color: "Blanc",
        doors: 5,
        seats: 5,
        horsepower: 6,
        powerKW: 75,
        engineSize: 1.5,
      }),
    });
    const rakVehicleId = (await rakVehicleResponse.json()).vehicle.id;

    const casaVehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId: casaAgencyId,
        name: "Clio CASA",
        licensePlate: `NUM-CASA-${runId}`,
        make: "Renault",
        model: "Clio",
        year: 2022,
        category: "Citadine",
        pricePerDay: 5000,
        chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
        color: "Blanc",
        doors: 5,
        seats: 5,
        horsepower: 6,
        powerKW: 75,
        engineSize: 1.5,
      }),
    });
    const casaVehicleId = (await casaVehicleResponse.json()).vehicle.id;

    const clientResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: "Client Numérotation",
        email: `client-numerotation-${runId}@test.local`,
        licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01",
      }),
    });
    const clientId = (await clientResponse.json()).client.id;

    const rakLocationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId: rakVehicleId,
        clientId,
        startDate: "2031-01-10",
        endDate: "2031-01-12",
      }),
    });
    expect(rakLocationResponse.status).toBe(201);
    const rakLocation = (await rakLocationResponse.json()).location;
    expect(rakLocation.contractNumber).toBe("RAK-00001");

    const casaLocationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId: casaVehicleId,
        clientId,
        startDate: "2031-01-10",
        endDate: "2031-01-12",
      }),
    });
    expect(casaLocationResponse.status).toBe(201);
    const casaLocation = (await casaLocationResponse.json()).location;
    expect(casaLocation.contractNumber).toBe("CASA-00001");

    // Un deuxième contrat sur l'agence RAK avance sa propre séquence, sans affecter CASA.
    const rakSecondLocationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId: rakVehicleId,
        clientId,
        startDate: "2031-02-10",
        endDate: "2031-02-12",
      }),
    });
    expect(rakSecondLocationResponse.status).toBe(201);
    const rakSecondLocation = (await rakSecondLocationResponse.json()).location;
    expect(rakSecondLocation.contractNumber).toBe("RAK-00002");
  });
});

describe("Sprint 19 — solde de départ de caisse par agence (informatif)", () => {
  it("accepte et persiste cashStartingBalance", async () => {
    const response = await apiFetch(`/api/agencies/${agencyA1Id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ cashStartingBalance: 500_00 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agency.cashStartingBalance).toBe(500_00);
  });

  it("refuse un cashStartingBalance négatif ou non entier", async () => {
    const response = await apiFetch(`/api/agencies/${agencyA1Id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ cashStartingBalance: -100 }),
    });
    expect(response.status).toBe(400);
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

describe("Sprint 15 — permissions granulaires (agencies.create)", () => {
  it("un MEMBER du groupe MEMBER par défaut est refusé (agencies.create n'est dans aucun groupe par défaut)", async () => {
    // Couvre déjà le cas (a) via le groupe MEMBER par défaut lui-même : agencies.create n'est
    // accordé à aucun groupe par défaut (ADMIN excepté), voir DEFAULT_GROUPS dans
    // src/lib/permissions.ts — pas besoin d'un groupe personnalisé pour obtenir ce refus.
    const response = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: memberA.sessionCookie },
      body: JSON.stringify({ name: "Toujours interdit par défaut" }),
    });
    expect(response.status).toBe(403);
  });

  it("autorise un MEMBER dont le groupe personnalisé accorde explicitement agencies.create", async () => {
    const grantedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `WithAgencyCreate-${runId}`, permissions: ["agencies.view", "agencies.create"] }),
    });
    const grantedGroupId = (await grantedGroupResponse.json()).group.id;

    const grantedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Granted Member",
      email: `granted-agencies-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await apiFetch(`/api/users/${grantedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: grantedGroupId }),
    });

    const response = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: grantedMember.sessionCookie },
      body: JSON.stringify({ name: "Autorisé via groupe personnalisé", slug: `via-groupe-${runId}` }),
    });
    expect(response.status).toBe(201);
  });

  it("un ADMIN crée une agence même rattaché à un groupe personnalisé vide (bypass systématique)", async () => {
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
      const response = await apiFetch("/api/agencies", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ name: "Admin toujours autorisé", slug: `admin-bypass-${runId}` }),
      });
      expect(response.status).toBe(201);
    } finally {
      await apiFetch(`/api/users/${adminA.userId}/permissions`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ permissionGroupId: null }),
      });
    }
  });
});

describe("Sprint 17 — PATCH/DELETE /api/agencies/[id] scopées par canAccessAgency, pas seulement can()", () => {
  it("un MEMBER dont le groupe personnalisé accorde agencies.edit/agencies.delete ne peut pas modifier/supprimer une agence à laquelle il n'a pas accès (UserAgency)", async () => {
    const scopedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: `AgencyEditDelete-${runId}`,
        permissions: ["agencies.view", "agencies.edit", "agencies.delete"],
      }),
    });
    const scopedGroupId = (await scopedGroupResponse.json()).group.id;

    const inScopeAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Agence dans le scope ${runId}`, slug: `in-scope-${runId}` }),
    });
    const inScopeAgencyId = (await inScopeAgencyResponse.json()).agency.id;

    const outOfScopeAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `Agence hors scope ${runId}`, slug: `out-of-scope-${runId}` }),
    });
    const outOfScopeAgencyId = (await outOfScopeAgencyResponse.json()).agency.id;

    const scopedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Scoped Agency Member",
      email: `scoped-agency-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await apiFetch(`/api/users/${scopedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: scopedGroupId }),
    });
    // Rattaché uniquement à inScopeAgencyId — jamais à outOfScopeAgencyId.
    await apiFetch(`/api/users/${scopedMember.userId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ agencyIds: [inScopeAgencyId] }),
    });

    const patchInScope = await apiFetch(`/api/agencies/${inScopeAgencyId}`, {
      method: "PATCH",
      headers: { Cookie: scopedMember.sessionCookie },
      body: JSON.stringify({ city: "Casablanca" }),
    });
    expect(patchInScope.status).toBe(200);

    const patchOutOfScope = await apiFetch(`/api/agencies/${outOfScopeAgencyId}`, {
      method: "PATCH",
      headers: { Cookie: scopedMember.sessionCookie },
      body: JSON.stringify({ city: "Tentative hors scope" }),
    });
    expect(patchOutOfScope.status).toBe(404);

    const deleteOutOfScope = await apiFetch(`/api/agencies/${outOfScopeAgencyId}`, {
      method: "DELETE",
      headers: { Cookie: scopedMember.sessionCookie },
    });
    expect(deleteOutOfScope.status).toBe(404);

    // Vérifie que l'agence hors scope n'a réellement pas été modifiée par la tentative refusée.
    const stillIntact = await apiFetch(`/api/agencies/${outOfScopeAgencyId}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const stillIntactBody = await stillIntact.json();
    expect(stillIntactBody.agency.city).not.toBe("Tentative hors scope");
  });
});
