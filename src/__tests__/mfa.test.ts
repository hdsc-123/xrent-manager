import crypto from "crypto";
import { generate as otplibGenerate, verify as otplibVerify } from "otplib";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOtpauthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  generateTotpToken,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyRecoveryCode,
  verifyTotpToken,
} from "@/lib/mfa";

/**
 * Phase 3A MFA — tests unitaires purs (aucune dépendance next-auth/Prisma/serveur), même
 * principe que super-admin.test.ts/password-policy.test.ts. Aucun secret réel : la clé de
 * chiffrement utilisée pour les tests des codes de récupération (pepper dérivé de
 * MFA_ENCRYPTION_KEY, voir src/lib/mfa-encryption.ts) est générée aléatoirement en mémoire de
 * process à chaque exécution, jamais persistée ni journalisée.
 */

function randomTestKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

// RFC 6238 Appendix B — secret ASCII officiel pour l'algorithme SHA1 : "12345678901234567890"
// (20 octets), T0 = 0, X = 30s, 8 chiffres. Passé comme Uint8Array brut (pas Base32) — otplib
// documente qu'une chaîne est assumée Base32 par défaut, un secret brut doit être un
// Uint8Array/Buffer explicite.
const RFC6238_SHA1_SECRET = Buffer.from("12345678901234567890", "ascii");

// Vecteurs officiels RFC 6238 Appendix B, ligne SHA1 (T en secondes Unix -> TOTP 8 chiffres).
const RFC6238_SHA1_VECTORS: { epochSeconds: number; totp8: string }[] = [
  { epochSeconds: 59, totp8: "94287082" },
  { epochSeconds: 1111111109, totp8: "07081804" },
  { epochSeconds: 1111111111, totp8: "14050471" },
  { epochSeconds: 1234567890, totp8: "89005924" },
  { epochSeconds: 2000000000, totp8: "69279037" },
  { epochSeconds: 20000000000, totp8: "65353130" },
];

describe("RFC 6238 — vecteurs officiels (Appendix B, SHA1, 8 chiffres)", () => {
  // Test de conformité de l'algorithme sous-jacent (otplib), indépendant de la politique de ce
  // projet (6 chiffres — voir src/lib/mfa.ts) : appelle directement les primitives otplib avec
  // les paramètres exacts de l'annexe RFC (digits: 8), pour valider l'implémentation
  // cryptographique elle-même contre des valeurs de référence publiées, sans dépendre d'un
  // calcul dérivé (troncature) qui introduirait un risque d'erreur de transcription.
  for (const vector of RFC6238_SHA1_VECTORS) {
    it(`génère et vérifie le code officiel pour T=${vector.epochSeconds}s`, async () => {
      const token = await otplibGenerate({
        secret: RFC6238_SHA1_SECRET,
        algorithm: "sha1",
        digits: 8,
        period: 30,
        epoch: vector.epochSeconds,
      });
      expect(token).toBe(vector.totp8);

      const result = await otplibVerify({
        secret: RFC6238_SHA1_SECRET,
        token: vector.totp8,
        algorithm: "sha1",
        digits: 8,
        period: 30,
        epoch: vector.epochSeconds,
      });
      expect(result.valid).toBe(true);
    });
  }
});

