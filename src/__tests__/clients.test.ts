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

async function createClient(
  admin: AuthenticatedTestUser,
  overrides: Record<string, unknown> = {}
) {
  return apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: "Client Test", ...overrides }),
  });
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Clients Test A",
    tenantSlug: `clients-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Clients Test B",
    tenantSlug: `clients-test-b-${runId}`,
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
    body: JSON.stringify({ name: "Agence A1", slug: `agence-a1-${runId}` }),
  });
  agencyA1Id = (await agencyA1Response.json()).agency.id;
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.invoice.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.location.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.client.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.userAgency.deleteMany({ where: { agency: { tenantId: { in: createdTenantIds } } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.agency.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

describe("POST /api/clients", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/clients", {
      method: "POST",
      body: JSON.stringify({ name: "X" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse un name manquant", async () => {
    const response = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email: "no-name@test.local" }),
    });
    expect(response.status).toBe(400);
  });

  it("crée le client rattaché au tenant de l'utilisateur connecté", async () => {
    const response = await createClient(adminA, { name: "Jean Dupont", email: "jean@test.local", phone: "0600000000" });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.client.tenantId).toBe(adminA.tenantId);
    expect(body.client.name).toBe("Jean Dupont");
  });

  it("autorise un MEMBER (pas de notion d'agence pour un client, DOMAINRULES.md section 9)", async () => {
    const response = await createClient(memberA, { name: "Client par membre" });
    expect(response.status).toBe(201);
  });

  it("dérive name à partir de firstName/lastName si name n'est pas fourni (Sprint 12A)", async () => {
    const response = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ firstName: "Karim", lastName: "El Amrani" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.client.name).toBe("Karim El Amrani");
    expect(body.client.firstName).toBe("Karim");
    expect(body.client.lastName).toBe("El Amrani");
  });

  it("refuse une requête sans name ni firstName/lastName", async () => {
    const response = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ email: "personne@test.local" }),
    });
    expect(response.status).toBe(400);
  });

  it("persiste les champs professionnels (identité, permis, adresse) — Sprint 12A", async () => {
    const response = await createClient(adminA, {
      name: "Client Complet",
      altPhone: "+212600000001",
      address: "10 avenue Hassan II",
      city: "Marrakech",
      country: "Maroc",
      idNumber: "AB123456",
      idType: "CIN",
      licenseNumber: "12345678",
      licenseIssueDate: "2020-01-15",
      licenseExpiryDate: "2030-01-15", birthDate: "1990-01-01",
      notes: "Client fidèle",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.client.city).toBe("Marrakech");
    expect(body.client.idType).toBe("CIN");
    expect(body.client.licenseNumber).toBe("12345678");
    expect(new Date(body.client.licenseIssueDate).toISOString().slice(0, 10)).toBe("2020-01-15");
    expect(new Date(body.client.birthDate).toISOString().slice(0, 10)).toBe("1990-01-01");
  });

  it("refuse un idType invalide", async () => {
    const response = await createClient(adminA, { name: "Test idType", idType: "PERMIS_MOTO" });
    expect(response.status).toBe(400);
  });

  // Sprint 30 (DOMAINRULES.md section 45, point 7) : birthDate reste optionnelle à la
  // création/modification d'un client — un client de moins de 21 ans (ou sans date de naissance
  // connue) peut toujours être enregistré (CLAUDE.md section 2 point 7), seule sa désignation
  // comme conducteur d'un contrat est bloquée (voir locations.test.ts/reservations.test.ts).
  it("accepte la création d'un client sans birthDate (jamais bloquant uniquement à cause de l'âge)", async () => {
    const response = await createClient(adminA, { name: "Client Sans Naissance" });
    expect(response.status).toBe(201);
  });

  it("accepte la création d'un client dont la date de naissance le rendrait mineur pour conduire (< 21 ans)", async () => {
    const response = await createClient(adminA, { name: "Client Jeune", birthDate: "2020-01-01" });
    expect(response.status).toBe(201);
  });

  it("refuse (400) une birthDate au format invalide", async () => {
    const response = await createClient(adminA, { name: "Client Date Invalide", birthDate: "pas-une-date" });
    expect(response.status).toBe(400);
  });

  it("refuse (400) une birthDate future", async () => {
    const response = await createClient(adminA, { name: "Client Date Future", birthDate: "2099-01-01" });
    expect(response.status).toBe(400);
  });

  // Campagne de validation QA (2026-08-26, partie 1) : aucun contrôle n'existait empêchant une
  // date d'expiration de permis antérieure ou égale à sa date d'obtention — bug corrigé par
  // assertValidLicenseDates (src/lib/clients.ts).
  it("refuse (400) une date d'expiration de permis antérieure à sa date d'obtention", async () => {
    const response = await createClient(adminA, {
      name: "Client Permis Incohérent",
      licenseIssueDate: "2025-01-01",
      licenseExpiryDate: "2020-01-01",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/postérieure à sa date d'obtention/);
  });

  it("refuse (400) une date d'expiration de permis égale à sa date d'obtention (validité nulle)", async () => {
    const response = await createClient(adminA, {
      name: "Client Permis Duree Nulle",
      licenseIssueDate: "2025-01-01",
      licenseExpiryDate: "2025-01-01",
    });
    expect(response.status).toBe(400);
  });

  it("accepte une date d'expiration de permis strictement postérieure à sa date d'obtention", async () => {
    const response = await createClient(adminA, {
      name: "Client Permis Coherent",
      licenseIssueDate: "2020-01-15",
      licenseExpiryDate: "2030-01-15",
    });
    expect(response.status).toBe(201);
  });

  it("accepte la création sans qu'aucune des deux dates de permis ne soit fournie", async () => {
    const response = await createClient(adminA, { name: "Client Sans Permis" });
    expect(response.status).toBe(201);
  });

  // Trouvé en revue stricte de la partie 1 (2026-08-26) : sans validation de format explicite,
  // une date non parseable produit un objet Date invalide (NaN), qu'assertValidLicenseDates ne
  // détecte pas (une comparaison impliquant NaN est toujours fausse) — l'écriture Prisma échouait
  // alors avec une erreur 500 non contrôlée au lieu d'un refus propre.
  it("refuse (400, jamais 500) une licenseIssueDate non parseable", async () => {
    const response = await createClient(adminA, {
      name: "Client Date Permis Invalide",
      licenseIssueDate: "not-a-date",
      licenseExpiryDate: "2030-01-01",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/licenseIssueDate doit être une date ISO valide/);
  });

  it("refuse (400, jamais 500) une licenseExpiryDate non parseable", async () => {
    const response = await createClient(adminA, {
      name: "Client Date Permis Invalide 2",
      licenseIssueDate: "2020-01-01",
      licenseExpiryDate: "not-a-date",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/licenseExpiryDate doit être une date ISO valide/);
  });

  // Trouvé en revue stricte de la partie 1 (2026-08-26) : une chaîne composée uniquement
  // d'espaces est truthy en JavaScript — un simple contrôle `!champ` (déjà en place pour name
  // via sa dérivation, mais absent pour firstName/lastName pris isolément) laissait passer un
  // lastName incohérent tant qu'un firstName réel était fourni.
  it("refuse (400) un firstName/lastName composé uniquement d'espaces malgré un prénom réel", async () => {
    const response = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ firstName: "Ahmed", lastName: "   " }),
    });
    expect(response.status).toBe(400);
  });
});

describe("GET /api/clients", () => {
  it("liste uniquement les clients du tenant connecté (isolation multi-tenant)", async () => {
    const clientAResponse = await createClient(adminA, { name: `Isolation A ${runId}` });
    const clientAId = (await clientAResponse.json()).client.id;

    const clientBResponse = await createClient(adminB, { name: `Isolation B ${runId}` });
    const clientBId = (await clientBResponse.json()).client.id;

    const response = await apiFetch("/api/clients", { headers: { Cookie: adminA.sessionCookie } });
    const body = await response.json();
    const ids: string[] = body.clients.map((c: { id: string }) => c.id);
    expect(ids).toContain(clientAId);
    expect(ids).not.toContain(clientBId);
  });

  it("filtre par recherche (nom ou email)", async () => {
    const uniqueName = `SearchTarget-${runId}`;
    const createResponse = await createClient(adminA, { name: uniqueName, email: `${uniqueName}@test.local` });
    const clientId = (await createResponse.json()).client.id;

    const response = await apiFetch(`/api/clients?search=${uniqueName}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    const body = await response.json();
    const ids: string[] = body.clients.map((c: { id: string }) => c.id);
    expect(ids).toContain(clientId);
    expect(body.clients.length).toBe(1);
  });
});

