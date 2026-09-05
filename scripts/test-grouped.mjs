#!/usr/bin/env node
/**
 * Sprint 24-5 — preuve contrôlée de recyclage préventif du serveur de test (INC-3).
 *
 * N'introduit aucune modification de vitest.global-setup.ts : chaque groupe est une
 * invocation `vitest run` séparée, donc le cycle de vie déjà existant (startServer /
 * waitForServer / health-check / stopServer avec SIGTERM puis SIGKILL) s'exécute
 * intégralement à chaque groupe, ce qui réalise l'arrêt propre + attente de fermeture +
 * redémarrage neuf + vérification de disponibilité demandés, sans toucher au watchdog
 * (conservé tel quel comme dernier filet de sécurité à l'intérieur de chaque groupe).
 *
 * Usage : node scripts/test-grouped.mjs [--no-file-parallelism] [--group=N]
 */
import { spawn } from "node:child_process";
import { readdirSync, appendFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GROUPS = [
  ["reservations", "permissions", "vehicle-mobility-alerts", "invoice-status-alerts", "reports", "db", "password-policy", "super-admin", "scheduled-alerts-cron", "responsive-layout", "mfa-encryption", "mfa", "mfa-lifecycle", "format"],
  ["invoices", "locations", "csv-exports", "location-chain-balance", "location-return"],
  ["location-extension", "location-chains", "data-reset", "audit-deletion", "auth", "login-throttle", "mfa-routes", "mfa-step-up-gating", "mfa-login-bypass", "csv-export-sanitization", "damages", "request-guards"],
  ["vehicles", "agencies", "audit", "ui", "e2e-full", "invitations", "credit-notes-ui", "damage-invoices-ui", "icon-hydration"],
  ["users", "security-notifications", "maintenances", "clients", "vehicle-trips", "batch-pdf", "location-payment", "damages-route", "damage-invoices-route", "test-grouped-integrity"],
  ["cash-register", "vehicle-transfers", "payments", "alerts", "e2e", "tenants", "return-damages-ui", "maintenance-location-coordination", "vehicle-status", "test-tenant-cleanup", "delete-test-tenant", "env-guard", "security-headers"],
  // Groupe 7 — diagnostic CI Groupe 4 (2026-09-04) : location-return-route.test.ts isolé du
  // Groupe 4 pour tester l'hypothèse confirmée par le tri par défaut de Vitest
  // (BaseSequencer.sort, tri par taille de fichier décroissante en l'absence de cache de
  // durée — toujours le cas en CI) : ce fichier est le 5e à démarrer dans l'ancien Groupe 4,
  // exactement au point où les gels observés surviennent (juste après agencies.test.ts). Seul
  // fichier de ce groupe, volontairement — l'expérience porte sur ce fichier précis, pas sur
  // un nouveau regroupement arbitraire.
  ["location-return-route"],
  // Groupe 8 — diagnostic CI Groupe 2 (2026-09-04) : dashboard-route-guards.test.ts isolé du
  // Groupe 2 pour mesurer si sa durée (256,9s observée dans un run CI, contre quelques
  // secondes en local) devient stable hors de la charge cumulée des 5 autres fichiers du
  // Groupe 2 — ce groupe avait dépassé `timeout-minutes: 15` une fois sans qu'aucun test
  // individuel n'échoue (heartbeats continus, aucun silence). Seul fichier de ce groupe,
  // volontairement — même méthode que le Groupe 7.
  ["dashboard-route-guards"],
];

const UI_TSX_FILES = new Set(["ui", "credit-notes-ui", "damage-invoices-ui", "icon-hydration"]);

function filePathFor(name) {
  if (UI_TSX_FILES.has(name)) return `src/__tests__/${name}.test.tsx`;
  return `src/__tests__/${name}.test.ts`;
}

// Sprint technique 4 — TESTREPORT.md/INCIDENTS.md documentaient depuis plusieurs sprints
// des "suites complètes" 100% vertes obtenues via ce script, alors que 4 fichiers de
// src/__tests__/ (36 tests) n'avaient jamais été ajoutés à GROUPS et n'étaient donc jamais
// exécutés par lui. Ce garde-fou empêche toute régression silencieuse équivalente à l'avenir :
// GROUPS doit couvrir exactement les fichiers réellement présents dans src/__tests__/, ni plus
// (fichier supprimé, entrée orpheline) ni moins (nouveau fichier de test jamais ajouté).
// `computeGroupsDrift` est une fonction pure (pas de process.exit) pour rester testable par
// src/__tests__/test-grouped-integrity.test.ts sans dupliquer cette logique.
function computeGroupsDrift(testsDirUrl) {
  const actualNames = readdirSync(testsDirUrl)
    .filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"))
    .map((f) => f.replace(/\.test\.tsx?$/, ""))
    .sort();
  const groupedNames = GROUPS.flat().slice().sort();

  const missing = actualNames.filter((n) => !groupedNames.includes(n));
  const orphaned = groupedNames.filter((n) => !actualNames.includes(n));
  const duplicated = groupedNames.filter((n, i) => groupedNames.indexOf(n) !== i);

  return { missing, orphaned, duplicated };
}

function verifyGroupsMatchDirectory() {
  const { missing, orphaned, duplicated } = computeGroupsDrift(new URL("../src/__tests__/", import.meta.url));

  if (missing.length > 0 || orphaned.length > 0 || duplicated.length > 0) {
    console.error("[test-grouped] GROUPS désynchronisé de src/__tests__/ :");
    if (missing.length > 0) console.error(`  Fichiers présents mais absents de GROUPS : ${missing.join(", ")}`);
    if (orphaned.length > 0) console.error(`  Entrées de GROUPS sans fichier correspondant : ${orphaned.join(", ")}`);
    if (duplicated.length > 0) console.error(`  Entrées dupliquées dans GROUPS : ${duplicated.join(", ")}`);
    process.exit(1);
  }
}

const sequential = process.argv.includes("--no-file-parallelism");

// Sprint CI — exécution d'un seul groupe depuis un job de matrice GitHub Actions
// indépendant (voir .github/workflows/ci.yml, job `test`, `strategy.matrix.group`).
// Format strict `--group=N`, 1-based, borné au nombre réel de groupes déclarés dans
// GROUPS ci-dessus (jamais une valeur codée en dur séparément, pour ne jamais diverger
// silencieusement si GROUPS gagne ou perd un groupe à l'avenir). Absence de cet argument :
// comportement inchangé (boucle complète sur tous les groupes, comme avant ce changement).
// `(.*)`, pas `(.+)` : capture aussi "--group=" (valeur vide) pour la faire tomber dans la
// même validation numérique ci-dessous plutôt que de la laisser silencieusement ignorée
// comme absence de l'argument (ce qui masquerait une erreur de invocation CI/locale).
const GROUP_ARG_PATTERN = /^--group=(.*)$/;
const rawArgs = process.argv.slice(2);

if (rawArgs.includes("--group")) {
  console.error(`[test-grouped] --group nécessite une valeur au format --group=N (1 à ${GROUPS.length}).`);
  process.exit(1);
}

const groupArgs = rawArgs.filter((arg) => GROUP_ARG_PATTERN.test(arg));
if (groupArgs.length > 1) {
  console.error(`[test-grouped] --group fourni plusieurs fois (${groupArgs.join(", ")}) — une seule occurrence attendue.`);
  process.exit(1);
}

let selectedGroupIndex = null;
if (groupArgs.length === 1) {
  const value = GROUP_ARG_PATTERN.exec(groupArgs[0])[1];
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || parsed > GROUPS.length) {
    console.error(
      `[test-grouped] --group invalide : "${value}" — attendu un entier entre 1 et ${GROUPS.length} (nombre de groupes actuellement déclarés dans GROUPS).`,
    );
    process.exit(1);
  }
  selectedGroupIndex = parsed - 1;
}

