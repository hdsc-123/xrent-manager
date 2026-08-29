import crypto from "crypto";

/**
 * Phase 3A MFA (2026-08-29, cadrage validé par le propriétaire du projet ; révisé le même jour
 * sur demande explicite pour remplacer la dérivation HMAC ad hoc par HKDF-SHA256 natif Node.js,
 * RFC 5869) — chiffrement au repos du secret TOTP. AES-256-GCM (authentifié : toute altération
 * du ciphertext, de l'IV ou du tag fait échouer le déchiffrement, jamais un décryptage
 * silencieusement corrompu).
 *
 * Un seul secret serveur (`MFA_ENCRYPTION_KEY`, base64, 32 octets décodés — même famille que
 * `AUTH_SECRET`/`CRON_SECRET`/`SUPER_ADMIN_EMAILS` : variable serveur uniquement, jamais
 * `NEXT_PUBLIC_*`, jamais commitée), utilisé comme *input keying material* (IKM) d'HKDF-SHA256
 * plutôt qu'un secret dédié par usage — `deriveSubkey` dérive des clés distinctes par contexte
 * (clé AES pour le secret TOTP ici, pepper des codes de récupération dans src/lib/mfa.ts) via
 * `crypto.hkdfSync("sha256", ikm, salt, info, keylen)`, l'API HKDF native de Node.js (disponible
 * depuis Node 15, confirmée présente sur le runtime du projet) — RFC 5869 complet (Extract puis
 * Expand), jamais une construction HMAC maison. Aucune nouvelle dépendance.
 *
 * - **`salt`** : valeur fixe, explicite, non secrète (`HKDF_SALT` ci-dessous) — RFC 5869 section
 *   3.1 : un salt peut être public, son rôle est la robustesse de l'extraction (indépendance
 *   statistique de l'IKM), pas la confidentialité. Convention documentée : chaîne applicative
 *   stable, versionnée (`-v1`) pour permettre une rotation délibérée et traçable si jamais
 *   nécessaire, jamais un secret ni une valeur aléatoire regénérée (un salt qui changerait
 *   silencieusement romprait la reproductibilité de la dérivation).
 * - **`info`** : contexte d'usage, ce qui garantit la séparation de domaine — `"mfa-encryption"`
 *   pour la clé AES-256-GCM, `"mfa-recovery-codes"` pour le pepper des codes de récupération
 *   (src/lib/mfa.ts). Deux contextes différents sur la même clé maîtresse produisent des
 *   sous-clés indépendantes (propriété HKDF, RFC 5869 section 3.2) — jamais la même sous-clé
 *   réutilisée pour deux primitives cryptographiques différentes.
 */

const ALGORITHM = "aes-256-gcm";
const MASTER_KEY_BYTE_LENGTH = 32;
const SUBKEY_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 12; // recommandation NIST SP 800-38D pour GCM
const AUTH_TAG_BYTE_LENGTH = 16;
const FORMAT_VERSION = "v1"; // version de la structure de l'enveloppe (iv/tag/ciphertext), pas de la KDF

const HKDF_DIGEST = "sha256";
// Salt HKDF fixe et public (RFC 5869 §3.1) — voir le commentaire d'en-tête. Ne jamais en faire
// un secret ni le regénérer : un changement romprait le déchiffrement de toute donnée déjà
// chiffrée sous l'ancien salt.
const HKDF_SALT = Buffer.from("xrent-manager-mfa-hkdf-salt-v1", "utf8");
export const AES_KEY_CONTEXT = "mfa-encryption";
export const RECOVERY_CODE_PEPPER_CONTEXT = "mfa-recovery-codes";

export class MfaEncryptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MfaEncryptionConfigError";
  }
}

export class MfaDecryptionError extends Error {
  constructor() {
    super("Échec du déchiffrement du secret MFA (donnée altérée ou clé incorrecte).");
    this.name = "MfaDecryptionError";
  }
}

/** Lit et décode MFA_ENCRYPTION_KEY (IKM d'HKDF). Ne journalise jamais la valeur, même en cas
 * d'erreur — les messages ci-dessous ne rapportent qu'une longueur, jamais le contenu. */
function resolveMasterKey(): Buffer {
  const raw = process.env.MFA_ENCRYPTION_KEY;
  if (!raw) {
    throw new MfaEncryptionConfigError("MFA_ENCRYPTION_KEY n'est pas configurée côté serveur.");
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new MfaEncryptionConfigError("MFA_ENCRYPTION_KEY n'est pas un base64 valide.");
  }

  if (key.length !== MASTER_KEY_BYTE_LENGTH) {
    throw new MfaEncryptionConfigError(
      `MFA_ENCRYPTION_KEY doit décoder en exactement ${MASTER_KEY_BYTE_LENGTH} octets (reçu ${key.length}).`
    );
  }

  return key;
}

/**
 * Dérive une sous-clé de 32 octets via HKDF-SHA256 (RFC 5869) à partir de la clé maîtresse
 * (IKM), du salt applicatif fixe (`HKDF_SALT`) et d'un contexte (`info`) — jamais la clé
 * maîtresse brute utilisée directement pour une primitive cryptographique. Exportée pour
 * src/lib/mfa.ts (pepper des codes de récupération, contexte `RECOVERY_CODE_PEPPER_CONTEXT`).
 * Déterministe : mêmes IKM+salt+contexte → toujours la même sous-clé.
 */
export function deriveSubkey(context: string): Buffer {
  const masterKey = resolveMasterKey();
  const okm = crypto.hkdfSync(HKDF_DIGEST, masterKey, HKDF_SALT, context, SUBKEY_BYTE_LENGTH);
  return Buffer.from(okm);
}

/** Chiffre un secret TOTP en clair. IV aléatoire à chaque appel, jamais réutilisé. */
export function encryptMfaSecret(plaintext: string): string {
  const key = deriveSubkey(AES_KEY_CONTEXT);
  const iv = crypto.randomBytes(IV_BYTE_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [FORMAT_VERSION, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(
    ":"
  );
}

/**
 * Déchiffre une enveloppe produite par encryptMfaSecret. Échoue (MfaDecryptionError) si
 * l'enveloppe, l'IV, le tag ou le ciphertext a été altéré (authentification GCM), ou si le
 * format est inconnu — jamais un déchiffrement partiel ou silencieusement incorrect.
 */
export function decryptMfaSecret(envelope: string): string {
  const key = deriveSubkey(AES_KEY_CONTEXT);
  const parts = envelope.split(":");

  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new MfaDecryptionError();
  }

  const [, ivB64, tagB64, ciphertextB64] = parts;

  let iv: Buffer;
  let authTag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(ivB64, "base64");
    authTag = Buffer.from(tagB64, "base64");
    ciphertext = Buffer.from(ciphertextB64, "base64");
  } catch {
    throw new MfaDecryptionError();
  }

  if (iv.length !== IV_BYTE_LENGTH || authTag.length !== AUTH_TAG_BYTE_LENGTH) {
    throw new MfaDecryptionError();
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw new MfaDecryptionError();
  }
}
