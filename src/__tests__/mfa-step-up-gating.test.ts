import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { BCRYPT_COST } from "@/lib/bcrypt-cost";
import { prisma } from "@/lib/prisma";
import { generateTotpToken } from "@/lib/mfa";
import { apiFetch, extractSessionCookie } from "./helpers/http";
import { registerTenantAdmin, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

/**
 * Phase 3C MFA (2026-08-29, brief explicite du propriétaire du projet) : tests d'intégration
 * HTTP réels du câblage `hasValidStepUp()` sur les 10 routes sensibles listées dans le brief.
 *
 * Portée volontairement choisie pour rester proportionnée sans sacrifier la couverture réelle :
 * - Pour CHACUNE des 10 routes : absence de step-up refusée (403, message générique), aucune
 *   mutation effectuée en cas de refus, step-up valide accepté (comportement normal de la route).
 *   C'est le câblage propre à chaque route qui est testé ici (le bon appel, au bon endroit, avant
 *   toute mutation) — pas la primitive `hasValidStepUp()` elle-même (fraîcheur exacte, liaison à
 *   la session, invalidation par purge), déjà exhaustivement testée au niveau unitaire dans
 *   src/__tests__/mfa-routes.test.ts (describe "MFA — step-up").
 * - La preuve expirée et la preuve d'une autre session sont revérifiées de bout en bout (pas
 *   seulement au niveau de la primitive) sur deux routes représentatives de gravité différente
 *   (data-reset, le pire cas ; users/[id] changement de rôle, élévation de privilège) — même
 *   code de gate (`stepUpRequiredAndMissing`, src/lib/mfa-session.ts) partagé par les 10 routes,
 *   revalider ce chemin sur les 8 autres n'apporterait aucune garantie supplémentaire.
 * - Le comportement inchangé pour un compte sans MFA (opt-in) est revérifié sur trois routes de
 *   nature différente (data-reset, users/[id] rôle, cash-register PATCH) pour la même raison.
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const password = "Correct-Horse-Battery-Staple9!";
const createdTenantIds: string[] = [];

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
  await prisma.$disconnect();
});

let counter = 0;
async function newAdmin(label: string, emailDomain = "test.local"): Promise<AuthenticatedTestUser> {
  counter += 1;
  const email = `sug-${label}-${counter}-${runId}@${emailDomain}`;
  const admin = await registerTenantAdmin({
    tenantName: `SUG ${label} ${counter} ${runId}`,
    tenantSlug: `sug-${label}-${counter}-${runId}`,
    name: `SUG ${label} Admin`,
    email,
    password,
  });
  createdTenantIds.push(admin.tenantId);
  return admin;
}

async function enableMfa(admin: AuthenticatedTestUser): Promise<string> {
  const { secretBase32 } = await enableMfaWithRecovery(admin);
  return secretBase32;
}

/** Variante de enableMfa() capturant aussi les codes de récupération en clair (retournés une
 * seule fois à la confirmation) — nécessaire pour les scénarios "mauvaise session" ci-dessous,
 * qui utilisent un code de récupération pour la seconde connexion plutôt qu'un second code TOTP
 * consommé quelques millisecondes après le premier (fenêtre de tolérance serveur ±30s trop
 * courte pour garantir deux codes TOTP distincts fiables aussi rapprochés dans le temps réel). */
async function enableMfaWithRecovery(
  admin: AuthenticatedTestUser
): Promise<{ secretBase32: string; recoveryCodes: string[] }> {
  const enrollResponse = await apiFetch("/api/mfa/enroll", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({}),
  });
  const { secretBase32 } = await enrollResponse.json();
  const code = await generateTotpToken(secretBase32);
  const confirmResponse = await apiFetch("/api/mfa/enroll/confirm", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ code }),
  });
  expect(confirmResponse.status).toBe(200);
  const body = await confirmResponse.json();
  return { secretBase32, recoveryCodes: body.recoveryCodes };
}

const TOTP_PERIOD_SECONDS = 30;

/**
 * Génère un code TOTP garanti valide au moment où le serveur le vérifiera (tolérance ±30s
 * autour de son propre "maintenant", jamais de l'horodatage passé par le client — voir
 * src/lib/mfa.ts) et garanti sur un pas de temps strictement postérieur au dernier consommé
 * (anti-rejeu, User.mfaLastUsedStep) : une marge fixe (« +31s ») s'est révélée fragile en
 * pratique (la fenêtre entre la génération du code côté test et sa vérification côté serveur
 * peut être inférieure à la seconde, ce qui place alors la cible juste hors tolérance) — ce
 * calcul lit le pas réellement consommé en base et vise le tout début du prochain pas valide,
 * jamais un décalage arbitraire.
 */
