import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { ipThrottleKey, emailThrottleKey } from "@/lib/login-throttle";
import { apiFetch, extractSessionCookie } from "./helpers/http";
import { registerTenantAdmin } from "./helpers/fixtures";

/**
 * Rate limiting d'authentification (SECURITY.md section 33). Chaque test fixe explicitement
 * son propre `x-forwarded-for` (voir helpers/http.ts — sinon chaque appel reçoit une IP
 * synthétique aléatoire distincte, pour ne jamais faire interférer les centaines d'autres
 * fichiers de test partageant le même serveur) afin de contrôler précisément la clé IP
 * accumulée par ses propres tentatives.
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const password = "Correct-Horse-Battery-Staple9!";
const createdTenantIds: string[] = [];
const usedThrottleKeys: string[] = [];

afterAll(async () => {
  await prisma.loginThrottle.deleteMany({ where: { key: { in: usedThrottleKeys } } });
  await prisma.user.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.permissionGroup.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.alert.deleteMany({ where: { tenantId: { in: createdTenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.$disconnect();
});

async function loginAttempt(email: string, ip: string, password_: string) {
  return apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
    body: JSON.stringify({ email, password: password_ }),
  });
}

describe("Rate limiting d'authentification", () => {
  it("plusieurs échecs pour le même email déclenchent un 429 après le seuil, quelle que soit l'IP utilisée à chaque tentative (résistance au changement d'identifiant)", async () => {
    const email = `throttle-by-email-${runId}@test.local`;
    const emailKey = emailThrottleKey(email);
    usedThrottleKeys.push(emailKey);

    for (let i = 0; i < 5; i++) {
      // IP différente à chaque tentative — seul l'email doit expliquer le verrouillage.
      const response = await loginAttempt(email, `172.16.${i}.${i}`, "wrong-password-x");
      expect(response.status).toBe(401);
    }

    const lockedResponse = await loginAttempt(email, "172.16.99.99", "wrong-password-x");
    expect(lockedResponse.status).toBe(429);

    const row = await prisma.loginThrottle.findUnique({ where: { key: emailKey } });
    expect(row?.failCount).toBeGreaterThanOrEqual(5);
    expect(row?.lockedUntil).not.toBeNull();
  });

  it("plusieurs échecs depuis la même IP déclenchent un 429 après le seuil, quel que soit l'email essayé à chaque tentative (résistance au changement d'identifiant)", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const ipKey = ipThrottleKey(ip);
    usedThrottleKeys.push(ipKey);

    for (let i = 0; i < 5; i++) {
      const response = await loginAttempt(`throttle-by-ip-${runId}-${i}@test.local`, ip, "wrong-password-x");
      expect(response.status).toBe(401);
    }

    const lockedResponse = await loginAttempt(`throttle-by-ip-${runId}-final@test.local`, ip, "wrong-password-x");
    expect(lockedResponse.status).toBe(429);

    const row = await prisma.loginThrottle.findUnique({ where: { key: ipKey } });
    expect(row?.failCount).toBeGreaterThanOrEqual(5);
    expect(row?.lockedUntil).not.toBeNull();
  });

  it("le message générique de verrouillage ne distingue jamais un compte existant d'un compte inexistant", async () => {
    const existingEmail = `throttle-existing-${runId}@test.local`;
    const nonExistentEmail = `throttle-nonexistent-${runId}@test.local`;
    const admin = await registerTenantAdmin({
      tenantName: "Throttle Message Tenant",
      tenantSlug: `throttle-message-${runId}`,
      name: "Throttle Admin",
      email: existingEmail,
      password,
    });
    createdTenantIds.push(admin.tenantId);
    usedThrottleKeys.push(emailThrottleKey(existingEmail), emailThrottleKey(nonExistentEmail));

    for (let i = 0; i < 5; i++) {
      await loginAttempt(existingEmail, `198.51.100.${i}`, "wrong-password-x");
      await loginAttempt(nonExistentEmail, `198.51.100.${100 + i}`, "wrong-password-x");
    }

    const lockedExisting = await loginAttempt(existingEmail, "198.51.100.201", "wrong-password-x");
    const lockedNonExistent = await loginAttempt(nonExistentEmail, "198.51.100.202", "wrong-password-x");

    expect(lockedExisting.status).toBe(429);
    expect(lockedNonExistent.status).toBe(429);
    expect((await lockedExisting.json()).error).toBe((await lockedNonExistent.json()).error);
  });

  it("une connexion réussie réinitialise entièrement le compteur d'échecs (email et IP)", async () => {
    const email = `throttle-reset-${runId}@test.local`;
    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    const admin = await registerTenantAdmin({
      tenantName: "Throttle Reset Tenant",
      tenantSlug: `throttle-reset-${runId}`,
      name: "Throttle Reset Admin",
      email,
      password,
    });
    createdTenantIds.push(admin.tenantId);
    usedThrottleKeys.push(emailThrottleKey(email), ipThrottleKey(ip));

    // 2 échecs, en-dessous du seuil de verrouillage (5).
    await loginAttempt(email, ip, "wrong-password-x");
    await loginAttempt(email, ip, "wrong-password-x");

    const beforeSuccess = await prisma.loginThrottle.findUnique({ where: { key: emailThrottleKey(email) } });
    expect(beforeSuccess?.failCount).toBe(2);

    const successResponse = await loginAttempt(email, ip, password);
    expect(successResponse.status).toBe(200);

    const afterSuccess = await prisma.loginThrottle.findUnique({ where: { key: emailThrottleKey(email) } });
    expect(afterSuccess?.failCount).toBe(0);
    expect(afterSuccess?.lockedUntil).toBeNull();

    const afterSuccessIp = await prisma.loginThrottle.findUnique({ where: { key: ipThrottleKey(ip) } });
    expect(afterSuccessIp?.failCount).toBe(0);
  });

  it("un utilisateur légitime peut se reconnecter une fois le blocage expiré", async () => {
    const email = `throttle-expiry-${runId}@test.local`;
    const ip = `192.0.2.${Math.floor(Math.random() * 55) + 200}`;
    const admin = await registerTenantAdmin({
      tenantName: "Throttle Expiry Tenant",
      tenantSlug: `throttle-expiry-${runId}`,
      name: "Throttle Expiry Admin",
      email,
      password,
    });
    createdTenantIds.push(admin.tenantId);
    const emailKey = emailThrottleKey(email);
    const ipKey = ipThrottleKey(ip);
    usedThrottleKeys.push(emailKey, ipKey);

    for (let i = 0; i < 5; i++) {
      await loginAttempt(email, ip, "wrong-password-x");
    }

    const lockedResponse = await loginAttempt(email, ip, password);
    expect(lockedResponse.status).toBe(429);

    // Simule l'expiration naturelle de la fenêtre de blocage — même principe que les tests
    // existants qui manipulent directement une date de planification pour tester un seuil
    // temporel (ex. src/__tests__/vehicle-status.test.ts), jamais un contournement applicatif.
    const past = new Date(Date.now() - 60_000);
    await prisma.loginThrottle.updateMany({
      where: { key: { in: [emailKey, ipKey] } },
      data: { lockedUntil: past },
    });

    const response = await loginAttempt(email, ip, password);
    expect(response.status).toBe(200);
    expect(extractSessionCookie(response)).toBeDefined();
  });
});
