import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createTenantAdmin, deleteTestTenants } from "./helpers/fixtures";
import { EnvironmentGuardError, parseEnvFlag } from "../../scripts/env-guard.js";
import {
  ALLOWED_TEST_EMAIL_DOMAINS,
  FORBIDDEN_REAL_SUPER_ADMIN_EMAIL,
  assertNoPasswordArgFlags,
  assertTestEnvOnly,
  emailConfirmationMatches,
  isAllowedEmailDomain,
  isForbiddenEmail,
  normalizeEmail,
  performPasswordReset,
  resolveTargetUser,
} from "../../scripts/reset-test-user-password.js";

/**
 * Revue de sécurité, 2026-09-17 (brief explicite du propriétaire du projet) — couverture dédiée
 * de `scripts/reset-test-user-password.js`, absente jusqu'ici (écart relevé par la même revue,
 * contrairement à `scripts/delete-test-tenant.mjs`/`scripts/env-guard.js` déjà couverts). Même
 * patron : le script exporte sa logique de validation/résolution/écriture en fonctions
 * pures/injectées (aucune n'exécute `process.exit`, ne lit `process.argv`/`process.stdin`, ni
 * n'instancie son propre `PrismaClient`) — importer ce module ici n'exécute jamais le script ni
 * ne se connecte deux fois à la base. Le flux interactif réel (saisie TTY masquée du mot de
 * passe, ressaisie visible de l'email de confirmation) reste hors de portée d'un test
 * automatisé et n'est validé que manuellement (voir SECURITY.md).
 */