async function nextTotpCode(userId: string, secretBase32: string): Promise<string> {
  const current = await prisma.user.findUnique({ where: { id: userId }, select: { mfaLastUsedStep: true } });
  const now = Math.floor(Date.now() / 1000);
  const nowStep = Math.floor(now / TOTP_PERIOD_SECONDS);
  const lastUsedStep = current?.mfaLastUsedStep ?? null;
  const targetStep = lastUsedStep !== null ? Math.max(nowStep, lastUsedStep + 1) : nowStep;
  return generateTotpToken(secretBase32, targetStep * TOTP_PERIOD_SECONDS + 1);
}

/** Établit une preuve de step-up fraîche pour la session courante de cet admin. */
async function stepUp(admin: AuthenticatedTestUser, secretBase32: string): Promise<void> {
  const code = await nextTotpCode(admin.userId, secretBase32);
  const response = await apiFetch("/api/mfa/step-up/verify", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ code }),
  });
  expect(response.status).toBe(200);
}

const STEP_UP_STATUS = 403;

/** Crée agence + véhicule + client — chaîne partagée par invoices/cash-register/damage-invoices. */
async function createAgencyVehicleClient(
  admin: AuthenticatedTestUser
): Promise<{ agencyId: string; vehicleId: string; clientId: string }> {
  const agencyResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ name: `Agence ${counter}`, slug: `agence-${counter}-${runId}` }),
  });
  const agencyId = (await agencyResponse.json()).agency.id as string;

  const vehicleResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      agencyId,
      name: "Clio",
      licensePlate: `SUG-${counter}-${runId}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay: 5000,
      chassisNumber: `VF1SUG${counter}${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
    }),
  });
  const vehicleId = (await vehicleResponse.json()).vehicle.id as string;

  const clientResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      name: `Client ${counter}`,
      email: `client-${counter}-${runId}@test.local`,
      licenseExpiryDate: "2099-12-31",
      birthDate: "1990-01-01",
    }),
  });
  const clientId = (await clientResponse.json()).client.id as string;

  return { agencyId, vehicleId, clientId };
}