describe("GET /api/clients/[id]", () => {
  it("retourne 404 pour un client d'un autre tenant (isolation multi-tenant)", async () => {
    const clientBResponse = await createClient(adminB, { name: `Cross tenant ${runId}` });
    const clientBId = (await clientBResponse.json()).client.id;

    const response = await apiFetch(`/api/clients/${clientBId}`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });

  it("retourne 401 pour une requête non authentifiée", async () => {
    const createResponse = await createClient(adminA);
    const clientId = (await createResponse.json()).client.id;

    const response = await apiFetch(`/api/clients/${clientId}`);
    expect(response.status).toBe(401);
  });
});

describe("PATCH /api/clients/[id]", () => {
  it("Sprint technique 5 (audit de sécurité, faille corrigée) : un champ `tenantId` injecté dans le corps de la requête ne rattache jamais le client à un autre tenant", async () => {
    const createResponse = await createClient(adminA, { name: `Sécurité mass-assignment ${runId}` });
    const clientId = (await createResponse.json()).client.id;

    // Avant correction, PATCH construisait sa mise à jour Prisma à partir d'un spread du corps
    // brut de la requête (`...body`) : `tenantId` est une colonne réelle de Client, acceptée sans
    // filtrage par Prisma — un simple appel API (hors de toute interface, qui n'envoie jamais ce
    // champ) suffisait à faire passer un client d'un tenant à l'autre, cassant l'isolation tenant
    // (SECURITY.md section 1) pour quiconque a seulement `clients.edit`.
    const response = await apiFetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ tenantId: adminB.tenantId, phone: "0622222222" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    // Le champ légitime de la requête est bien appliqué...
    expect(body.client.phone).toBe("0622222222");
    // ...mais tenantId reste strictement inchangé.
    expect(body.client.tenantId).toBe(adminA.tenantId);

    const persisted = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(persisted.tenantId).toBe(adminA.tenantId);

    // Le client reste invisible depuis le tenant B (aucune fuite inter-tenant provoquée).
    const fromTenantB = await apiFetch(`/api/clients/${clientId}`, {
      headers: { Cookie: adminB.sessionCookie },
    });
    expect(fromTenantB.status).toBe(404);
  });

  it("Sprint technique 5 (audit de sécurité, faille corrigée) : `id`/`createdAt` injectés dans le corps de la requête sont sans effet", async () => {
    const createResponse = await createClient(adminA, { name: `Sécurité id/createdAt ${runId}` });
    const created = (await createResponse.json()).client;

    const response = await apiFetch(`/api/clients/${created.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ id: "attacker-chosen-id", createdAt: "2000-01-01T00:00:00.000Z" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.client.id).toBe(created.id);
    expect(body.client.createdAt).toBe(created.createdAt);
  });

  // Campagne de validation QA (2026-08-26, partie 1) : même bug que POST, avec un piège
  // supplémentaire propre à une édition partielle — modifier un seul des deux champs de date
  // doit se résoudre contre la valeur déjà en base, pas seulement contre le corps de la requête.
  it("refuse (400) une modification qui rendrait la date d'expiration antérieure à la date d'obtention déjà enregistrée", async () => {
    const createResponse = await createClient(adminA, {
      name: `Permis Coherent Puis Incoherent ${runId}`,
      licenseIssueDate: "2020-01-01",
      licenseExpiryDate: "2030-01-01",
    });
    const clientId = (await createResponse.json()).client.id;

    // Ne modifie que licenseExpiryDate — doit être comparée à licenseIssueDate déjà en base.
    const response = await apiFetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ licenseExpiryDate: "2019-01-01" }),
    });
    expect(response.status).toBe(400);

    const persisted = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(persisted.licenseExpiryDate?.toISOString().slice(0, 10)).toBe("2030-01-01");
  });

  it("accepte une modification de licenseIssueDate qui reste cohérente avec licenseExpiryDate déjà enregistrée", async () => {
    const createResponse = await createClient(adminA, {
      name: `Permis Modif Coherente ${runId}`,
      licenseIssueDate: "2020-01-01",
      licenseExpiryDate: "2030-01-01",
    });
    const clientId = (await createResponse.json()).client.id;

    const response = await apiFetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ licenseIssueDate: "2021-01-01" }),
    });
    expect(response.status).toBe(200);
  });

  it("refuse (400, jamais 500) une modification avec une date de permis non parseable", async () => {
    const createResponse = await createClient(adminA, { name: `Permis Modif Invalide ${runId}` });
    const clientId = (await createResponse.json()).client.id;

    const response = await apiFetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ licenseIssueDate: "not-a-date" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuse (400) une modification de lastName composée uniquement d'espaces", async () => {
    const createResponse = await createClient(adminA, { name: `Nom Modif Invalide ${runId}`, firstName: "Rachid", lastName: `Zeroual-${runId}` });
    const clientId = (await createResponse.json()).client.id;

    const response = await apiFetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ lastName: "   " }),
    });
    expect(response.status).toBe(400);

    const persisted = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(persisted.lastName).toBe(`Zeroual-${runId}`);
  });

  it("accepte l'effacement explicite (null) de firstName/lastName", async () => {
    const createResponse = await createClient(adminA, { name: `Nom Effacable ${runId}`, firstName: "Meryem", lastName: `Chaoui-${runId}` });
    const clientId = (await createResponse.json()).client.id;

    const response = await apiFetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ firstName: null }),
    });
    expect(response.status).toBe(200);
  });

  it("permet de modifier le nom, l'email et le téléphone", async () => {
    const createResponse = await createClient(adminA, { name: "Avant modif" });
    const clientId = (await createResponse.json()).client.id;

    const response = await apiFetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Après modif", email: "apres@test.local", phone: "0611111111" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.client.name).toBe("Après modif");
    expect(body.client.email).toBe("apres@test.local");
  });

  it("synchronise name quand firstName/lastName changent sans name explicite (Sprint 12A)", async () => {
    const createResponse = await createClient(adminA, {
      firstName: "Yassine",
      lastName: "Bennani",
    });
    const clientId = (await createResponse.json()).client.id;

    const response = await apiFetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ lastName: "Alaoui" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.client.lastName).toBe("Alaoui");
    expect(body.client.name).toBe("Yassine Alaoui");
  });

  it("refuse un name vide", async () => {
    const createResponse = await createClient(adminA);
    const clientId = (await createResponse.json()).client.id;

    const response = await apiFetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "" }),
    });
    expect(response.status).toBe(400);
  });

  it("retourne 404 pour un client d'un autre tenant", async () => {
    const clientBResponse = await createClient(adminB, { name: `PATCH cross tenant ${runId}` });
    const clientBId = (await clientBResponse.json()).client.id;

    const response = await apiFetch(`/api/clients/${clientBId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Hacked" }),
    });
    expect(response.status).toBe(404);
  });

  // Sprint 30 (DOMAINRULES.md section 45, point 7).
  it("permet de renseigner birthDate après coup, sans blocage lié à l'âge", async () => {
    const createResponse = await createClient(adminA, { name: "Sans naissance au départ" });
    const clientId = (await createResponse.json()).client.id;

    const response = await apiFetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ birthDate: "2020-01-01" }), // rendrait le client mineur pour conduire
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(new Date(body.client.birthDate).toISOString().slice(0, 10)).toBe("2020-01-01");
  });

  it("refuse (400) une birthDate future en modification", async () => {
    const createResponse = await createClient(adminA, { name: "Test PATCH Date Future" });
    const clientId = (await createResponse.json()).client.id;

    const response = await apiFetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ birthDate: "2099-01-01" }),
    });
    expect(response.status).toBe(400);
  });

  it("permet d'effacer birthDate (null)", async () => {
    const createResponse = await createClient(adminA, { name: "Avec naissance", birthDate: "1990-01-01" });
    const clientId = (await createResponse.json()).client.id;

    const response = await apiFetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ birthDate: null }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.client.birthDate).toBeNull();
  });
});

