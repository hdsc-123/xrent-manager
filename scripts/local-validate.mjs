#!/usr/bin/env node
/**
 * Validation locale sans GitHub Actions (2026-09-06, quota GitHub Actions épuisé jusqu'au
 * 2026-10-10) — orchestre uniquement les contrôles qui ne touchent aucune base de données :
 * lint, typecheck, build, validation du schéma Prisma. Reproduit localement l'équivalent du
 * job `build-and-check` de `.github/workflows/ci.yml`, jamais du job `test` (voir ci-dessous).
 *
 * Volontairement absent de ce script, et à ne jamais y ajouter sans revue explicite :
 * - toute commande touchant `xrent_test` (la suite de tests) — reste `node
 *   scripts/test-grouped.mjs`, un script séparé, jamais invoqué automatiquement ici ;
 * - `prisma migrate deploy`/`migrate dev`/`db push`/`migrate reset` — aucune de ces commandes
 *   n'apparaît dans ce fichier, sous aucune forme, contre aucun environnement.
 *
 * `prisma migrate status` (audit 2026-09-06, correctif de sécurité) : la seule commande Prisma
 * qui touche une base ici, strictement en lecture — mais **ignorée par défaut**. Elle ne
 * s'exécute que si `ALLOW_DEV_DB_STATUS=1` est explicitement défini, et même alors uniquement
 * après vérification de `DATABASE_URL` (jamais affichée) : protocole PostgreSQL, hôte
 * localhost/127.0.0.1, nom de base se terminant exactement par `_dev` — réutilise
 * `assertDatabaseMatchesEnv` de `scripts/env-guard.js` pour l'hôte/le nom de base (évite de
 * dupliquer cette logique déjà partagée par 5 autres scripts de ce dépôt), complétée ici par
 * une vérification de protocole que cette fonction ne couvre pas. Toute cible ambiguë,
 * inattendue ou non-PostgreSQL fait échouer le script proprement, avec un message qui ne
 * contient jamais le mot de passe, un token, ni l'URL complète.
 *
 * Usage :
 *   node scripts/local-validate.mjs                          # lint, typecheck, build, prisma validate
 *   ALLOW_DEV_DB_STATUS=1 node scripts/local-validate.mjs     # + état des migrations sur xrent_dev (lecture seule)
 *
 * Arrêt au premier échec réel, code de sortie reflète le résultat (0 = tout est passé).
 */
import { spawnSync } from "node:child_process";
import { config as loadDotenv } from "dotenv";
import envGuard from "./env-guard.js";

const STEPS = [
  {
    name: "Lint",
    command: "npm",
    args: ["run", "lint"],
    category: "sans base",
  },
  {
    name: "Typecheck",
    command: "npx",
    args: ["tsc", "--noEmit"],
    category: "sans base",
  },
  {
    name: "Build",
    command: "npm",
    args: ["run", "build"],
    category: "sans base",
  },
  {
    name: "Validation du schéma Prisma",
    command: "npx",
    args: ["prisma", "validate", "--schema=prisma/schema.prisma"],
    category: "sans base",
  },
];

console.log("=== Validation locale (sans GitHub Actions) ===");
console.log(
  "Contrôles sans base (toujours exécutés) : lint, typecheck, build, prisma validate.\n" +
    "Contrôle en lecture seule sur xrent_dev (migrate status) : ignoré par défaut — voir plus bas.\n" +
    "Contrôles NÉCESSITANT xrent_test (tests) : non inclus ici — exécuter séparément `node scripts/test-grouped.mjs` une fois son isolation confirmée.\n" +
    "Aucune migration n'est jamais appliquée automatiquement par ce script.\n"
);

let allPassed = true;

for (const step of STEPS) {
  const start = Date.now();
  process.stdout.write(`--- ${step.name} (${step.category}) ---\n`);
  process.stdout.write(`$ ${step.command} ${step.args.join(" ")}\n`);

  const result = spawnSync(step.command, step.args, { stdio: "inherit" });
  const durationSeconds = ((Date.now() - start) / 1000).toFixed(1);

  const failed = result.status !== 0;
  console.log(
    `→ code de sortie ${result.status} (${durationSeconds}s) — ${failed ? "ÉCHEC" : "ok"}\n`
  );

  if (failed) {
    allPassed = false;
    console.error(`Arrêt : « ${step.name} » a échoué. Étapes suivantes non exécutées.`);
    break;
  }
}

