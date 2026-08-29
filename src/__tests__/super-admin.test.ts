import { afterEach, describe, expect, it } from "vitest";
import { isSuperAdminEmail } from "@/lib/super-admin";

/**
 * Fonction pure (aucune dépendance next-auth/Prisma) — testable directement, même principe
 * que password-policy.test.ts, sans passer par le serveur next dev de test.
 */
describe("isSuperAdminEmail", () => {
  const originalValue = process.env.SUPER_ADMIN_EMAILS;

  afterEach(() => {
    process.env.SUPER_ADMIN_EMAILS = originalValue;
  });

  it("reconnaît une correspondance exacte", () => {
    process.env.SUPER_ADMIN_EMAILS = "saadscott123@gmail.com";
    expect(isSuperAdminEmail("saadscott123@gmail.com")).toBe(true);
  });

  it("normalise la casse et les espaces, sans jamais devenir un contournement plus permissif", () => {
    process.env.SUPER_ADMIN_EMAILS = "saadscott123@gmail.com";
    expect(isSuperAdminEmail("SaadScott123@Gmail.com")).toBe(true);
    expect(isSuperAdminEmail("  saadscott123@gmail.com  ")).toBe(true);
    // La normalisation ne doit jamais élargir la correspondance au-delà de trim+lowercase —
    // un email visuellement proche mais réellement différent reste refusé.
    expect(isSuperAdminEmail("saadscott123@gmail.co")).toBe(false);
    expect(isSuperAdminEmail("saadscott1234@gmail.com")).toBe(false);
  });

  it("refuse un email différent (ADMIN ordinaire non listé)", () => {
    process.env.SUPER_ADMIN_EMAILS = "saadscott123@gmail.com";
    expect(isSuperAdminEmail("admin-a-quelconque@test.local")).toBe(false);
  });

  it("refuse email null/undefined/vide", () => {
    process.env.SUPER_ADMIN_EMAILS = "saadscott123@gmail.com";
    expect(isSuperAdminEmail(null)).toBe(false);
    expect(isSuperAdminEmail(undefined)).toBe(false);
    expect(isSuperAdminEmail("")).toBe(false);
  });

  it("refuse tout le monde si la variable n'est pas configurée", () => {
    delete process.env.SUPER_ADMIN_EMAILS;
    expect(isSuperAdminEmail("saadscott123@gmail.com")).toBe(false);
  });

  it("supporte une allowlist par domaine (entrée préfixée par @) sans élargir une correspondance exacte à un domaine non listé", () => {
    process.env.SUPER_ADMIN_EMAILS = "@xrent-platform.internal";
    expect(isSuperAdminEmail("quiconque@xrent-platform.internal")).toBe(true);
    expect(isSuperAdminEmail("quiconque@autre-domaine.internal")).toBe(false);
  });

  it("supporte plusieurs entrées séparées par des virgules", () => {
    process.env.SUPER_ADMIN_EMAILS = "saadscott123@gmail.com, autre-admin@test.local";
    expect(isSuperAdminEmail("saadscott123@gmail.com")).toBe(true);
    expect(isSuperAdminEmail("autre-admin@test.local")).toBe(true);
    expect(isSuperAdminEmail("personne-dautre@test.local")).toBe(false);
  });
});