describe("DELETE /api/clients/[id]", () => {
  it("supprime un client sans location", async () => {
    const createResponse = await createClient(adminA, { name: "Suppression OK" });
    const clientId = (await createResponse.json()).client.id;

    const response = await apiFetch(`/api/clients/${clientId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("refuse la suppression d'un client ayant une location", async () => {
    const createResponse = await createClient(adminA, {
      name: "Suppression bloquée",
      licenseExpiryDate: "2030-01-01", birthDate: "1990-01-01",
    });
    const clientId = (await createResponse.json()).client.id;

    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId: agencyA1Id,
        name: "Clio",
        licensePlate: `CL-${Math.floor(Math.random() * 1_000_000)}-CL`,
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
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        clientId,
        startDate: "2027-04-01",
        endDate: "2027-04-03",
      }),
    });

    const response = await apiFetch(`/api/clients/${clientId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(409);
  });
});

describe("POST /api/clients — détection de doublons (Sprint 12C)", () => {
  it("détecte un doublon exact par email (409, matchType exact)", async () => {
    const email = `doublon-email-${runId}@test.local`;
    const first = await createClient(adminA, { name: "Original Email", email });
    expect(first.status).toBe(201);

    const response = await createClient(adminA, { name: "Autre nom", email });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.duplicate.matchType).toBe("exact");
    expect(body.duplicate.field).toBe("email");
  });

  it("détecte un doublon exact par téléphone, après normalisation", async () => {
    const phone = `+212 6-11 22-${runId.slice(-4)}`;
    const first = await createClient(adminA, { name: "Original Phone", phone });
    expect(first.status).toBe(201);

    const response = await createClient(adminA, { name: "Autre", phone: phone.replace(/[\s-]/g, "") });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.duplicate.field).toBe("phone");
  });

  it("détecte un doublon exact par idNumber", async () => {
    const idNumber = `DUP-${runId}`;
    const first = await createClient(adminA, { name: "Original CIN", idNumber, idType: "CIN" });
    expect(first.status).toBe(201);

    const response = await createClient(adminA, { name: "Autre", idNumber, idType: "CIN" });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.duplicate.field).toBe("idNumber");
  });

  it("détecte un doublon probable par similarité de nom (Levenshtein < 3, matchType fuzzy)", async () => {
    const first = await createClient(adminA, {
      name: "Ahmed Benali",
      firstName: "Ahmed",
      lastName: `Benali${runId}`,
    });
    expect(first.status).toBe(201);

    const response = await createClient(adminA, { firstName: "Ahmed", lastName: `Benaly${runId}` });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.duplicate.matchType).toBe("fuzzy");
  });

  it("useExistingClientId réutilise le client existant et met à jour son téléphone", async () => {
    const email = `reuse-${runId}@test.local`;
    const created = await createClient(adminA, { name: "À réutiliser", email, phone: "0600000001" });
    const existingClient = (await created.json()).client;

    const response = await createClient(adminA, {
      name: "Peu importe",
      email,
      phone: "0600000002",
      useExistingClientId: existingClient.id,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.client.id).toBe(existingClient.id);
    expect(body.client.phone).toBe("0600000002");
  });

  it("forceCreate crée un nouveau client malgré un doublon détecté", async () => {
    const email = `force-${runId}@test.local`;
    const first = await createClient(adminA, { name: "Premier", email });
    expect(first.status).toBe(201);

    const response = await createClient(adminA, { name: "Deuxième quand même", email, forceCreate: true });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.client.email).toBe(email);
    expect(body.client.notes).toContain("Créé malgré une correspondance possible");
  });
});

describe("Sprint 15 — permissions granulaires (clients.create)", () => {
  it("refuse un MEMBER dont le groupe personnalisé n'a pas clients.create (pas de notion d'agence ici)", async () => {
    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoClientCreate-${runId}`, permissions: ["clients.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Member",
      email: `restricted-clients-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const response = await createClient(restrictedMember, { name: "Refusé" });
    expect(response.status).toBe(403);
  });

  it("autorise un MEMBER dont le groupe personnalisé accorde clients.create", async () => {
    const grantedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `WithClientCreate-${runId}`, permissions: ["clients.view", "clients.create"] }),
    });
    const grantedGroupId = (await grantedGroupResponse.json()).group.id;

    const grantedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Granted Member",
      email: `granted-clients-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await apiFetch(`/api/users/${grantedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: grantedGroupId }),
    });

    const response = await createClient(grantedMember, { name: "Autorisé" });
    expect(response.status).toBe(201);
  });

  it("un ADMIN crée un client même rattaché à un groupe personnalisé vide (bypass systématique)", async () => {
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
      const response = await createClient(adminA, { name: "Admin toujours autorisé" });
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