// Filet de sécurité pour Ctrl+C / SIGTERM : le child `npx vitest` reçoit normalement le
// signal directement (même groupe de processus que ce script dans un terminal interactif),
// et vitest.global-setup.ts arrête alors le serveur `next dev` détaché via son teardown.
// Mais ce teardown asynchrone n'est pas garanti d'aboutir sur un arrêt brutal de vitest, et
// rien ne garantit que le child reçoive le signal si ce script est lancé hors d'un terminal
// interactif (CI, gestionnaire de process). Ce gestionnaire force donc, en dernier recours,
// la transmission du signal au child puis le nettoyage de tout `next dev` résiduel.
let currentProc = null;
let shuttingDown = false;

// Expérience E (2026-09-04, INCIDENTS.md) — le Groupe 4 lance désormais `next start` au lieu de
// `next dev` (voir vitest.global-setup.ts, XRENT_TEST_SERVER_MODE). Les deux motifs sont
// toujours vérifiés, quel que soit le groupe : sans effet pour les groupes en mode dev (aucun
// `next start` n'existe jamais pour eux), nécessaire pour détecter/nettoyer un résidu du
// Groupe 4.
const SERVER_PROCESS_PATTERNS = ["next dev.*-p 3811", "next start.*-p 3811"];

async function killResidualNextDev() {
  await Promise.all(
    SERVER_PROCESS_PATTERNS.map(
      (pattern) =>
        new Promise((resolve) => {
          const proc = spawn("pkill", ["-f", pattern]);
          proc.on("exit", () => resolve());
        }),
    ),
  );
}