describe("src/lib/mfa.ts — TOTP (politique du projet : SHA1, 6 chiffres, pas 30s)", () => {
  const secret = generateTotpSecret();

  it("generateTotpToken produit un code à exactement 6 chiffres", async () => {
    const token = await generateTotpToken(secret, 1_700_000_000);
    expect(token).toMatch(/^\d{6}$/);
  });

  it("aller-retour génération/vérification réussit au même instant", async () => {
    const epoch = 1_700_000_000;
    const token = await generateTotpToken(secret, epoch);
    const result = await verifyTotpToken({ secretBase32: secret, token, epochSeconds: epoch });
    expect(result.valid).toBe(true);
    expect(result.timeStep).toBe(Math.floor(epoch / 30));
  });

  it("refuse un code invalide", async () => {
    const epoch = 1_700_000_000;
    const validToken = await generateTotpToken(secret, epoch);
    const wrongToken = validToken === "000000" ? "111111" : "000000";

    const result = await verifyTotpToken({ secretBase32: secret, token: wrongToken, epochSeconds: epoch });
    expect(result.valid).toBe(false);
    expect(result.timeStep).toBeUndefined();
  });

  describe("fenêtre de tolérance ±1 pas (30s)", () => {
    const referenceEpoch = 2_000_000_100; // arbitraire, non aligné sur une frontière de pas

    it("accepte un code généré au pas précédent (-30s)", async () => {
      const token = await generateTotpToken(secret, referenceEpoch - 30);
      const result = await verifyTotpToken({ secretBase32: secret, token, epochSeconds: referenceEpoch });
      expect(result.valid).toBe(true);
    });

    it("accepte un code généré au pas suivant (+30s)", async () => {
      const token = await generateTotpToken(secret, referenceEpoch + 30);
      const result = await verifyTotpToken({ secretBase32: secret, token, epochSeconds: referenceEpoch });
      expect(result.valid).toBe(true);
    });

    it("refuse un code généré deux pas dans le passé (-61s, hors fenêtre ±1)", async () => {
      const token = await generateTotpToken(secret, referenceEpoch - 61);
      const result = await verifyTotpToken({ secretBase32: secret, token, epochSeconds: referenceEpoch });
      expect(result.valid).toBe(false);
    });

    it("refuse un code généré deux pas dans le futur (+61s, hors fenêtre ±1)", async () => {
      const token = await generateTotpToken(secret, referenceEpoch + 61);
      const result = await verifyTotpToken({ secretBase32: secret, token, epochSeconds: referenceEpoch });
      expect(result.valid).toBe(false);
    });
  });

  describe("anti-rejeu (afterTimeStep)", () => {
    it("refuse la réutilisation d'un code déjà accepté au même pas", async () => {
      const epoch = 1_800_000_000;
      const token = await generateTotpToken(secret, epoch);

      const first = await verifyTotpToken({ secretBase32: secret, token, epochSeconds: epoch });
      expect(first.valid).toBe(true);
      expect(first.timeStep).toBeDefined();

      const replay = await verifyTotpToken({
        secretBase32: secret,
        token,
        epochSeconds: epoch,
        afterTimeStep: first.timeStep,
      });
      expect(replay.valid).toBe(false);
    });

    it("n'affecte pas un code légitime d'un pas ultérieur", async () => {
      const epoch = 1_800_000_000;
      const firstToken = await generateTotpToken(secret, epoch);
      const first = await verifyTotpToken({ secretBase32: secret, token: firstToken, epochSeconds: epoch });
      expect(first.valid).toBe(true);

      const nextEpoch = epoch + 30;
      const nextToken = await generateTotpToken(secret, nextEpoch);
      const next = await verifyTotpToken({
        secretBase32: secret,
        token: nextToken,
        epochSeconds: nextEpoch,
        afterTimeStep: first.timeStep,
      });
      expect(next.valid).toBe(true);
    });
  });

  describe("generateTotpSecret", () => {
    it("génère une valeur Base32 non vide, distincte à chaque appel (génération cryptographiquement sûre)", () => {
      const secrets = new Set(Array.from({ length: 20 }, () => generateTotpSecret()));
      expect(secrets.size).toBe(20);
      for (const value of secrets) {
        expect(value.length).toBeGreaterThan(0);
        expect(value).toMatch(/^[A-Z2-7]+=*$/); // alphabet Base32 standard (RFC 4648)
      }
    });
  });

  describe("buildOtpauthUri", () => {
    it("produit une URI otpauth://totp contenant l'émetteur, le compte et les paramètres attendus", () => {
      const uri = buildOtpauthUri({
        secretBase32: secret,
        accountEmail: "admin@example.test",
        issuer: "XRent Manager",
      });

      expect(uri).toMatch(/^otpauth:\/\/totp\//);
      expect(uri).toContain("admin%40example.test");
      expect(uri).toContain("issuer=XRent");
      expect(uri).toContain(`secret=${secret}`);
      // otplib omet algorithm/digits/period de la query string quand ils correspondent aux
      // valeurs par défaut RFC 6238 (SHA1/6/30, notre politique exacte) — comportement normal
      // de la bibliothèque, pas une perte d'information (un lecteur QR applique les défauts).
    });
  });
});

describe("src/lib/mfa.ts — codes de récupération", () => {
  const originalValue = process.env.MFA_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.MFA_ENCRYPTION_KEY;
    } else {
      process.env.MFA_ENCRYPTION_KEY = originalValue;
    }
  });

  it("génère 10 codes uniques par défaut, au format lisible", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}-[0-9A-F]{5}-[0-9A-F]{5}$/);
    }
  });

  it("génère des lots distincts à chaque appel (entropie suffisante, pas de collision observée)", () => {
    const batchA = generateRecoveryCodes();
    const batchB = generateRecoveryCodes();
    const intersection = batchA.filter((code) => batchB.includes(code));
    expect(intersection).toHaveLength(0);
  });

  it("normalise un code (casse, espaces, tirets) sans changer sa valeur logique", () => {
    const canonical = "3F9A2-1C7B0-88DE4-F1A20";
    expect(normalizeRecoveryCode(canonical)).toBe("3F9A21C7B088DE4F1A20");
    expect(normalizeRecoveryCode("3f9a2 1c7b0 88de4 f1a20")).toBe("3F9A21C7B088DE4F1A20");
    expect(normalizeRecoveryCode("3f9a2-1c7b0-88de4-f1a20")).toBe("3F9A21C7B088DE4F1A20");
  });

  it("hashRecoveryCode ne renvoie jamais le code en clair", () => {
    process.env.MFA_ENCRYPTION_KEY = randomTestKey();
    const [code] = generateRecoveryCodes(1);
    const hash = hashRecoveryCode(code);

    expect(hash).not.toBe(code);
    expect(hash.toUpperCase()).not.toContain(normalizeRecoveryCode(code));
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // HMAC-SHA256 hex
  });

  it("hashRecoveryCode est déterministe pour un même code et une même clé", () => {
    process.env.MFA_ENCRYPTION_KEY = randomTestKey();
    const [code] = generateRecoveryCodes(1);
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode(code));
  });

  it("verifyRecoveryCode accepte le code correct, y compris avec une saisie différente (casse/tirets)", () => {
    process.env.MFA_ENCRYPTION_KEY = randomTestKey();
    const [code] = generateRecoveryCodes(1);
    const storedHash = hashRecoveryCode(code);

    expect(verifyRecoveryCode(code, storedHash)).toBe(true);
    expect(verifyRecoveryCode(code.toLowerCase(), storedHash)).toBe(true);
    expect(verifyRecoveryCode(code.replace(/-/g, " "), storedHash)).toBe(true);
  });

  it("verifyRecoveryCode refuse un code incorrect ou un hash étranger", () => {
    process.env.MFA_ENCRYPTION_KEY = randomTestKey();
    const [codeA, codeB] = generateRecoveryCodes(2);
    const hashA = hashRecoveryCode(codeA);

    expect(verifyRecoveryCode(codeB, hashA)).toBe(false);
    expect(verifyRecoveryCode(codeA, "00".repeat(32))).toBe(false);
  });

  it("un même code produit des hash différents sous deux clés MFA_ENCRYPTION_KEY différentes (pepper effectif)", () => {
    process.env.MFA_ENCRYPTION_KEY = randomTestKey();
    const [code] = generateRecoveryCodes(1);
    const hashUnderKeyA = hashRecoveryCode(code);

    process.env.MFA_ENCRYPTION_KEY = randomTestKey();
    const hashUnderKeyB = hashRecoveryCode(code);

    expect(hashUnderKeyA).not.toBe(hashUnderKeyB);
  });
});
