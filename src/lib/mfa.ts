import crypto from "crypto";
import { generate, generateSecret, generateURI, verify } from "otplib";
import { deriveSubkey, RECOVERY_CODE_PEPPER_CONTEXT } from "@/lib/mfa-encryption";

/**
 * Phase 3A MFA (2026-08-29, cadrage validé par le propriétaire du projet) — primitives TOTP
 * (RFC 6238) et codes de récupération. Module pur : aucun accès Prisma/session ici (le
 * câblage base de données/route est explicitement hors périmètre de cette phase — voir
 * prisma/schema.prisma, commentaire sur MfaStepUpProof).
 *
 * Bibliothèque retenue : `otplib` (validé explicitement par le propriétaire du projet,
 * package.json — voir le rapport de phase pour la justification complète : modulaire,
 * maintenue, aucune dépendance transitive hors du périmètre TOTP/HOTP, plugin crypto par
 * défaut = @noble/hashes, largement audité). Paramètres RFC 6238 passés explicitement (jamais
 * une valeur implicite de bibliothèque) pour ne jamais dépendre silencieusement d'un défaut qui
 * pourrait changer avec une future version d'otplib — même principe déjà appliqué à
 * BCRYPT_COST (src/lib/bcrypt-cost.ts).
 */

const TOTP_ALGORITHM = "sha1" as const;
const TOTP_DIGITS = 6 as const;
const TOTP_PERIOD_SECONDS = 30;
// Fenêtre de tolérance ±1 pas (cadrage validé, décision #3) : epochTolerance d'otplib est en
// secondes, symétrique par défaut avec un nombre simple — 1 pas de 30s de part et d'autre.
const TOTP_EPOCH_TOLERANCE_SECONDS = TOTP_PERIOD_SECONDS;

const RECOVERY_CODE_COUNT = 10;
// 10 octets aléatoires = 80 bits d'entropie par code, encodés en hexadécimal (pas de confusion
// de caractères façon 0/O, 1/I contrairement à un alphabet alphanumérique mixte) et regroupés
// pour la lisibilité humaine (saisie manuelle) — largement au-dessus de l'entropie usuelle des
// codes de récupération (ex. ~40 bits chez plusieurs fournisseurs grand public).
const RECOVERY_CODE_BYTE_LENGTH = 10;
const RECOVERY_CODE_GROUP_SIZE = 5;

export interface TotpVerificationResult {
  valid: boolean;
  /** Pas de temps (RFC 6238) du code accepté — à persister comme borne anti-rejeu
   * (User.mfaLastUsedStep) si valid === true. Absent si valid === false. */
  timeStep?: number;
}

/** Génère un nouveau secret TOTP aléatoire, encodé en Base32 (compatible Google
 * Authenticator/Authy/1Password...). Jamais persisté en clair par cette fonction — l'appelant
 * doit le chiffrer immédiatement (voir src/lib/mfa-encryption.ts) et ne jamais le journaliser. */
export function generateTotpSecret(): string {
  return generateSecret({ length: 20 }); // 20 octets = 160 bits, recommandation RFC 4226 §4
}

/** Construit l'URI otpauth:// pour affichage QR/saisie manuelle à l'enrôlement — jamais
 * persistée (recalculée à la demande depuis le secret déchiffré, jamais stockée en base). */
export function buildOtpauthUri(params: { secretBase32: string; accountEmail: string; issuer: string }): string {
  return generateURI({
    issuer: params.issuer,
    label: params.accountEmail,
    secret: params.secretBase32,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  });
}

/** Génère le code TOTP courant pour un secret donné — jamais utilisé en production (le serveur
 * ne calcule jamais "à la place" de l'utilisateur), exporté uniquement pour les tests unitaires
 * (vecteurs RFC 6238, aller-retour génération/vérification). */
export async function generateTotpToken(secretBase32: string, epochSeconds?: number): Promise<string> {
  return generate({
    secret: secretBase32,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    ...(epochSeconds !== undefined ? { epoch: epochSeconds } : {}),
  });
}