describe("scripts/reset-test-user-password.js", () => {
  describe("assertNoPasswordArgFlags — --password/--new-password jamais acceptés", () => {
    it("refuse --password", () => {
      expect(() => assertNoPasswordArgFlags({ password: "x" })).toThrow(/jamais acceptés/);
    });

    it("refuse --new-password", () => {
      expect(() => assertNoPasswordArgFlags({ "new-password": "x" })).toThrow(/jamais acceptés/);
    });

    it("accepte tout autre ensemble de flags", () => {
      expect(() => assertNoPasswordArgFlags({ env: "test", "user-email": "x@test-xrent.local", yes: "" })).not.toThrow();
    });
  });

  describe("--env — réservé strictement à xrent_test", () => {
    it("refuse l'absence totale de --env (réutilise parseEnvFlag d'env-guard, même garde que le reste du dépôt)", () => {
      expect(() => parseEnvFlag([], "usage")).toThrow(EnvironmentGuardError);
    });

    it("refuse une valeur hors dev/test (ex. --env=prod)", () => {
      expect(() => parseEnvFlag(["--env=prod"], "usage")).toThrow(EnvironmentGuardError);
    });

    it("refuse --env=dev spécifiquement, alors qu'env-guard l'accepterait pour d'autres scripts du dépôt", () => {
      // Comparaison par nom/message plutôt que `instanceof EnvironmentGuardError` : le require()
      // interne de reset-test-user-password.js vers ./env-guard et l'import direct de ce fichier
      // de test vers env-guard.js peuvent aboutir à deux évaluations distinctes du module CJS
      // sous le runner Vitest (artefact de l'environnement de test, jamais le cas à l'exécution
      // réelle du script via Node) — instanceof y est donc peu fiable, le nom/message ne l'est pas.
      expect(() => assertTestEnvOnly("dev")).toThrowError(
        expect.objectContaining({ name: "EnvironmentGuardError", message: expect.stringContaining("xrent_test") })
      );
    });

    it("accepte --env=test sans lever", () => {
      expect(() => assertTestEnvOnly("test")).not.toThrow();
    });
  });

  describe("isAllowedEmailDomain / isForbiddenEmail / normalizeEmail", () => {
    it("normalise par trim + minuscules", () => {
      expect(normalizeEmail("  Admin@Test-Xrent.LOCAL  ")).toBe("admin@test-xrent.local");
    });

    it.each(ALLOWED_TEST_EMAIL_DOMAINS)("accepte le domaine autorisé %s", (domain) => {
      expect(isAllowedEmailDomain(`quelqu-un${domain}`)).toBe(true);
    });

    it("refuse un domaine hors allowlist", () => {
      expect(isAllowedEmailDomain("admin@exemple-quelconque.com")).toBe(false);
    });

    it("refuse le compte réel de la plateforme, inconditionnellement", () => {
      expect(isForbiddenEmail(FORBIDDEN_REAL_SUPER_ADMIN_EMAIL)).toBe(true);
    });

    it("n'interdit pas un compte de test ordinaire", () => {
      expect(isForbiddenEmail("admin@test-xrent.local")).toBe(false);
    });
  });

  describe("emailConfirmationMatches — confirmation exacte de la cible avant écriture", () => {
    it("accepte une ressaisie identique", () => {
      expect(emailConfirmationMatches("admin@test-xrent.local", "admin@test-xrent.local")).toBe(true);
    });

    it("tolère espaces/majuscules sur la ressaisie uniquement", () => {
      expect(emailConfirmationMatches("  Admin@Test-Xrent.LOCAL  ", "admin@test-xrent.local")).toBe(true);
    });

    it("refuse une ressaisie différente (confirmation d'adresse incorrecte)", () => {
      expect(emailConfirmationMatches("autre@test-xrent.local", "admin@test-xrent.local")).toBe(false);
    });

    it("refuse une ressaisie vide", () => {
      expect(emailConfirmationMatches("", "admin@test-xrent.local")).toBe(false);
    });
  });

  describe("resolveTargetUser / performPasswordReset — contre xrent_test réel, données synthétiques jetables", () => {
    it("compte introuvable géré proprement (retourne null, ne lève pas)", async () => {
      const result = await resolveTargetUser(prisma, `introuvable-${Date.now()}@test-xrent.local`);
      expect(result).toBeNull();
    });

    it("dry-run (résolution seule) ne modifie jamais la cible", async () => {
      const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
      const admin = await createTenantAdmin({
        tenantName: `ResetPwTool DryRun ${runId}`,
        tenantSlug: `resetpw-dryrun-${runId}`,
        name: "Admin",
        email: `admin-resetpw-dryrun-${runId}@test-xrent.local`,
        password: "Correct-Horse-Battery-Staple9!",
      });

      const before = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
      const resolved = await resolveTargetUser(prisma, normalizeEmail(before.email));
      expect(resolved?.id).toBe(admin.userId);

      const after = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(after.sessionRevokedAt).toBe(before.sessionRevokedAt);

      await deleteTestTenants([admin.tenantId]);
    });

    it("écriture réelle : passwordHash modifié, sessionRevokedAt défini, AuditLog user.password_reset avec viaOutOfBandScript=true", async () => {
      const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
      const admin = await createTenantAdmin({
        tenantName: `ResetPwTool Write ${runId}`,
        tenantSlug: `resetpw-write-${runId}`,
        name: "Admin",
        email: `admin-resetpw-write-${runId}@test-xrent.local`,
        password: "Correct-Horse-Battery-Staple9!", // constante déjà publique du dépôt
      });

      const before = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
      const target = await resolveTargetUser(prisma, normalizeEmail(before.email));
      expect(target).not.toBeNull();

      // Même constante déjà publique que le reste de la suite — jamais un secret réel. Le hash
      // est calculé directement ici, comme le ferait main() après validatePassword()/bcrypt.hash().
      const newPasswordHash = await bcrypt.hash("New-Correct-Horse-9!", 4);

      const beforeAuditCount = await prisma.auditLog.count({
        where: { tenantId: admin.tenantId, action: "user.password_reset" },
      });

      const result = await performPasswordReset(prisma, target!, newPasswordHash);
      expect(result.sessionRevokedAt).toBeInstanceOf(Date);

      const after = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
      expect(after.passwordHash).toBe(newPasswordHash);
      expect(after.passwordHash).not.toBe(before.passwordHash);
      expect(after.sessionRevokedAt).not.toBeNull();
      expect(after.sessionRevokedAt!.getTime()).toBe(result.sessionRevokedAt.getTime());

      const auditEntries = await prisma.auditLog.findMany({
        where: { tenantId: admin.tenantId, action: "user.password_reset" },
      });
      expect(auditEntries).toHaveLength(beforeAuditCount + 1);
      const entry = auditEntries[auditEntries.length - 1];
      expect(entry.userId).toBeNull();
      expect(entry.resourceId).toBe(admin.userId);
      expect((entry.metadata as { viaOutOfBandScript?: boolean } | null)?.viaOutOfBandScript).toBe(true);

      await deleteTestTenants([admin.tenantId]);
    });
  });
});
