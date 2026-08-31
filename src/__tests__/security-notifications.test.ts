import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateTotpToken } from "@/lib/mfa";
import { apiFetch, extractSessionCookie } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";

/**
 * Politique MFA (2026-08-30, brief explicite du propriétaire du projet) : notifications de
 * sécurité in-app (src/lib/security-notifications.ts, prisma/schema.prisma modèle
 * SecurityNotification) — créées après un changement d'e-mail/mot de passe/MFA/rôle-permissions
 * réellement réussi, jamais après un simple échec. Distinctes d'AuditLog (preuve administrative)
 * : seul l'utilisateur destinataire peut lire ses propres notifications, contrôlé côté serveur.
 */

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const password = "Correct-Horse-Battery-Staple9!";
const createdTenantIds: string[] = [];
let counter = 0;

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
  await prisma.$disconnect();
});

async function newAdmin(label: string): Promise<AuthenticatedTestUser> {
  counter += 1;
  const admin = await registerTenantAdmin({
    tenantName: `SN ${label} ${counter} ${runId}`,
    tenantSlug: `sn-${label}-${counter}-${runId}`,
    name: `SN ${label} Admin`,
    email: `sn-${label}-${counter}-${runId}@test.local`,
    password,
  });
  createdTenantIds.push(admin.tenantId);
  return admin;
}

async function newMember(tenantId: string, label: string): Promise<AuthenticatedTestUser> {
  counter += 1;
  return createAndLoginMember({
    tenantId,
    name: `SN ${label} Member`,
    email: `sn-member-${label}-${counter}-${runId}@test.local`,
    password,
  });
}

async function listNotifications(user: AuthenticatedTestUser) {
  const response = await apiFetch("/api/security-notifications", { headers: { Cookie: user.sessionCookie } });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    notifications: { id: string; type: string; message: string; readAt: string | null }[];
    unreadCount: number;
  }>;
}

async function enableMfa(user: AuthenticatedTestUser): Promise<string> {
  const enrollResponse = await apiFetch("/api/mfa/enroll", {
    method: "POST",
    headers: { Cookie: user.sessionCookie },
    body: JSON.stringify({}),
  });
  const { secretBase32 } = await enrollResponse.json();
  const code = await generateTotpToken(secretBase32);
  const confirmResponse = await apiFetch("/api/mfa/enroll/confirm", {
    method: "POST",
    headers: { Cookie: user.sessionCookie },
    body: JSON.stringify({ code }),
  });
  expect(confirmResponse.status).toBe(200);
  return secretBase32;
}

const TOTP_PERIOD_SECONDS = 30;

/** Même garantie que mfa-lifecycle.test.ts/mfa-step-up-gating.test.ts : code TOTP garanti sur un
 * pas de temps strictement postérieur au dernier consommé (anti-rejeu). */
async function nextTotpCode(userId: string, secretBase32: string): Promise<string> {
  const current = await prisma.user.findUnique({ where: { id: userId }, select: { mfaLastUsedStep: true } });
  const now = Math.floor(Date.now() / 1000);
  const nowStep = Math.floor(now / TOTP_PERIOD_SECONDS);
  const lastUsedStep = current?.mfaLastUsedStep ?? null;
  const targetStep = lastUsedStep !== null ? Math.max(nowStep, lastUsedStep + 1) : nowStep;
  return generateTotpToken(secretBase32, targetStep * TOTP_PERIOD_SECONDS + 1);
}

/** Connexion complète pour un compte MFA activée — POST /api/auth/login puis
 * POST /api/auth/mfa/verify, même flux que src/__tests__/mfa-routes.test.ts. */
async function loginWithMfa(email: string, loginPassword: string, secretBase32: string): Promise<string> {
  const loginResponse = await apiFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: loginPassword }),
  });
  expect((await loginResponse.json()).requiresMfa).toBe(true);

  const userForCode = await prisma.user.findFirstOrThrow({ where: { email } });
  const code = await nextTotpCode(userForCode.id, secretBase32);
  const verifyResponse = await apiFetch("/api/auth/mfa/verify", {
    method: "POST",
    body: JSON.stringify({ email, password: loginPassword, code }),
  });
  const cookie = extractSessionCookie(verifyResponse);
  expect(cookie).toBeDefined();
  return cookie!;
}

