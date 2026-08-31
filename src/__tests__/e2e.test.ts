import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch, extractSessionCookie } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const password = "Correct-Horse-Battery-Staple9!";
const createdTenantIds: string[] = [];

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
  await prisma.$disconnect();
});

describe("Scénario complet : inscription → CRUD métier → facturation → rapport", () => {
  it("parcourt tout le cycle de vie sans erreur", async () => {
    const admin = await registerTenantAdmin({
      tenantName: "E2E Tenant",
      tenantSlug: `e2e-${runId}`,
      name: "E2E Admin",
      email: `e2e-admin-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(admin.tenantId);

    const agencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: "Agence E2E", slug: `agence-e2e-${runId}` }),
    });
    expect(agencyResponse.status).toBe(201);
    const agencyId = (await agencyResponse.json()).agency.id;

    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({
        agencyId,
        name: "Clio E2E",
        licensePlate: `E2E-${runId}`,
        make: "Renault",
        model: "Clio",
        year: 2024,
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
    expect(vehicleResponse.status).toBe(201);
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const clientResponse = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: "Client E2E", licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
    });
    expect(clientResponse.status).toBe(201);
    const clientId = (await clientResponse.json()).client.id;

    const locationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({
        vehicleId,
        clientId,
        startDate: "2030-01-01",
        endDate: "2030-01-04",
      }),
    });
    expect(locationResponse.status).toBe(201);
    const location = (await locationResponse.json()).location;
    expect(location.totalPrice).toBe(15000);

    // Sprint 13E tâche 3 : POST /api/locations a déjà auto-généré la facture RENTAL de cette
    // location (getOrCreateMainInvoice) — cet appel la récupère donc de façon idempotente (200),
    // il n'en crée plus une seconde (comportement volontairement changé, voir DOMAINRULES.md).
    const invoiceResponse = await apiFetch("/api/invoices", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ locationId: location.id }),
    });
    expect(invoiceResponse.status).toBe(200);
    const invoice = (await invoiceResponse.json()).invoice;

    // Finding F : un paiement direct est refusé sur une facture encore DRAFT — finalise
    // d'abord (DRAFT → SENT, inconditionnel vis-à-vis du solde).
    const finalizeResponse = await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ status: "ISSUED" }),
    });
    expect(finalizeResponse.status).toBe(200);

    const paymentResponse = await apiFetch("/api/payments", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ invoiceId: invoice.id, amount: invoice.totalAmount, method: "CASH" }),
    });
    expect(paymentResponse.status).toBe(201);

    const invoiceAfterPayment = await apiFetch(`/api/invoices/${invoice.id}`, {
      headers: { Cookie: admin.sessionCookie },
    });
    expect((await invoiceAfterPayment.json()).invoice.status).toBe("PAID");

    // paidAt est horodaté à la date réelle du paiement (maintenant), pas aux dates de la
    // location (2030) : la période du rapport doit couvrir "aujourd'hui".
    const reportFrom = new Date();
    reportFrom.setUTCDate(reportFrom.getUTCDate() - 1);
    const reportTo = new Date();
    reportTo.setUTCDate(reportTo.getUTCDate() + 1);
    const reportResponse = await apiFetch(
      `/api/reports/revenue?from=${reportFrom.toISOString().slice(0, 10)}&to=${reportTo.toISOString().slice(0, 10)}`,
      { headers: { Cookie: admin.sessionCookie } }
    );
    expect(reportResponse.status).toBe(200);
    const report = await reportResponse.json();
    expect(report.totalRevenue).toBeGreaterThanOrEqual(invoice.totalAmount);

    // Invitation d'un second utilisateur, qui rejoint le tenant et voit la location créée ci-dessus.
    const inviteResponse = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ email: `e2e-invitee-${runId}@test.local`, role: "MEMBER" }),
    });
    const invitationId = (await inviteResponse.json()).invitation.id;

    const acceptResponse = await apiFetch(`/api/invitations/${invitationId}/accept`, {
      method: "POST",
      body: JSON.stringify({ name: "E2E Invitee", password }),
    });
    expect(acceptResponse.status).toBe(200);

    const inviteeLogin = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: `e2e-invitee-${runId}@test.local`,
        password,
        tenantId: admin.tenantId,
      }),
    });
    expect(inviteeLogin.status).toBe(200);
    const inviteeCookie = extractSessionCookie(inviteeLogin);

    // Le MEMBER invité n'est rattaché à aucune agence via UserAgency (hors périmètre du
    // flux d'invitation, voir DOMAINRULES.md section 4) : il ne voit donc aucune location
    // tant qu'un ADMIN ne l'a pas explicitement ajouté à l'agence concernée. On vérifie
    // seulement que la session tenant-scopée fonctionne (200, liste vide).
    const locationsAsInvitee = await apiFetch("/api/locations", {
      headers: { Cookie: inviteeCookie! },
    });
    expect(locationsAsInvitee.status).toBe(200);
    expect((await locationsAsInvitee.json()).locations).toEqual([]);
  });
});

describe("Sécurité — nouvelles surfaces Sprint 9", () => {
  let tenantA: AuthenticatedTestUser;
  let tenantB: AuthenticatedTestUser;

  it("prépare deux tenants isolés", async () => {
    tenantA = await registerTenantAdmin({
      tenantName: "Sécurité E2E A",
      tenantSlug: `secu-e2e-a-${runId}`,
      name: "Sécu Admin A",
      email: `secu-admin-a-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(tenantA.tenantId);

    tenantB = await registerTenantAdmin({
      tenantName: "Sécurité E2E B",
      tenantSlug: `secu-e2e-b-${runId}`,
      name: "Sécu Admin B",
      email: `secu-admin-b-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(tenantB.tenantId);

    expect(tenantA.tenantId).not.toBe(tenantB.tenantId);
  });

  it("un ADMIN ne peut ni voir ni modifier un user d'un autre tenant", async () => {
    const getResponse = await apiFetch(`/api/users/${tenantB.userId}`, {
      headers: { Cookie: tenantA.sessionCookie },
    });
    expect(getResponse.status).toBe(404);

    const patchResponse = await apiFetch(`/api/users/${tenantB.userId}`, {
      method: "PATCH",
      headers: { Cookie: tenantA.sessionCookie },
      body: JSON.stringify({ role: "MEMBER" }),
    });
    expect(patchResponse.status).toBe(404);
  });

  it("un ADMIN ne peut pas révoquer l'invitation d'un autre tenant", async () => {
    const inviteResponse = await apiFetch("/api/invitations", {
      method: "POST",
      headers: { Cookie: tenantB.sessionCookie },
      body: JSON.stringify({ email: `secu-invite-${runId}@test.local` }),
    });
    const invitationId = (await inviteResponse.json()).invitation.id;

    const response = await apiFetch(`/api/invitations/${invitationId}`, {
      method: "DELETE",
      headers: { Cookie: tenantA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });

  it("un MEMBER n'a accès à aucune des routes ADMIN-only introduites ce sprint", async () => {
    const member = await createAndLoginMember({
      tenantId: tenantA.tenantId,
      name: "Sécu Member",
      email: `secu-member-${runId}@test.local`,
      password,
    });

    const auditResponse = await apiFetch("/api/audit", { headers: { Cookie: member.sessionCookie } });
    expect(auditResponse.status).toBe(403);

    const invitationsResponse = await apiFetch("/api/invitations", {
      headers: { Cookie: member.sessionCookie },
    });
    expect(invitationsResponse.status).toBe(403);

    const usersPatchResponse = await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: member.sessionCookie },
      body: JSON.stringify({ role: "ADMIN" }),
    });
    expect(usersPatchResponse.status).toBe(403);
  });
});

describe("Visibilité de la route/onglet Réservations selon les permissions accordées (Sprint 15)", () => {
  it("un MEMBER sans reservations.view ne voit ni l'API ni la page ; l'octroi de la permission au groupe débloque les deux", async () => {
    const tenant = await registerTenantAdmin({
      tenantName: "Perm Reservations E2E",
      tenantSlug: `perm-reservations-e2e-${runId}`,
      name: "Perm Admin",
      email: `perm-admin-${runId}@test.local`,
      password,
    });
    createdTenantIds.push(tenant.tenantId);

    // Groupe personnalisé n'accordant explicitement pas reservations.view.
    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: tenant.sessionCookie },
      body: JSON.stringify({ name: `Sans-Reservations-${runId}`, permissions: ["clients.view"] }),
    });
    expect(groupResponse.status).toBe(201);
    const group = (await groupResponse.json()).group;
    expect(group.permissions).not.toContain("reservations.view");

    const member = await createAndLoginMember({
      tenantId: tenant.tenantId,
      name: "Membre Sans Réservations",
      email: `membre-sans-reservations-${runId}@test.local`,
      password,
    });

    const assignResponse = await apiFetch(`/api/users/${member.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: tenant.sessionCookie },
      body: JSON.stringify({ permissionGroupId: group.id }),
    });
    expect(assignResponse.status).toBe(200);

    // Sans la permission : 403 sur l'API, et la page ne rend pas la liste (carte "accès refusé").
    const deniedApiResponse = await apiFetch("/api/reservations", { headers: { Cookie: member.sessionCookie } });
    expect(deniedApiResponse.status).toBe(403);

    const deniedPageResponse = await apiFetch("/dashboard/reservations", {
      headers: { Cookie: member.sessionCookie },
    });
    expect(deniedPageResponse.status).toBe(200);
    const deniedHtml = await deniedPageResponse.text();
    expect(deniedHtml).toContain("permission de consulter les réservations");
    expect(deniedHtml).not.toContain("Ville de départ"); // champ du formulaire de filtre, rendu seulement si accès accordé

    // Octroi de reservations.view au groupe (PATCH remplace l'ensemble des permissions du groupe).
    const grantResponse = await apiFetch(`/api/permission-groups/${group.id}`, {
      method: "PATCH",
      headers: { Cookie: tenant.sessionCookie },
      body: JSON.stringify({ permissions: ["clients.view", "reservations.view"] }),
    });
    expect(grantResponse.status).toBe(200);
    expect((await grantResponse.json()).group.permissions).toContain("reservations.view");

    // Avec la permission : 200 sur l'API, et la page rend le contenu réel (formulaire de filtre).
    const grantedApiResponse = await apiFetch("/api/reservations", { headers: { Cookie: member.sessionCookie } });
    expect(grantedApiResponse.status).toBe(200);

    const grantedPageResponse = await apiFetch("/dashboard/reservations", {
      headers: { Cookie: member.sessionCookie },
    });
    expect(grantedPageResponse.status).toBe(200);
    const grantedHtml = await grantedPageResponse.text();
    expect(grantedHtml).toContain("Ville de départ");
    expect(grantedHtml).not.toContain("permission de consulter les réservations");
  });
});