/**
 * Vérifie que `databaseUrl` cible sans ambiguïté une base PostgreSQL locale `xrent_dev` —
 * jamais un affichage de la valeur elle-même. Lève `envGuard.EnvironmentGuardError` (message
 * déjà non sensible, voir env-guard.js) pour toute cible non-PostgreSQL, non locale, absente,
 * mal formée, ou dont le nom ne se termine pas exactement par `_dev`.
 */
function assertSafeDevDatabaseTarget(databaseUrl) {
  if (!databaseUrl) {
    throw new envGuard.EnvironmentGuardError(
      "Garde-fou : DATABASE_URL introuvable — impossible de confirmer la cible. Abandon."
    );
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new envGuard.EnvironmentGuardError("Garde-fou : DATABASE_URL mal formée — cible ambiguë. Abandon.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new envGuard.EnvironmentGuardError(
      `Garde-fou : DATABASE_URL n'utilise pas PostgreSQL (protocole : "${parsed.protocol || "inconnu"}"). Abandon.`
    );
  }
  // Hôte localhost/127.0.0.1 + nom de base se terminant exactement par "_dev" — logique
  // partagée avec les 5 autres scripts opérationnels de ce dépôt, non dupliquée ici.
  return envGuard.assertDatabaseMatchesEnv(databaseUrl, "dev");
}

if (allPassed) {
  process.stdout.write("--- État des migrations (xrent_dev, lecture seule) ---\n");

  if (process.env.ALLOW_DEV_DB_STATUS !== "1") {
    console.log(
      "Migration status ignoré : définir ALLOW_DEV_DB_STATUS=1 pour inspecter explicitement xrent_dev.\n"
    );
  } else {
    // Charge `.env` (comportement dotenv standard : ne remplace jamais une variable déjà
    // présente dans le shell appelant) pour que la vérification ci-dessous porte sur la même
    // valeur que celle que `npx prisma migrate status` résoudra lui-même juste après.
    loadDotenv();

    try {
      assertSafeDevDatabaseTarget(process.env.DATABASE_URL);
    } catch (error) {
      allPassed = false;
      console.error(
        error instanceof envGuard.EnvironmentGuardError
          ? error.message
          : "Garde-fou : impossible de confirmer la cible de DATABASE_URL. Abandon."
      );
    }

    if (allPassed) {
      const start = Date.now();
      const args = ["prisma", "migrate", "status", "--schema=prisma/schema.prisma"];
      process.stdout.write(`$ npx ${args.join(" ")}\n`);

      // Sortie capturée (pas `stdio: "inherit"`) : nécessaire pour distinguer, sans jamais
      // afficher DATABASE_URL, un code de sortie non nul légitime (migrations en attente,
      // texte Prisma reconnu) d'un vrai échec (erreur de connexion, npx introuvable, etc.).
      const result = spawnSync("npx", args, { encoding: "utf8" });
      const durationSeconds = ((Date.now() - start) / 1000).toFixed(1);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      process.stdout.write(output);

      const spawnFailed = result.status === null || Boolean(result.error);
      const pendingMigrationsRecognized = /have not yet been applied/i.test(output);
      // Un code de sortie non nul n'est jamais accepté par défaut : uniquement lorsque Prisma a
      // réellement signalé des migrations en attente (texte reconnu ci-dessus), jamais pour une
      // autre raison. Un échec de lancement du processus (npx introuvable, etc.) est toujours
      // un échec, quel que soit `result.status`.
      const failed = spawnFailed || (result.status !== 0 && !pendingMigrationsRecognized);

      console.log(
        `→ code de sortie ${result.status} (${durationSeconds}s) — ${failed ? "ÉCHEC" : "ok"}\n`
      );

      if (failed) {
        allPassed = false;
        console.error("Arrêt : « État des migrations » a échoué de façon inattendue.");
      }
    }
  }
}

console.log(allPassed ? "=== Validation locale : TOUT EST VERT ===" : "=== Validation locale : ÉCHEC ===");
console.log(
  "Rappel : ceci est une validation locale, jamais un check GitHub Actions — ne pas la présenter comme tel."
);

process.exit(allPassed ? 0 : 1);