/**
 * Vérifie un code TOTP soumis par l'utilisateur. Anti-rejeu (décision du cadrage, point 18 du
 * rapport de phase précédent) : `afterTimeStep` rejette tout code dont le pas de temps est
 * inférieur ou égal à celui déjà accepté précédemment (User.mfaLastUsedStep) — géré nativement
 * par otplib, pas de logique de comparaison maison. Comparaison du code en temps constant
 * (garanti par otplib, cf. sa documentation "Uses constant-time comparison").
 */
export async function verifyTotpToken(params: {
  secretBase32: string;
  token: string;
  afterTimeStep?: number;
  epochSeconds?: number;
}): Promise<TotpVerificationResult> {
  const result = await verify({
    secret: params.secretBase32,
    token: params.token,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS,
    ...(params.afterTimeStep !== undefined ? { afterTimeStep: params.afterTimeStep } : {}),
    ...(params.epochSeconds !== undefined ? { epoch: params.epochSeconds } : {}),
  });

  // `verify()` du package `otplib` a un type de retour générique (TOTP ∪ HOTP) — cette
  // fonction est strictement scopée TOTP (aucun `strategy` n'est jamais passé), donc `timeStep`
  // est toujours présent en cas de succès ; le garde ci-dessous ne fait que satisfaire le type
  // union sans dupliquer la logique de vérification.
  if (!result.valid || !("timeStep" in result)) {
    return { valid: false };
  }

  return { valid: true, timeStep: result.timeStep };
}

// --- Codes de récupération -------------------------------------------------------------

function formatRecoveryCode(raw: Buffer): string {
  const hex = raw.toString("hex").toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += RECOVERY_CODE_GROUP_SIZE) {
    groups.push(hex.slice(i, i + RECOVERY_CODE_GROUP_SIZE));
  }
  return groups.join("-");
}

/** Normalise un code saisi par l'utilisateur avant hachage/comparaison — insensible à la casse
 * et aux espaces/tirets, pour ne jamais rejeter un code valide sur une simple différence de
 * saisie (copier-coller avec espace, tiret oublié...). */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]+/g, "").toUpperCase();
}

/**
 * Génère un lot de codes de récupération à usage unique (décision #6 du cadrage : 10 codes,
 * affichés une seule fois côté appelant, jamais recalculés ni relogués après coup). Retourne
 * les codes en clair (à afficher immédiatement puis à ne jamais reconstituer) — l'appelant est
 * responsable de ne persister que hashRecoveryCode(code), jamais cette valeur.
 */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(formatRecoveryCode(crypto.randomBytes(RECOVERY_CODE_BYTE_LENGTH)));
  }
  return codes;
}

/**
 * Hash d'un code de récupération — HMAC-SHA256 avec un pepper serveur dérivé de
 * MFA_ENCRYPTION_KEY par HKDF-SHA256 (RFC 5869, décision #6 : "hash avec pepper serveur" ;
 * voir src/lib/mfa-encryption.ts pour la dérivation complète — contexte dédié
 * `RECOVERY_CODE_PEPPER_CONTEXT`, distinct de celui de la clé AES du secret TOTP, garantissant
 * des sous-clés indépendantes par construction HKDF). HMAC plutôt qu'un simple SHA-256 non keyé :
 * empêche la reconstruction d'une table de correspondance hors ligne même en cas de fuite de la
 * seule table MfaRecoveryCode (le pepper reste un secret serveur, jamais en base).
 */
export function hashRecoveryCode(code: string): string {
  const pepper = deriveSubkey(RECOVERY_CODE_PEPPER_CONTEXT);
  const normalized = normalizeRecoveryCode(code);
  return crypto.createHmac("sha256", pepper).update(normalized, "utf8").digest("hex");
}

/** Compare un code soumis à un hash stocké, en temps constant (jamais `===` sur des hex de
 * longueur variable en cas de valeur corrompue — comparaison bloc à bloc uniquement si les
 * deux tampons ont la même longueur, sinon rejet immédiat sans fuite de timing exploitable). */
export function verifyRecoveryCode(code: string, storedHash: string): boolean {
  const candidateHash = hashRecoveryCode(code);
  const candidateBuffer = Buffer.from(candidateHash, "hex");
  const storedBuffer = Buffer.from(storedHash, "hex");

  if (candidateBuffer.length !== storedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidateBuffer, storedBuffer);
}
