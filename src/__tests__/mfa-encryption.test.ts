import crypto from "crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  AES_KEY_CONTEXT,
  decryptMfaSecret,
  deriveSubkey,
  encryptMfaSecret,
  MfaDecryptionError,
  MfaEncryptionConfigError,
  RECOVERY_CODE_PEPPER_CONTEXT,
} from "@/lib/mfa-encryption";

/**
 * Phase 3A MFA — tests unitaires purs (aucune dépendance next-auth/Prisma/serveur), même
 * principe que super-admin.test.ts/password-policy.test.ts. Aucune valeur réelle de
 * MFA_ENCRYPTION_KEY : chaque test génère sa propre clé aléatoire éphémère en mémoire de
 * process (jamais écrite sur disque, jamais journalisée, jamais réutilisée hors du test) —
 * conforme à l'exigence « aucun secret MFA réel ne doit être généré pendant les tests
 * automatisés ».
 */

function randomTestKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

describe("mfa-encryption", () => {
  const originalValue = process.env.MFA_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.MFA_ENCRYPTION_KEY;
    } else {
      process.env.MFA_ENCRYPTION_KEY = originalValue;
    }
  });

  describe("encryptMfaSecret / decryptMfaSecret", () => {
    it("chiffre puis déchiffre un secret sans altération (aller-retour)", () => {
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      const plaintext = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

      const envelope = encryptMfaSecret(plaintext);
      expect(decryptMfaSecret(envelope)).toBe(plaintext);
    });

    it("produit un IV différent à chaque chiffrement, même pour un secret identique", () => {
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      const plaintext = "SECRET-IDENTIQUE-POUR-TEST-IV";

      const envelopeA = encryptMfaSecret(plaintext);
      const envelopeB = encryptMfaSecret(plaintext);

      expect(envelopeA).not.toBe(envelopeB);
      const ivA = envelopeA.split(":")[1];
      const ivB = envelopeB.split(":")[1];
      expect(ivA).not.toBe(ivB);

      // Les deux enveloppes distinctes doivent tout de même déchiffrer vers le même clair.
      expect(decryptMfaSecret(envelopeA)).toBe(plaintext);
      expect(decryptMfaSecret(envelopeB)).toBe(plaintext);
    });

    it("l'enveloppe ne contient jamais le secret en clair sous forme lisible", () => {
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      const plaintext = "PLAINTEXT-NE-DOIT-JAMAIS-APPARAITRE";

      const envelope = encryptMfaSecret(plaintext);
      expect(envelope).not.toContain(plaintext);
      expect(envelope.toUpperCase()).not.toContain(plaintext.toUpperCase());
    });

    it("échoue si le ciphertext est altéré", () => {
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      const envelope = encryptMfaSecret("secret-a-proteger");
      const [version, iv, tag, ciphertextB64] = envelope.split(":");

      const tampered = Buffer.from(ciphertextB64, "base64");
      tampered[0] ^= 0xff;
      const tamperedEnvelope = [version, iv, tag, tampered.toString("base64")].join(":");

      expect(() => decryptMfaSecret(tamperedEnvelope)).toThrow(MfaDecryptionError);
    });

    it("échoue si l'IV est altéré", () => {
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      const envelope = encryptMfaSecret("secret-a-proteger");
      const [version, ivB64, tag, ciphertext] = envelope.split(":");

      const tampered = Buffer.from(ivB64, "base64");
      tampered[0] ^= 0xff;
      const tamperedEnvelope = [version, tampered.toString("base64"), tag, ciphertext].join(":");

      expect(() => decryptMfaSecret(tamperedEnvelope)).toThrow(MfaDecryptionError);
    });

    it("échoue si le tag d'authentification est altéré", () => {
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      const envelope = encryptMfaSecret("secret-a-proteger");
      const [version, iv, tagB64, ciphertext] = envelope.split(":");

      const tampered = Buffer.from(tagB64, "base64");
      tampered[0] ^= 0xff;
      const tamperedEnvelope = [version, iv, tampered.toString("base64"), ciphertext].join(":");

      expect(() => decryptMfaSecret(tamperedEnvelope)).toThrow(MfaDecryptionError);
    });

    it("échoue sur un format d'enveloppe inconnu, sans jamais planter avec une exception non gérée", () => {
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      expect(() => decryptMfaSecret("n'importe-quoi")).toThrow(MfaDecryptionError);
      expect(() => decryptMfaSecret("v2:aa:bb:cc")).toThrow(MfaDecryptionError);
      expect(() => decryptMfaSecret("")).toThrow(MfaDecryptionError);
    });

    it("échoue si MFA_ENCRYPTION_KEY est absente", () => {
      delete process.env.MFA_ENCRYPTION_KEY;
      expect(() => encryptMfaSecret("x")).toThrow(MfaEncryptionConfigError);
      expect(() => decryptMfaSecret("v1:a:b:c")).toThrow(MfaEncryptionConfigError);
    });

    it("échoue si MFA_ENCRYPTION_KEY ne décode pas en exactement 32 octets", () => {
      process.env.MFA_ENCRYPTION_KEY = Buffer.from("trop-courte").toString("base64");
      expect(() => encryptMfaSecret("x")).toThrow(MfaEncryptionConfigError);
    });

    it("le message d'erreur ne contient jamais le secret en clair, le ciphertext ni la clé", () => {
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      const plaintext = "NE-DOIT-JAMAIS-FUITER-DANS-UN-MESSAGE-D-ERREUR";
      const envelope = encryptMfaSecret(plaintext);
      const corrupted = envelope.slice(0, -4) + "AAAA";

      try {
        decryptMfaSecret(corrupted);
        throw new Error("devait lever MfaDecryptionError");
      } catch (error) {
        expect(error).toBeInstanceOf(MfaDecryptionError);
        const message = (error as Error).message;
        expect(message).not.toContain(plaintext);
        expect(message).not.toContain(process.env.MFA_ENCRYPTION_KEY as string);
      }
    });
  });

  describe("deriveSubkey (HKDF-SHA256, RFC 5869)", () => {
    it("est déterministe pour une même clé maîtresse (IKM) et un même contexte (info)", () => {
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      const a = deriveSubkey("purpose-a");
      const b = deriveSubkey("purpose-a");
      expect(a.equals(b)).toBe(true);
    });

    it("produit exactement 32 octets, quel que soit le contexte", () => {
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      expect(deriveSubkey(AES_KEY_CONTEXT).length).toBe(32);
      expect(deriveSubkey(RECOVERY_CODE_PEPPER_CONTEXT).length).toBe(32);
    });

    it("sépare les contextes réels du projet : la clé AES et le pepper des codes de récupération sont distincts, jamais réutilisés l'un pour l'autre", () => {
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      const aesKey = deriveSubkey(AES_KEY_CONTEXT);
      const recoveryPepper = deriveSubkey(RECOVERY_CODE_PEPPER_CONTEXT);
      expect(aesKey.equals(recoveryPepper)).toBe(false);
    });

    it("sépare deux contextes arbitraires quelconques (propriété générale de séparation de domaine HKDF, pas seulement les deux contextes réels)", () => {
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      const a = deriveSubkey("contexte-arbitraire-a");
      const b = deriveSubkey("contexte-arbitraire-b");
      expect(a.equals(b)).toBe(false);
    });

    it("produit des sous-clés différentes pour deux clés maîtresses (IKM) différentes, même contexte", () => {
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      const a = deriveSubkey("same-context");
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      const b = deriveSubkey("same-context");
      expect(a.equals(b)).toBe(false);
    });

    it("reste déterministe et stable sur plusieurs appels successifs (pas de composante aléatoire dans la dérivation elle-même)", () => {
      process.env.MFA_ENCRYPTION_KEY = randomTestKey();
      const values = Array.from({ length: 5 }, () => deriveSubkey(AES_KEY_CONTEXT).toString("hex"));
      expect(new Set(values).size).toBe(1);
    });
  });
});