let locationDateOffset = 0;
async function createLocation(admin: AuthenticatedTestUser, vehicleId: string, clientId: string): Promise<string> {
  locationDateOffset += 10;
  const base = new Date(Date.UTC(2030, 0, 1));
  const start = new Date(base.getTime() + locationDateOffset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
  const response = await apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({ vehicleId, clientId, startDate: start.toISOString(), endDate: end.toISOString() }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).location.id as string;
}

describe("Step-up MFA — POST /api/data-reset", () => {
  it("refuse sans step-up (mutation non exécutée)", async () => {
    const admin = await newAdmin("data-reset-missing");
    await enableMfa(admin);

    const response = await apiFetch("/api/data-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ confirmTenantName: (await prisma.tenant.findUniqueOrThrow({ where: { id: admin.tenantId } })).name }),
    });
    expect(response.status).toBe(STEP_UP_STATUS);

    const logs = await prisma.auditLog.findMany({ where: { tenantId: admin.tenantId, action: "data.reset" } });
    expect(logs).toHaveLength(0);
  });

  it("accepte avec un step-up frais", async () => {
    const admin = await newAdmin("data-reset-valid");
    const secret = await enableMfa(admin);
    await stepUp(admin, secret);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: admin.tenantId } });
    const response = await apiFetch("/api/data-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ confirmTenantName: tenant.name }),
    });
    expect(response.status).toBe(200);
  });

  it("conserve le comportement actuel pour un compte sans MFA (opt-in)", async () => {
    const admin = await newAdmin("data-reset-no-mfa");
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: admin.tenantId } });
    const response = await apiFetch("/api/data-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ confirmTenantName: tenant.name }),
    });
    expect(response.status).toBe(200);
  });

  it("refuse une preuve expirée", async () => {
    const admin = await newAdmin("data-reset-expired");
    const secret = await enableMfa(admin);
    await stepUp(admin, secret);
    await prisma.mfaStepUpProof.updateMany({
      where: { userId: admin.userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: admin.tenantId } });
    const response = await apiFetch("/api/data-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ confirmTenantName: tenant.name }),
    });
    expect(response.status).toBe(STEP_UP_STATUS);
  });

  it("refuse une preuve liée à une autre session (même utilisateur, second login)", async () => {
    const admin = await newAdmin("data-reset-wrong-session");
    const { secretBase32: secret, recoveryCodes } = await enableMfaWithRecovery(admin);

    // Seconde connexion du même utilisateur : sessionId différent (voir src/lib/auth.ts). Via un
    // code de récupération (pas un second TOTP) — deux codes TOTP consommés à quelques
    // millisecondes d'écart réel ne peuvent pas être garantis tous deux dans la fenêtre de
    // tolérance serveur ±30s, alors qu'un code de récupération n'a aucune contrainte de timing.
    const secondLogin = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password }),
    });
    expect((await secondLogin.json()).requiresMfa).toBe(true);
    const secondVerify = await apiFetch("/api/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password, code: recoveryCodes[0] }),
    });
    const secondCookie = extractSessionCookie(secondVerify);
    if (!secondCookie) throw new Error("Échec de la seconde connexion de test.");

    // Step-up posé sur la SECONDE session uniquement (premier et unique code TOTP consommé
    // depuis l'enrôlement — même schéma fiable que les tests "step-up frais" ci-dessus).
    const stepUpResponse = await apiFetch("/api/mfa/step-up/verify", {
      method: "POST",
      headers: { Cookie: secondCookie },
      body: JSON.stringify({ code: await nextTotpCode(admin.userId, secret) }),
    });
    expect(stepUpResponse.status).toBe(200);

    // La PREMIÈRE session (celle utilisée pour data-reset) n'a aucune preuve valide.
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: admin.tenantId } });
    const response = await apiFetch("/api/data-reset", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ confirmTenantName: tenant.name }),
    });
    expect(response.status).toBe(STEP_UP_STATUS);
  });
});

describe("Step-up MFA — POST /api/audit/purge", () => {
  it("refuse sans step-up (aucune entrée supprimée)", async () => {
    const admin = await newAdmin("audit-purge-missing");
    await enableMfa(admin);
    await prisma.auditLog.create({
      data: { tenantId: admin.tenantId, userId: admin.userId, action: "test.marker", resource: "Test" },
    });

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: admin.tenantId } });
    const response = await apiFetch("/api/audit/purge", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ confirmTenantName: tenant.name }),
    });
    expect(response.status).toBe(STEP_UP_STATUS);

    const count = await prisma.auditLog.count({ where: { tenantId: admin.tenantId } });
    expect(count).toBeGreaterThan(0);
  });

  it("accepte avec un step-up frais", async () => {
    const admin = await newAdmin("audit-purge-valid");
    const secret = await enableMfa(admin);
    await prisma.auditLog.create({
      data: { tenantId: admin.tenantId, userId: admin.userId, action: "test.marker", resource: "Test" },
    });
    await stepUp(admin, secret);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: admin.tenantId } });
    const response = await apiFetch("/api/audit/purge", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ confirmTenantName: tenant.name }),
    });
    expect(response.status).toBe(200);
  });
});

describe("Step-up MFA — POST /api/audit/bulk-delete", () => {
  it("refuse sans step-up (aucune entrée supprimée)", async () => {
    const admin = await newAdmin("audit-bulk-missing");
    await enableMfa(admin);
    const log = await prisma.auditLog.create({
      data: { tenantId: admin.tenantId, userId: admin.userId, action: "test.marker", resource: "Test" },
    });

    const response = await apiFetch("/api/audit/bulk-delete", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ ids: [log.id] }),
    });
    expect(response.status).toBe(STEP_UP_STATUS);

    const stillThere = await prisma.auditLog.findUnique({ where: { id: log.id } });
    expect(stillThere).not.toBeNull();
  });

  it("accepte avec un step-up frais", async () => {
    const admin = await newAdmin("audit-bulk-valid");
    const secret = await enableMfa(admin);
    const log = await prisma.auditLog.create({
      data: { tenantId: admin.tenantId, userId: admin.userId, action: "test.marker", resource: "Test" },
    });
    await stepUp(admin, secret);

    const response = await apiFetch("/api/audit/bulk-delete", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ ids: [log.id] }),
    });
    expect(response.status).toBe(200);
  });
});