async function handleSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`\n[test-grouped] ${signal} reçu — arrêt en cours...\n`);
  if (currentProc && currentProc.exitCode === null) {
    try {
      currentProc.kill(signal);
    } catch {
      // déjà arrêté
    }
  }
  // Laisse une chance au teardown de vitest.global-setup.ts (arrêt propre du serveur,
  // SIGTERM puis SIGKILL après 5s de grâce côté serveur) de se terminer de lui-même.
  await new Promise((r) => setTimeout(r, 6000));
  const residual = await residualPids();
  if (residual.length > 0) {
    console.error(`[test-grouped] "next dev" résiduel après ${signal} — arrêt forcé : ${residual.join(",")}`);
    await killResidualNextDev();
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

// Observabilité minimale (voir analyse post-run CI, timeout à répétition sans logs GitHub
// exploitables) — chemin ancré explicitement à la racine du dépôt, indépendant du répertoire
// courant d'exécution. `fileURLToPath`/`dirname` plutôt que `import.meta.dirname` : portable
// sur toute version Node, pas seulement celles où cette propriété est disponible.
const __dirname = dirname(fileURLToPath(import.meta.url));
// Nom unique par groupe en mode `--group=N` (six jobs de matrice indépendants uploadent
// chacun leur propre artefact en parallèle — voir .github/workflows/ci.yml — un nom de
// fichier partagé provoquerait une collision d'écriture/d'upload entre eux). Mode boucle
// complète (aucun `--group`) : nom inchangé, comportement local/historique préservé.
const HEARTBEAT_FILE = join(
  __dirname,
  "..",
  selectedGroupIndex !== null
    ? `test-grouped-heartbeat-group-${selectedGroupIndex + 1}.log`
    : "test-grouped-heartbeat.log",
);
const HEARTBEAT_INTERVAL_MS = 30_000;
// Garde-fou de taille : le volume attendu (un tick/30s + 2 lignes par groupe + une ligne par
// fichier réellement exécuté) reste de l'ordre de quelques dizaines de Ko sur une suite
// complète ; 5 Mo est une marge large contre toute croissance imprévue, jamais une limite
// susceptible d'être atteinte en usage normal.
const HEARTBEAT_MAX_BYTES = 5 * 1024 * 1024;
let currentGroupLabel = "aucun (avant démarrage)";

// Best-effort strict : une erreur d'écriture (disque plein, permissions...) ne doit jamais
// interrompre la suite de tests elle-même, seule la visibilité en pâtirait.
function heartbeat(line) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  try {
    let size = 0;
    try {
      size = statSync(HEARTBEAT_FILE).size;
    } catch {
      size = 0; // fichier pas encore créé
    }
    if (size < HEARTBEAT_MAX_BYTES) {
      appendFileSync(HEARTBEAT_FILE, stamped);
    }
  } catch {
    // best-effort : jamais fatal pour la suite
  }
  process.stdout.write(stamped);
}

// Compte les process par motif — jamais leur ligne de commande complète, jamais une variable
// d'environnement. `pgrep -f` (sans `-c`, absent du pgrep BSD/macOS, vérifié empiriquement) +
// comptage de lignes côté Node, même méthode que `residualPids()` ci-dessus.
function countProcesses(pattern) {
  return new Promise((resolve) => {
    const proc = spawn("pgrep", ["-f", pattern]);
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.on("error", () => resolve(0)); // ex. binaire introuvable — ne doit jamais planter le process
    proc.on("exit", () => resolve(out.trim().split("\n").filter(Boolean).length));
  });
}

