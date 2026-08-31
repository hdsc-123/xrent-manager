/**
 * Source de vérité unique pour la sélection d'environnement (dev/test) des scripts
 * opérationnels CommonJS de ce projet (`backfill-permissions.js`, `bootstrap-superadmin.js`,
 * `reset-dev-data.js`, `resync-vehicle-status.js`, `superadmin-mfa-recovery.js`). Avant ce
 * module (mode livraison efficace, phase 4, 2026-08-31), chacun de ces 5 scripts recopiait sa
 * propre version quasi identique de cette logique — même classe de risque que INC-29
 * (logique dupliquée entre plusieurs fichiers, jamais resynchronisée), mais ici pour un
 * garde-fou de sécurité contre une exécution accidentelle sur la mauvaise base, pas
 * seulement du nettoyage de test.
 *
 * Deux points que chaque copie dupliquée laissait ouverts, durcis ici :
 * 1. `dotenv.config()` ne lève jamais et ne signale rien de bloquant en cas de fichier
 *    manquant/illisible — sans vérifier explicitement son retour (aucun des 5 scripts ne le
 *    faisait), un `.env`/`.env.test` temporairement absent ou mal nommé laisse silencieusement
 *    `process.env.DATABASE_URL` retomber sur une valeur déjà présente dans le shell appelant
 *    (peut pointer n'importe où, y compris `xrent_dev` ou une base tierce), sans jamais faire
 *    échouer le chargement. `loadEnvFileForEnv` ci-dessous vérifie l'existence du fichier et le
 *    retour de `dotenv.config()` avant de continuer.
 * 2. Le garde-fou d'origine vérifiait seulement que le nom de base *ressemblait* à une base
 *    dev/test (`/_dev$|_test$/`), jamais qu'il correspondait PRÉCISÉMENT à l'environnement
 *    demandé par `--env=`. Un `.env.test` mal configuré (édition manuelle malencontreuse)
 *    pointant par erreur vers une base `..._dev` passait ce garde-fou sans la moindre alerte,
 *    avec `--env=test` affiché à l'écran — l'opérateur croit agir sur `xrent_test`, agit en
 *    réalité sur une base `_dev`. `assertDatabaseMatchesEnv` ci-dessous exige désormais une
 *    correspondance exacte entre le suffixe du nom de base et l'environnement demandé.
 *
 * Toutes les fonctions ci-dessous sont pures (jamais de `process.exit()` direct) — chaque
 * script appelant reste responsable d'attraper `EnvironmentGuardError` et de décider de la
 * sortie (voir le patron déjà établi par `scripts/delete-test-tenant.mjs`, Phase 1.2). Rend ce
 * module testable directement (voir `src/__tests__/env-guard.test.ts`).
 */

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const VALID_ENVS = ["dev", "test"];

class EnvironmentGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnvironmentGuardError";
  }
}

/** Lit `--env=` dans `args` (ex. `process.argv.slice(2)`) — refuse toute valeur absente ou
 * hors de `VALID_ENVS` (jamais de défaut implicite : voir CLAUDE.md/SECURITY.md, la sélection
 * d'environnement doit toujours être explicite). */
function parseEnvFlag(args, usageMessage) {
  const envArg = args.find((arg) => arg.startsWith("--env="));
  const env = envArg ? envArg.split("=")[1] : null;
  if (!VALID_ENVS.includes(env)) {
    throw new EnvironmentGuardError(usageMessage);
  }
  return env;
}

function envFileNameFor(env) {
  return env === "dev" ? ".env" : ".env.test";
}

/** `rootDir` : racine du dépôt (le script appelant passe `path.resolve(__dirname, "..")`). */
function loadEnvFileForEnv(env, rootDir) {
  const envFile = envFileNameFor(env);
  const resolvedPath = path.resolve(rootDir, envFile);
  if (!fs.existsSync(resolvedPath)) {
    throw new EnvironmentGuardError(
      `Fichier d'environnement introuvable : ${resolvedPath}. Abandon — jamais de repli ` +
        "implicite sur une variable déjà présente dans le shell appelant."
    );
  }
  const result = dotenv.config({ path: resolvedPath, override: true });
  if (result.error) {
    throw new EnvironmentGuardError(`Impossible de charger ${envFile} (${resolvedPath}) : ${result.error.message}. Abandon.`);
  }
  return envFile;
}

/** Vérifie que `databaseUrl` pointe vers localhost/127.0.0.1 ET qu'un nom de base se
 * termine EXACTEMENT par `_${env}` (correspondance stricte avec l'environnement demandé,
 * pas seulement "ressemble à du dev/test" — voir le point 2 du commentaire d'en-tête). */
function assertDatabaseMatchesEnv(databaseUrl, env) {
  if (!databaseUrl) {
    throw new EnvironmentGuardError("DATABASE_URL introuvable après chargement du fichier d'environnement.");
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new EnvironmentGuardError(`DATABASE_URL malformée : ${databaseUrl}`);
  }
  const dbName = parsed.pathname.slice(1);
  const isLocalHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const expectedSuffix = `_${env}`;
  const matchesRequestedEnv = dbName.endsWith(expectedSuffix);

  if (!isLocalHost || !matchesRequestedEnv) {
    throw new EnvironmentGuardError(
      `Garde-fou : DATABASE_URL (${parsed.hostname}/${dbName}) ne correspond pas à l'environnement ` +
        `demandé (--env=${env}, attendu : nom de base se terminant par "${expectedSuffix}", sur ` +
        "localhost/127.0.0.1). Abandon."
    );
  }

  return { dbName, hostname: parsed.hostname };
}

module.exports = {
  EnvironmentGuardError,
  VALID_ENVS,
  parseEnvFlag,
  envFileNameFor,
  loadEnvFileForEnv,
  assertDatabaseMatchesEnv,
};