describe("Step-up MFA — DELETE /api/audit/[id]", () => {
  it("refuse sans step-up (entrée non supprimée)", async () => {
    const admin = await newAdmin("audit-id-missing");
    await enableMfa(admin);
    const log = await prisma.auditLog.create({
      data: { tenantId: admin.tenantId, userId: admin.userId, action: "test.marker", resource: "Test" },
    });

    const response = await apiFetch(`/api/audit/${log.id}`, {
      method: "DELETE",
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(STEP_UP_STATUS);

    const stillThere = await prisma.auditLog.findUnique({ where: { id: log.id } });
    expect(stillThere).not.toBeNull();
  });

  it("accepte avec un step-up frais", async () => {
    const admin = await newAdmin("audit-id-valid");
    const secret = await enableMfa(admin);
    const log = await prisma.auditLog.create({
      data: { tenantId: admin.tenantId, userId: admin.userId, action: "test.marker", resource: "Test" },
    });
    await stepUp(admin, secret);

    const response = await apiFetch(`/api/audit/${log.id}`, {
      method: "DELETE",
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(200);
  });
});

describe("Step-up MFA — PATCH /api/users/[id] (changement de rôle)", () => {
  async function createMember(admin: AuthenticatedTestUser): Promise<string> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const member = await prisma.user.create({
      data: { tenantId: admin.tenantId, email: `member-${counter}-${runId}@test.local`, name: "Member", passwordHash, role: "MEMBER" },
    });
    return member.id;
  }

  it("refuse sans step-up (rôle inchangé)", async () => {
    const admin = await newAdmin("users-role-missing");
    await enableMfa(admin);
    const memberId = await createMember(admin);

    const response = await apiFetch(`/api/users/${memberId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ role: "ADMIN" }),
    });
    expect(response.status).toBe(STEP_UP_STATUS);

    const target = await prisma.user.findUnique({ where: { id: memberId } });
    expect(target?.role).toBe("MEMBER");
  });

  it("aucune mutation partielle : un mot de passe bundlé dans la même requête n'est pas non plus appliqué", async () => {
    const admin = await newAdmin("users-role-bundle");
    await enableMfa(admin);
    const memberId = await createMember(admin);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: memberId } });

    const response = await apiFetch(`/api/users/${memberId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ role: "ADMIN", password: "Another-Strong-Pass9!" }),
    });
    expect(response.status).toBe(STEP_UP_STATUS);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: memberId } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.role).toBe("MEMBER");
  });

  it("accepte avec un step-up frais", async () => {
    const admin = await newAdmin("users-role-valid");
    const secret = await enableMfa(admin);
    const memberId = await createMember(admin);
    await stepUp(admin, secret);

    const response = await apiFetch(`/api/users/${memberId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ role: "ADMIN" }),
    });
    expect(response.status).toBe(200);

    const target = await prisma.user.findUnique({ where: { id: memberId } });
    expect(target?.role).toBe("ADMIN");
  });

  it("conserve le comportement actuel pour un compte sans MFA (opt-in)", async () => {
    const admin = await newAdmin("users-role-no-mfa");
    const memberId = await createMember(admin);

    const response = await apiFetch(`/api/users/${memberId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ role: "ADMIN" }),
    });
    expect(response.status).toBe(200);
  });

  it("un changement de mot de passe seul (sans changement de rôle) n'exige jamais de step-up", async () => {
    const admin = await newAdmin("users-password-only");
    await enableMfa(admin);
    const memberId = await createMember(admin);

    const response = await apiFetch(`/api/users/${memberId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ password: "Another-Strong-Pass9!" }),
    });
    expect(response.status).toBe(200);
  });

  it("refuse une preuve expirée", async () => {
    const admin = await newAdmin("users-role-expired");
    const secret = await enableMfa(admin);
    const memberId = await createMember(admin);
    await stepUp(admin, secret);
    await prisma.mfaStepUpProof.updateMany({
      where: { userId: admin.userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await apiFetch(`/api/users/${memberId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ role: "ADMIN" }),
    });
    expect(response.status).toBe(STEP_UP_STATUS);
  });

  it("refuse une preuve liée à une autre session", async () => {
    const admin = await newAdmin("users-role-wrong-session");
    const { secretBase32: secret, recoveryCodes } = await enableMfaWithRecovery(admin);
    const memberId = await createMember(admin);

    // Second login via un code de récupération, pas un second TOTP — voir le commentaire
    // équivalent dans le test "wrong session" de data-reset ci-dessus.
    const secondLogin = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password }),
    });
    expect((await secondLogin.json()).requiresMfa).toBe(true);
    const secondVerify = await apiFetch("/api/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password, code: recoveryCodes[0] }),
    });
    const secondCookie = extractSessionCookie(secondVerify);
    if (!secondCookie) throw new Error("Échec de la seconde connexion de test.");
    const stepUpResponse = await apiFetch("/api/mfa/step-up/verify", {
      method: "POST",
      headers: { Cookie: secondCookie },
      body: JSON.stringify({ code: await nextTotpCode(admin.userId, secret) }),
    });
    expect(stepUpResponse.status).toBe(200);

    const response = await apiFetch(`/api/users/${memberId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ role: "ADMIN" }),
    });
    expect(response.status).toBe(STEP_UP_STATUS);
  });
});

describe("Step-up MFA — PATCH /api/users/[id]/permissions", () => {
  async function createMember(admin: AuthenticatedTestUser): Promise<string> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const member = await prisma.user.create({
      data: { tenantId: admin.tenantId, email: `member-perm-${counter}-${runId}@test.local`, name: "Member", passwordHash, role: "MEMBER" },
    });
    return member.id;
  }

  it("refuse sans step-up (permissions inchangées)", async () => {
    const admin = await newAdmin("users-perm-missing");
    await enableMfa(admin);
    const memberId = await createMember(admin);

    const response = await apiFetch(`/api/users/${memberId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ individualPermissions: ["vehicles.view"] }),
    });
    expect(response.status).toBe(STEP_UP_STATUS);

    const perms = await prisma.userPermission.count({ where: { userId: memberId } });
    expect(perms).toBe(0);
  });

  it("accepte avec un step-up frais", async () => {
    const admin = await newAdmin("users-perm-valid");
    const secret = await enableMfa(admin);
    const memberId = await createMember(admin);
    await stepUp(admin, secret);

    const response = await apiFetch(`/api/users/${memberId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ individualPermissions: ["vehicles.view"] }),
    });
    expect(response.status).toBe(200);
  });
});

describe("Step-up MFA — POST /api/tenants (Super Admin)", () => {
  it("refuse sans step-up (aucun tenant créé)", async () => {
    const admin = await newAdmin("tenants-missing", "superadmin.test.local");
    await enableMfa(admin);
    const attemptedSlug = `sug-attempt-${counter}-${runId}`;

    const response = await apiFetch("/api/tenants", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({
        tenantName: "Attempted Tenant",
        tenantSlug: attemptedSlug,
        name: "New Admin",
        email: `new-admin-${counter}-${runId}@test.local`,
        password,
      }),
    });
    expect(response.status).toBe(STEP_UP_STATUS);

    const created = await prisma.tenant.findUnique({ where: { slug: attemptedSlug } });
    expect(created).toBeNull();
  });

  it("accepte avec un step-up frais", async () => {
    const admin = await newAdmin("tenants-valid", "superadmin.test.local");
    const secret = await enableMfa(admin);
    await stepUp(admin, secret);
    const slug = `sug-created-${counter}-${runId}`;

    const response = await apiFetch("/api/tenants", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({
        tenantName: "Created Tenant",
        tenantSlug: slug,
        name: "New Admin",
        email: `new-admin-created-${counter}-${runId}@test.local`,
        password,
      }),
    });
    expect(response.status).toBe(201);
    const created = await prisma.tenant.findUniqueOrThrow({ where: { slug } });
    createdTenantIds.push(created.id);
  });
});

describe("Step-up MFA — DELETE /api/invoices/[id]", () => {
  it("refuse sans step-up (facture non supprimée)", async () => {
    const admin = await newAdmin("invoices-missing");
    await enableMfa(admin);
    const { vehicleId, clientId } = await createAgencyVehicleClient(admin);
    const locationId = await createLocation(admin, vehicleId, clientId);
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { locationId } });

    const response = await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "DELETE",
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(STEP_UP_STATUS);

    const stillThere = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(stillThere).not.toBeNull();
  });

  it("accepte avec un step-up frais", async () => {
    const admin = await newAdmin("invoices-valid");
    const secret = await enableMfa(admin);
    const { vehicleId, clientId } = await createAgencyVehicleClient(admin);
    const locationId = await createLocation(admin, vehicleId, clientId);
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { locationId } });
    await stepUp(admin, secret);

    const response = await apiFetch(`/api/invoices/${invoice.id}`, {
      method: "DELETE",
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(200);
  });
});

describe("Step-up MFA — PATCH/DELETE /api/cash-register/[id]", () => {
  async function createManualEntry(admin: AuthenticatedTestUser): Promise<string> {
    const response = await apiFetch("/api/cash-register", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ type: "ENTRY", amount: 1000, description: "Test SUG" }),
    });
    expect(response.status).toBe(201);
    return (await response.json()).entry.id as string;
  }

  it("PATCH refuse sans step-up (écriture inchangée)", async () => {
    const admin = await newAdmin("cash-patch-missing");
    await enableMfa(admin);
    const entryId = await createManualEntry(admin);

    const response = await apiFetch(`/api/cash-register/${entryId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ description: "Modifié" }),
    });
    expect(response.status).toBe(STEP_UP_STATUS);

    const entry = await prisma.cashEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(entry.description).toBe("Test SUG");
  });

  it("PATCH accepte avec un step-up frais", async () => {
    const admin = await newAdmin("cash-patch-valid");
    const secret = await enableMfa(admin);
    const entryId = await createManualEntry(admin);
    await stepUp(admin, secret);

    const response = await apiFetch(`/api/cash-register/${entryId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ description: "Modifié" }),
    });
    expect(response.status).toBe(200);
  });

  it("PATCH conserve le comportement actuel pour un compte sans MFA (opt-in)", async () => {
    const admin = await newAdmin("cash-patch-no-mfa");
    const entryId = await createManualEntry(admin);

    const response = await apiFetch(`/api/cash-register/${entryId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ description: "Modifié" }),
    });
    expect(response.status).toBe(200);
  });

  it("DELETE refuse sans step-up (écriture non supprimée)", async () => {
    const admin = await newAdmin("cash-delete-missing");
    await enableMfa(admin);
    const entryId = await createManualEntry(admin);

    const response = await apiFetch(`/api/cash-register/${entryId}`, {
      method: "DELETE",
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(STEP_UP_STATUS);

    const stillThere = await prisma.cashEntry.findUnique({ where: { id: entryId } });
    expect(stillThere).not.toBeNull();
  });

  it("DELETE accepte avec un step-up frais", async () => {
    const admin = await newAdmin("cash-delete-valid");
    const secret = await enableMfa(admin);
    const entryId = await createManualEntry(admin);
    await stepUp(admin, secret);

    const response = await apiFetch(`/api/cash-register/${entryId}`, {
      method: "DELETE",
      headers: { Cookie: admin.sessionCookie },
    });
    expect(response.status).toBe(200);
  });
});

