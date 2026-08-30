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
 * Usage : node scripts/test-grouped.mjs [--no-file-parallelism]
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";

const GROUPS = [
  ["reservations", "permissions", "vehicle-mobility-alerts", "invoice-status-alerts", "reports", "db", "password-policy", "super-admin", "scheduled-alerts-cron", "responsive-layout", "mfa-encryption", "mfa", "mfa-lifecycle"],
  ["locations", "location-extension", "location-chains", "location-chain-balance", "dashboard-route-guards", "data-reset", "invoices", "audit-deletion", "auth", "login-throttle", "mfa-routes", "mfa-step-up-gating", "csv-export-sanitization", "csv-exports", "damages", "location-return"],
  ["vehicles", "agencies", "audit", "ui", "e2e-full", "invitations", "location-return-route", "credit-notes-ui", "damage-invoices-ui", "icon-hydration"],
  ["users", "security-notifications", "maintenances", "clients", "vehicle-trips", "batch-pdf", "location-payment", "damages-route", "damage-invoices-route", "test-grouped-integrity"],
  ["cash-register", "vehicle-transfers", "payments", "alerts", "e2e", "tenants", "return-damages-ui", "maintenance-location-coordination", "vehicle-status"],
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

// Filet de sécurité pour Ctrl+C / SIGTERM : le child `npx vitest` reçoit normalement le
// signal directement (même groupe de processus que ce script dans un terminal interactif),
// et vitest.global-setup.ts arrête alors le serveur `next dev` détaché via son teardown.
// Mais ce teardown asynchrone n'est pas garanti d'aboutir sur un arrêt brutal de vitest, et
// rien ne garantit que le child reçoive le signal si ce script est lancé hors d'un terminal
// interactif (CI, gestionnaire de process). Ce gestionnaire force donc, en dernier recours,
// la transmission du signal au child puis le nettoyage de tout `next dev` résiduel.
let currentProc = null;
let shuttingDown = false;

async function killResidualNextDev() {
  return new Promise((resolve) => {
    const proc = spawn("pkill", ["-f", "next dev.*-p 3811"]);
    proc.on("exit", () => resolve());
  });
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

function runGroup(files) {
  return new Promise((resolve) => {
    const args = ["vitest", "run", ...files, ...(sequential ? ["--no-file-parallelism"] : [])];
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    const proc = spawn("npx", args, { stdio: ["ignore", "pipe", "pipe"] });
    currentProc = proc;
    proc.stdout.on("data", (c) => {
      stdout += c;
      process.stdout.write(c);
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
  return new Promise((resolve) => {
    const proc = spawn("pgrep", ["-f", "next dev.*-p 3811"]);
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.on("exit", () => resolve(out.trim().split("\n").filter(Boolean)));
  });
}

async function main() {
  verifyGroupsMatchDirectory();

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

  for (let i = 0; i < GROUPS.length; i++) {
    if (shuttingDown) {
      // Un signal a été reçu pendant/après le groupe précédent : ne pas démarrer de
      // nouveau groupe (donc pas de nouveau serveur) pendant que handleSignal() nettoie
      // encore — c'est exactement le scénario qui causait un EADDRINUSE (le groupe suivant
      // tentait de démarrer un serveur avant la fin du nettoyage du précédent).
      console.log(
        `\n[test-grouped] Arrêt demandé — ${GROUPS.length - i} groupe(s) restant(s) non lancé(s).\n`,
      );
      return;
    }
    const files = GROUPS[i].map(filePathFor);
    console.log(`\n=== Groupe ${i + 1}/${GROUPS.length} (${files.length} fichiers) — serveur neuf ===\n`);
    const result = await runGroup(files);
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
    if (residual.length > 0) {
      console.error(`ATTENTION : processus résiduel après le groupe ${i + 1} : ${residual.join(",")}`);
    }
    if (result.code !== 0 && summary.failed === 0) {
      console.error(
        `ATTENTION : groupe ${i + 1} sorti en échec (code ${result.code}) sans résumé de tests exploitable (crash à la collecte ?).`,
      );
    }
  }

  const overallDurationMs = Date.now() - overallStart;
  const preventiveRestarts = GROUPS.length - 1;

  console.log("\n\n========== RÉSUMÉ AGRÉGÉ (recyclage préventif entre groupes) ==========");
  console.log(`Mode : ${sequential ? "--no-file-parallelism" : "parallélisme par défaut"}`);
  console.log(`Groupes : ${GROUPS.length}`);
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