// Empêche tout chevauchement : sous charge/gel (précisément ce qu'on cherche à observer), un
// sondage encore en cours ne doit jamais en déclencher un second en parallèle.
let samplingInFlight = false;
async function sampleProcesses() {
  if (samplingInFlight) return "échantillon précédent encore en cours (ignoré)";
  samplingInFlight = true;
  try {
    // `next_start` : toujours à 0 pour les groupes en mode dev (aucun `next start` n'existe
    // pour eux) — ajout purement additif, ne change ni l'ordre ni le sens des champs existants.
    const [nextDev, nextStart, jestWorker, nextServer] = await Promise.all([
      countProcesses("next dev"),
      countProcesses("next start"),
      countProcesses("jest-worker"),
      countProcesses("next-server"),
    ]);
    return `next_dev=${nextDev} next_start=${nextStart} jest_worker=${jestWorker} next_server=${nextServer}`;
  } finally {
    samplingInFlight = false;
  }
}

// Expérience E (2026-09-04, INCIDENTS.md) — Groupe 4 uniquement (index 3, 0-based). Remplace,
// dans vitest.global-setup.ts et seulement pour ce groupe, le serveur `next dev` partagé par un
// cycle `next build` (une fois) + `next start` borné, sans recyclage ni redémarrage
// health-check, pour tester l'hypothèse Turbopack/jest-worker comme cause du gel CI observé
// (silence total puis annulation externe du runner, jamais un timeout de job — confirmé
// indépendant de location-return-route.test.ts, PR #4). Index 0-based, jamais codé en dur
// séparément de la boucle principale : GROUPS[3] est le Groupe 4 tel que déclaré ci-dessus.
const BUILD_MODE_GROUP_INDEX = 3;

function runGroup(files, groupIndex) {
  return new Promise((resolve) => {
    const args = ["vitest", "run", ...files, ...(sequential ? ["--no-file-parallelism"] : [])];
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    // Absent de tout autre groupe : `env` vaut alors `process.env` tel quel (référence
    // inchangée), donc XRENT_TEST_SERVER_MODE n'est jamais transmis aux Groupes 1, 2, 3, 5, 6, 7.
    const env =
      groupIndex === BUILD_MODE_GROUP_INDEX ? { ...process.env, XRENT_TEST_SERVER_MODE: "build" } : process.env;
    const proc = spawn("npx", args, { stdio: ["ignore", "pipe", "pipe"], env });
    currentProc = proc;
    // Buffer ligne par ligne : un chunk `data` ne correspond jamais forcément à une ligne
    // complète (coupure possible en plein milieu, ou plusieurs lignes dans un seul chunk).
    // Best-effort uniquement — n'affecte jamais `parseSummary()` plus bas, qui continue
    // d'opérer sur `stdout` accumulé en entier après la fin du process.
    let lineBuffer = "";
    proc.stdout.on("data", (c) => {
      stdout += c;
      process.stdout.write(c);
      lineBuffer += c.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const raw of lines) {
        const clean = raw.replace(/\x1b\[[0-9;]*m/g, ""); // retire les codes ANSI de couleur
        if (/src\/__tests__\/\S+\.test\.tsx?\s*\(\s*\d+ tests?\)/.test(clean)) {
          heartbeat(`fichier: ${clean.trim()}`);
        }
      }
    });
    proc.stderr.on("data", (c) => {
      stderr += c;
      process.stderr.write(c);
    });
    proc.on("exit", (code) => {
      currentProc = null;
      resolve({ code, stdout, stderr, durationMs: Date.now() - start });
    });
  });
}

function parseSummary(stdout) {
  const testsLine = /Tests\s+([^\n]+)/.exec(stdout);
  let passed = 0;
  let failed = 0;
  let total = 0;
  if (testsLine) {
    const seg = testsLine[1];
    const p = /(\d+)\s+passed/.exec(seg);
    const f = /(\d+)\s+failed/.exec(seg);
    const t = /\((\d+)\)/.exec(seg);
    passed = p ? Number(p[1]) : 0;
    failed = f ? Number(f[1]) : 0;
    total = t ? Number(t[1]) : passed + failed;
  }
  return { passed, failed, total };
}

async function residualPids() {
  const results = await Promise.all(
    SERVER_PROCESS_PATTERNS.map(
      (pattern) =>
        new Promise((resolve) => {
          const proc = spawn("pgrep", ["-f", pattern]);
          let out = "";
          proc.stdout.on("data", (c) => (out += c));
          proc.on("exit", () => resolve(out.trim().split("\n").filter(Boolean)));
        }),
    ),
  );
  return results.flat();
}