describe("Step-up MFA — POST /api/damage-invoices/[id]/cancel", () => {
  async function createDamageInvoice(admin: AuthenticatedTestUser): Promise<string> {
    const { vehicleId, clientId } = await createAgencyVehicleClient(admin);
    const locationId = await createLocation(admin, vehicleId, clientId);
    const response = await apiFetch("/api/damages", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ locationId, nature: "Rayure test SUG", billableAmount: 1000 }),
    });
    expect(response.status).toBe(201);
    return (await response.json()).damageInvoice.id as string;
  }

  it("refuse sans step-up (facture non annulée)", async () => {
    const admin = await newAdmin("damage-cancel-missing");
    await enableMfa(admin);
    const damageInvoiceId = await createDamageInvoice(admin);

    const response = await apiFetch(`/api/damage-invoices/${damageInvoiceId}/cancel`, {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ reason: "Test annulation refusée" }),
    });
    expect(response.status).toBe(STEP_UP_STATUS);

    const invoice = await prisma.damageInvoice.findUniqueOrThrow({ where: { id: damageInvoiceId } });
    expect(invoice.status).not.toBe("CANCELLED");
  });

  it("accepte avec un step-up frais", async () => {
    const admin = await newAdmin("damage-cancel-valid");
    const secret = await enableMfa(admin);
    const damageInvoiceId = await createDamageInvoice(admin);
    await stepUp(admin, secret);

    const response = await apiFetch(`/api/damage-invoices/${damageInvoiceId}/cancel`, {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ reason: "Test annulation acceptée" }),
    });
    expect(response.status).toBe(200);
  });
});