describe("PATCH /api/users/me — notifications de sécurité", () => {
  it("crée une notification EMAIL_CHANGED et révoque la session courante après un changement d'e-mail réussi", async () => {
    const admin = await newAdmin("email-changed");
    const newEmail = `sn-new-email-${counter}-${runId}@test.local`;

    const response = await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ email: newEmail }),
    });
    expect(response.status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect(user.email).toBe(newEmail);
    expect(user.sessionRevokedAt).not.toBeNull();

    // La session ayant servi au changement est elle-même révoquée (même comportement voulu que
    // la désactivation MFA) — toute requête suivante avec l'ancien cookie échoue.
    const staleSessionResponse = await apiFetch("/api/users/me", { headers: { Cookie: admin.sessionCookie } });
    expect(staleSessionResponse.status).toBe(401);

    // Reconnexion nécessaire pour consulter la notification créée.
    const reloginResponse = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: newEmail, password }),
    });
    const freshCookie = extractSessionCookie(reloginResponse);
    expect(freshCookie).toBeTruthy();

    const { notifications, unreadCount } = await listNotifications({ ...admin, sessionCookie: freshCookie! });
    expect(unreadCount).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("EMAIL_CHANGED");
    expect(notifications[0].readAt).toBeNull();
    // Contenu toujours générique — jamais de mot de passe, code, token ou secret.
    expect(notifications[0].message).not.toContain(password);
    expect(notifications[0].message).not.toContain(newEmail);
  });

  it("crée une notification PASSWORD_CHANGED après un changement de mot de passe réussi", async () => {
    const admin = await newAdmin("password-changed");
    const newPassword = "Another-Correct-Password9!";

    const response = await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ currentPassword: password, newPassword }),
    });
    expect(response.status).toBe(200);

    const reloginResponse = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password: newPassword }),
    });
    const freshCookie = extractSessionCookie(reloginResponse)!;

    const { notifications } = await listNotifications({ ...admin, sessionCookie: freshCookie });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("PASSWORD_CHANGED");
    expect(notifications[0].message).not.toContain(newPassword);
  });

  it("ne crée aucune notification quand le changement de mot de passe échoue (mot de passe actuel invalide)", async () => {
    const admin = await newAdmin("password-change-failed");

    const response = await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ currentPassword: "wrong-current-password", newPassword: "New-Correct-Password9!" }),
    });
    expect(response.status).toBe(400);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect(user.sessionRevokedAt).toBeNull();

    const { notifications } = await listNotifications(admin);
    expect(notifications).toHaveLength(0);
  });

  it("ne crée aucune notification pour un changement de nom seul (non concerné par la politique)", async () => {
    const admin = await newAdmin("name-only");

    const response = await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ name: "Nouveau Nom" }),
    });
    expect(response.status).toBe(200);

    const { notifications } = await listNotifications(admin);
    expect(notifications).toHaveLength(0);
  });
});

describe("PATCH /api/users/[id] — notifications de sécurité pour la cible (réinitialisation par un ADMIN)", () => {
  it("crée une notification PASSWORD_CHANGED pour la cible et révoque ses sessions", async () => {
    const admin = await newAdmin("reset-target-notif");
    const member = await newMember(admin.tenantId, "reset-target-notif");

    const response = await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ password: "New-Reset-Password9!" }),
    });
    expect(response.status).toBe(200);

    const target = await prisma.user.findUniqueOrThrow({ where: { id: member.userId } });
    expect(target.sessionRevokedAt).not.toBeNull();

    const staleSessionResponse = await apiFetch("/api/users/me", { headers: { Cookie: member.sessionCookie } });
    expect(staleSessionResponse.status).toBe(401);

    const { notifications } = await listNotifications(admin);
    expect(notifications).toHaveLength(0); // L'ADMIN acteur ne reçoit pas la notification de la cible.

    const reloginResponse = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: member.email, password: "New-Reset-Password9!" }),
    });
    const freshCookie = extractSessionCookie(reloginResponse)!;
    const targetNotifications = await listNotifications({ ...member, sessionCookie: freshCookie });
    expect(targetNotifications.notifications).toHaveLength(1);
    expect(targetNotifications.notifications[0].type).toBe("PASSWORD_CHANGED");
  });

  it("crée une notification ROLE_OR_PERMISSIONS_CHANGED pour la cible lors d'un changement de rôle", async () => {
    const admin = await newAdmin("role-change-notif");
    const member = await newMember(admin.tenantId, "role-change-notif");

    const response = await apiFetch(`/api/users/${member.userId}`, {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ role: "ADMIN" }),
    });
    expect(response.status).toBe(200);

    const { notifications } = await listNotifications(member);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("ROLE_OR_PERMISSIONS_CHANGED");
  });
});

describe("Notifications de sécurité MFA (enroll/disable/regenerate)", () => {
  it("crée MFA_ENABLED puis MFA_DISABLED aux étapes correspondantes", async () => {
    const admin = await newAdmin("mfa-enable-disable-notif");
    const secretBase32 = await enableMfa(admin);

    let list = await listNotifications(admin);
    expect(list.notifications.map((n) => n.type)).toEqual(["MFA_ENABLED"]);

    const code = await nextTotpCode(admin.userId, secretBase32);
    const disableResponse = await apiFetch("/api/mfa/disable", {
      method: "POST",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ password, code }),
    });
    expect(disableResponse.status).toBe(200);

    // Session courante révoquée par la désactivation — reconnexion nécessaire (MFA désormais
    // désactivée, mot de passe seul suffit).
    const reloginResponse = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password }),
    });
    const freshCookie = extractSessionCookie(reloginResponse)!;

    list = await listNotifications({ ...admin, sessionCookie: freshCookie });
    expect(list.notifications.map((n) => n.type).sort()).toEqual(["MFA_DISABLED", "MFA_ENABLED"].sort());
    for (const notification of list.notifications) {
      expect(notification.message).not.toMatch(/\d{6}/); // jamais de code TOTP dans le message
    }
  });
});