async function main() {
  verifyGroupsMatchDirectory();

  // Mode `--group=N` : un seul indice à traiter, identique par ailleurs à la boucle
  // complète (même libellé "Groupe i+1/GROUPS.length", même heartbeat, même watchdog/
  // recyclage/teardown — voir vitest.global-setup.ts, non modifié). Absence de `--group` :
  // comportement inchangé, tous les indices dans l'ordre déclaré.
  const groupIndices = selectedGroupIndex !== null ? [selectedGroupIndex] : GROUPS.map((_, idx) => idx);

  try {
    writeFileSync(HEARTBEAT_FILE, "");
  } catch {
    // best-effort : jamais fatal pour la suite
  }
  const heartbeatTimer = setInterval(() => {
    sampleProcesses().then((info) => {
      heartbeat(`heartbeat | groupe en cours: ${currentGroupLabel} | ${info}`);
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  const overallStart = Date.now();
  let totalPassed = 0;
  let totalFailed = 0;
  let totalTests = 0;
  let totalTimeouts = 0;
  let totalWatchdogRestarts = 0;
  let totalRecyclingRestarts = 0;
  let totalResidual = 0;
  let anyGroupExitNonZero = false;
  const groupResults = [];

  try {
    for (let pos = 0; pos < groupIndices.length; pos++) {
      const i = groupIndices[pos];
      if (shuttingDown) {
        // Un signal a été reçu pendant/après le groupe précédent : ne pas démarrer de
        // nouveau groupe (donc pas de nouveau serveur) pendant que handleSignal() nettoie
        // encore — c'est exactement le scénario qui causait un EADDRINUSE (le groupe suivant
        // tentait de démarrer un serveur avant la fin du nettoyage du précédent).
        console.log(
          `\n[test-grouped] Arrêt demandé — ${groupIndices.length - pos} groupe(s) restant(s) non lancé(s).\n`,
        );
        return;
      }
      const files = GROUPS[i].map(filePathFor);
      currentGroupLabel = `Groupe ${i + 1}/${GROUPS.length} (${files.length} fichiers)`;
      heartbeat(`=== DÉBUT ${currentGroupLabel} ===`);
      console.log(`\n=== Groupe ${i + 1}/${GROUPS.length} (${files.length} fichiers) — serveur neuf ===\n`);
      const result = await runGroup(files, i);
      heartbeat(`=== FIN ${currentGroupLabel} — ${(result.durationMs / 1000).toFixed(1)}s, code sortie ${result.code} ===`);
      const summary = parseSummary(result.stdout);
      const timeouts = (result.stdout.match(/Test timed out|Hook timed out/g) || []).length;
      // INC-27 (INCIDENTS.md) : `redémarrage contrôlé n°` est désormais émis pour deux raisons
      // distinctes par vitest.global-setup.ts — une panne réelle détectée par le contrôle de
      // vivacité INC-3 ("INC-3 : serveur de test injoignable...") et un recyclage préventif
      // bénin/attendu tous les 10 fichiers de test (`FILES_PER_RESTART`,
      // src/__tests__/helpers/testServerRecycling.ts), possible dans tout groupe d'au moins 10
      // fichiers. Comptées séparément pour ne jamais faire paraître un recyclage préventif normal
      // comme une panne watchdog réelle dans ce résumé.
      const watchdogRestarts = (result.stderr.match(/INC-3 : .*redémarrage contrôlé n°/g) || []).length;
      const recyclingRestarts = (result.stderr.match(/INC-27 : .*redémarrage contrôlé n°/g) || []).length;

      // Le code de sortie du process est la source de vérité : un crash à la collecte
      // (erreur de syntaxe, exception hors test, "Tests  no tests") ne produit aucune
      // ligne de résumé exploitable par parseSummary — s'appuyer uniquement sur
      // summary.failed masquerait un échec réel dans le code de sortie agrégé.
      if (result.code !== 0) anyGroupExitNonZero = true;

      totalPassed += summary.passed;
      totalFailed += summary.failed;
      totalTests += summary.total;
      totalTimeouts += timeouts;
      totalWatchdogRestarts += watchdogRestarts;
      totalRecyclingRestarts += recyclingRestarts;

      // Le teardown de vitest.global-setup.ts attend déjà la sortie du process serveur
      // (SIGTERM puis SIGKILL après 5s de grâce) avant que `vitest run` ne se termine —
      // cette pause + vérification est une confirmation indépendante, pas le mécanisme
      // d'arrêt lui-même.
      await new Promise((r) => setTimeout(r, 1000));
      const residual = await residualPids();
      totalResidual += residual.length;

      groupResults.push({
        group: i + 1,
        exitCode: result.code,
        ...summary,
        timeouts,
        watchdogRestarts,
        recyclingRestarts,
        durationMs: result.durationMs,
        residual: residual.length,
      });

      console.log(
        `\n--- Groupe ${i + 1} : ${summary.passed}/${summary.total} (échecs ${summary.failed}, timeouts ${timeouts}, watchdog ${watchdogRestarts}, recyclage ${recyclingRestarts}, ${(result.durationMs / 1000).toFixed(1)}s, résiduel ${residual.length}) ---\n`,
      );
      if (summary.failed > 0 && (watchdogRestarts > 0 || recyclingRestarts > 0)) {
        console.error(
          `SUSPICION : ${summary.failed} échec(s) dans le groupe ${i + 1} coïncident avec un redémarrage serveur (watchdog ${watchdogRestarts}, recyclage ${recyclingRestarts}) — probable collatéral d'infrastructure, pas nécessairement un défaut de test.`,
        );
      }
      if (residual.length > 0) {
        console.error(`ATTENTION : processus résiduel après le groupe ${i + 1} : ${residual.join(",")}`);
      }
      if (result.code !== 0 && summary.failed === 0) {
        console.error(
          `ATTENTION : groupe ${i + 1} sorti en échec (code ${result.code}) sans résumé de tests exploitable (crash à la collecte ?).`,
        );
      }
    }
  } finally {
    // Garanti pour une sortie normale, un `return` anticipé (arrêt demandé) ou toute exception
    // levée dans la boucle. Ne couvre pas le chemin SIGINT/SIGTERM : `handleSignal()` (non
    // modifié) appelle `process.exit()` directement, ce qui termine le process avant que cette
    // promesse ne se résolve — la mort du process arrête alors le timer par elle-même.
    clearInterval(heartbeatTimer);
    heartbeat("=== ARRÊT DE LA BOUCLE (finally) ===");
  }

  const overallDurationMs = Date.now() - overallStart;
  const preventiveRestarts = groupIndices.length - 1;

  console.log("\n\n========== RÉSUMÉ AGRÉGÉ (recyclage préventif entre groupes) ==========");
  console.log(
    `Mode : ${sequential ? "--no-file-parallelism" : "parallélisme par défaut"}${
      selectedGroupIndex !== null ? ` — groupe ${selectedGroupIndex + 1}/${GROUPS.length} uniquement` : ""
    }`,
  );
  console.log(`Groupes : ${groupIndices.length}`);
  console.log(`Tests : ${totalPassed}/${totalTests} réussis (échecs : ${totalFailed})`);
  console.log(`Timeouts : ${totalTimeouts}`);
  console.log(`Redémarrages préventifs (entre groupes) : ${preventiveRestarts}`);
  console.log(`Redémarrages watchdog (dans un groupe) : ${totalWatchdogRestarts}`);
  console.log(`Redémarrages de recyclage préventif INC-27 (dans un groupe) : ${totalRecyclingRestarts}`);
  console.log(`Durée totale : ${(overallDurationMs / 1000).toFixed(1)}s`);
  console.log(`Processus résiduels détectés (cumulé) : ${totalResidual}`);
  console.log("\nDétail par groupe :");
  for (const g of groupResults) {
    console.log(
      `  Groupe ${g.group} : ${g.passed}/${g.total} (échecs ${g.failed}, timeouts ${g.timeouts}, watchdog ${g.watchdogRestarts}, recyclage ${g.recyclingRestarts}, ${(g.durationMs / 1000).toFixed(1)}s, résiduel ${g.residual}, code sortie ${g.exitCode})`,
    );
  }

  process.exit(totalFailed > 0 || anyGroupExitNonZero ? 1 : 0);
}

// Sprint technique 4 : export pour permettre au test de non-régression
// (src/__tests__/test-grouped-integrity.test.ts) de vérifier GROUPS sans exécuter la suite —
// `main()` ne se déclenche que lors d'une invocation directe du script (`node scripts/...`),
// jamais lors d'un `import`.
export { GROUPS, computeGroupsDrift };

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