describe("Isolation — notifications de sécurité", () => {
  it("un utilisateur ne peut jamais lire les notifications d'un autre utilisateur, même du même tenant", async () => {
    const admin = await newAdmin("isolation-same-tenant");
    await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ currentPassword: password, newPassword: "Isolation-Password9!" }),
    });

    const member = await newMember(admin.tenantId, "isolation-same-tenant");
    const { notifications } = await listNotifications(member);
    expect(notifications).toHaveLength(0);
  });

  it("isolation tenant : un ADMIN d'un autre tenant ne voit jamais les notifications d'un tenant distinct", async () => {
    const adminA = await newAdmin("isolation-tenant-a");
    await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ currentPassword: password, newPassword: "Isolation-Tenant-A9!" }),
    });

    const adminB = await newAdmin("isolation-tenant-b");
    const { notifications } = await listNotifications(adminB);
    expect(notifications).toHaveLength(0);
  });

  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/security-notifications");
    expect(response.status).toBe(401);
  });
});

describe("Marquage lu — notifications de sécurité", () => {
  it("marque une notification individuelle comme lue, jamais celle d'un autre utilisateur", async () => {
    const admin = await newAdmin("mark-read-individual");
    await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ currentPassword: password, newPassword: "Mark-Read-Password9!" }),
    });

    const reloginResponse = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: admin.email, password: "Mark-Read-Password9!" }),
    });
    const freshCookie = extractSessionCookie(reloginResponse)!;
    const freshAdmin = { ...admin, sessionCookie: freshCookie };

    const before = await listNotifications(freshAdmin);
    expect(before.unreadCount).toBe(1);
    const notificationId = before.notifications[0].id;

    // Une autre session (autre membre du même tenant) ne peut pas marquer cette notification.
    const otherMember = await newMember(admin.tenantId, "mark-read-foreign");
    const foreignAttempt = await apiFetch(`/api/security-notifications/${notificationId}/read`, {
      method: "PATCH",
      headers: { Cookie: otherMember.sessionCookie },
    });
    expect(foreignAttempt.status).toBe(404);

    const stillUnread = await listNotifications(freshAdmin);
    expect(stillUnread.unreadCount).toBe(1);

    const markResponse = await apiFetch(`/api/security-notifications/${notificationId}/read`, {
      method: "PATCH",
      headers: { Cookie: freshAdmin.sessionCookie },
    });
    expect(markResponse.status).toBe(200);

    const after = await listNotifications(freshAdmin);
    expect(after.unreadCount).toBe(0);
    expect(after.notifications[0].readAt).not.toBeNull();
  });

  it("marque toutes les notifications non lues comme lues (read-all)", async () => {
    const admin = await newAdmin("mark-read-all");
    const secretBase32 = await enableMfa(admin); // MFA_ENABLED
    const newPassword = "Mark-Read-All-Password9!";
    await apiFetch("/api/users/me", {
      method: "PATCH",
      headers: { Cookie: admin.sessionCookie },
      body: JSON.stringify({ currentPassword: password, newPassword }),
    });

    // Session révoquée par le changement de mot de passe — reconnexion nécessaire, MFA toujours
    // activée sur ce compte (enableMfa ci-dessus), donc via le flux complet /api/auth/mfa/verify.
    const freshCookie = await loginWithMfa(admin.email, newPassword, secretBase32);
    const freshAdmin = { ...admin, sessionCookie: freshCookie };

    const before = await listNotifications(freshAdmin);
    expect(before.unreadCount).toBe(2);

    const readAllResponse = await apiFetch("/api/security-notifications/read-all", {
      method: "POST",
      headers: { Cookie: freshAdmin.sessionCookie },
    });
    expect(readAllResponse.status).toBe(200);
    const readAllBody = await readAllResponse.json();
    expect(readAllBody.markedCount).toBe(2);

    const after = await listNotifications(freshAdmin);
    expect(after.unreadCount).toBe(0);
    expect(after.notifications.every((n) => n.readAt !== null)).toBe(true);
  });

  it("refuse une requête non authentifiée sur le marquage lu", async () => {
    const response = await apiFetch("/api/security-notifications/some-id/read", { method: "PATCH" });
    expect(response.status).toBe(401);
  });
});
