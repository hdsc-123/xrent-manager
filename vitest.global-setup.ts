import { spawn, type ChildProcess } from "node:child_process";
import { config as loadDotenv } from "dotenv";
import { TEST_BASE_URL, TEST_PORT } from "./src/__tests__/helpers/testServer";
import {
  resetRecyclingState,
  isRestartRequested,
  clearRestartRequest,
  FILES_PER_RESTART,
} from "./src/__tests__/helpers/testServerRecycling";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";

/**
 * Les routes app/api/** appellent NextAuth (`auth()`), qui utilise `next/headers` en
 * interne — cette API ne fonctionne que dans le contexte d'une vraie requête servie par
 * Next.js (vérifié : un appel direct depuis Vitest lève "headers was called outside a
 * request scope"). Les tests d'intégration démarrent donc un vrai serveur `next dev`,
 * pointé sur la base de test dédiée (`xrent_test`, voir .env.test), et lui envoient de
 * vraies requêtes HTTP.
 */

/**
 * INC-3 (voir INCIDENTS.md) : ce serveur unique et de longue durée, partagé par toute la
 * suite, peut entrer sous charge soutenue dans un état de blocage complet et non résorbable
 * (confirmé par investigation directe : Postgres reste intégralement inactif pendant le
 * blocage — `pg_stat_activity` ne montre que des connexions `idle`/`ClientRead`, jamais de
 * requête active ni de verrou — et la charge CPU de la machine reste basse ; le blocage se
 * situe donc côté processus Node/moteur de requêtes Prisma du serveur `next dev`, pas côté
 * base de données ni côté CPU). Aucune cause corrigible avec certitude n'a été identifiée
 * dans le code applicatif. Un contrôle de vivacité (health check) périodique redémarre donc
 * ce serveur partagé s'il cesse de répondre pendant une durée soutenue, pour borner la durée
 * d'une panne (auparavant : jusqu'à plusieurs minutes, jusqu'à l'épuisement complet du run)
 * au lieu de la laisser se prolonger indéfiniment. Ce redémarrage ne masque aucun échec : les
 * requêtes en cours au moment du blocage échouent toujours (comme avant), il évite seulement
 * que *tous* les tests suivants du run échouent en cascade derrière un serveur mort.
 */
// Espacés et tolérants pour ne jamais confondre le blocage total et prolongé d'INC-3 avec
// une lenteur transitoire normale (ex. première compilation à la volée par Turbopack d'une
// route pas encore visitée, sous la salve de requêtes concurrentes du tout début du run).
// Seuil de déclenchement : 9 échecs consécutifs espacés de 5s = ~45s d'injoignabilité totale
// et soutenue avant redémarrage — très en-dessous des pannes observées (3,5 à plus de 13 min)
// mais largement au-dessus de toute lenteur de démarrage légitime constatée.
const HEALTH_CHECK_INTERVAL_MS = 5_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const CONSECUTIVE_FAILURES_BEFORE_RESTART = 9;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Expérience E (2026-09-04, INCIDENTS.md) — Groupe 4 uniquement. Le gel CI récurrent (silence
 * total puis annulation externe du runner, jamais un timeout de job) survient systématiquement
 * juste après agencies.test.ts, y compris après avoir isolé location-return-route.test.ts dans
 * son propre groupe (PR #4) — le fichier suivant n'est donc pas en cause. Cette expérience teste
 * la dernière piste applicative restante : le sous-système Turbopack/jest-worker de `next dev`
 * (déjà documenté comme créant un process OS neuf à chaque rendu d'une page à segment
 * dynamique, jamais réutilisé — voir plus bas). `next build` + `next start` ne chargent jamais
 * ce sous-système. Positionné exclusivement par scripts/test-grouped.mjs pour --group=4 (jamais
 * pour les autres groupes, jamais par défaut) — voir runGroup() dans ce fichier.
 */
const SERVER_MODE = process.env.XRENT_TEST_SERVER_MODE === "build" ? "build" : "dev";
const BUILD_TIMEOUT_MS = 180_000;
const BUILD_OUTPUT_MAX_LINES = 20;

let serverProcess: ChildProcess | undefined;
let healthCheckTimer: NodeJS.Timeout | undefined;
let restarting = false;
let consecutiveFailures = 0;
let restartCount = 0;
let stopped = false;
let inFlightHealthCheck: AbortController | undefined;
let restartPromise: Promise<void> | undefined;

// ============================================================================================
// DIAGNOSTIC TEMPORAIRE — À SUPPRIMER après analyse du prochain échec de redémarrage en CI.
// Objet : capturer ce que la CI ne conserve pas aujourd'hui (voir diagnostic du run
// 33751319195, 2026-09-03) — sortie brute Next/Turbopack pendant un redémarrage, PID, usage de
// SIGTERM/SIGKILL, durées d'arrêt/démarrage, code de sortie, état du port 3811. Écrit dans un
// fichier dédié (jamais dans stdout/stderr filtré — voir la logique déjà en place juste en
// dessous, /error/i uniquement) pour ne rien perdre cette fois. N'affiche jamais de secret :
// uniquement des métadonnées de process (PID, timings, événements), jamais le contenu de
// .env.test. Ne modifie AUCUN comportement existant : purement additif, jamais dans le chemin
// critique (écriture synchrone best-effort, jamais awaited dans le flux de contrôle réel ;
// sonde de port fire-and-forget, non bloquante).
// ============================================================================================
const NEXT_SERVER_DIAG_FILE = path.join(process.cwd(), "next-server-diag.log");

function diagLog(event: string, data: Record<string, unknown> = {}): void {
  const line = { ts: new Date().toISOString(), event, ...data };
  try {
    fs.appendFileSync(NEXT_SERVER_DIAG_FILE, JSON.stringify(line) + "\n");
  } catch {
    // best-effort : ne doit jamais interrompre le cycle de vie réel du serveur.
  }
}

/** Sonde TCP non bloquante, jamais attendue dans le flux réel (fire-and-forget) — indique
 * uniquement si quelque chose écoute déjà sur le port au moment de l'appel. */
function diagLogPortStatus(label: string): void {
  const socket = net.connect({ port: TEST_PORT, host: "127.0.0.1", timeout: 1_000 });
  socket.once("connect", () => {
    diagLog("port-status", { label, port: TEST_PORT, status: "occupied" });
    socket.destroy();
  });
  socket.once("timeout", () => {
    diagLog("port-status", { label, port: TEST_PORT, status: "timeout (ni ouvert ni fermé sous 1s)" });
    socket.destroy();
  });
  socket.once("error", (error: NodeJS.ErrnoException) => {
    diagLog("port-status", {
      label,
      port: TEST_PORT,
      status: error.code === "ECONNREFUSED" ? "free" : `error:${error.code}`,
    });
    socket.destroy();
  });
}
// ============================================================================================
// FIN DU BLOC DIAGNOSTIC TEMPORAIRE (suite : instrumentation ajoutée dans waitForServer(),
// stopServer(), startServer() et restartServer() ci-dessous, chaque ajout marqué séparément)
// ============================================================================================

// Correctif ciblé (diagnostic CI Groupe 4, runs 33751319195/33757578715, 2026-09-03) — distinct
// du bloc diagnostic temporaire ci-dessus : capture les dernières lignes stdout/stderr du
// serveur en cours, pour les inclure dans l'erreur si le process meurt avant d'être prêt (voir
// waitForServer() ci-dessous). Réinitialisé à chaque nouveau spawn (startServer()). Borné pour
// rester lisible dans un message d'erreur, jamais destiné à remplacer next-server-diag.log
// (bloc diagnostic ci-dessus, qui conserve tout, sans borne de lignes).
const RECENT_OUTPUT_MAX_LINES = 20;
let recentOutputLines: string[] = [];

function recordRecentOutput(text: string): void {
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    recentOutputLines.push(line);
  }
  if (recentOutputLines.length > RECENT_OUTPUT_MAX_LINES) {
    recentOutputLines = recentOutputLines.slice(-RECENT_OUTPUT_MAX_LINES);
  }
}

/**
 * Correctif ciblé (diagnostic CI Groupe 4, runs 33751319195/33757578715, 2026-09-03) : avant ce
 * correctif, `waitForServer()` ignorait totalement la sortie du process qu'elle attendait — un
 * panic Turbopack faisant sortir le process avec le code 0 après un « Ready » initial (observé
 * directement, voir next-server-diag-group-4) n'était détecté qu'après épuisement complet de
 * `timeoutMs` (jusqu'à 53s perdus à sonder un port déjà vide). Un unique `AbortController`
 * relie maintenant le sondage HTTP, l'attente entre deux tentatives et la détection de sortie du
 * process : dès que l'une des trois issues (prêt / mort / timeout) survient, les deux autres
 * chemins sont annulés immédiatement — jamais de travail résiduel en arrière-plan. Ne change
 * aucun délai existant : mêmes bornes (`timeoutMs`, intervalle de 300ms) qu'avant ce correctif.
 */
async function waitForServer(url: string, timeoutMs: number, proc: ChildProcess): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  let lastError: unknown;
  let outcome: "died" | undefined;
  let dieError: Error | undefined;
  const controller = new AbortController();

  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    outcome = "died";
    const recentOutput = recentOutputLines.join("\n");
    diagLog("waitForServer-process-died", { pid: proc.pid, code, signal, elapsedMs: Date.now() - start }); // DIAGNOSTIC TEMPORAIRE
    dieError = new Error(
      `Le serveur Next.js de test (pid=${proc.pid}) s'est arrêté avant d'être prêt — code=${code}, signal=${signal}.\n` +
        `--- Dernières lignes stdout/stderr ---\n${recentOutput || "(aucune sortie capturée)"}`
    );
    controller.abort(); // annule immédiatement tout fetch()/attente en cours ci-dessous
  };
  proc.once("exit", onExit);

  try {
    // DIAGNOSTIC TEMPORAIRE — voir le bloc en tête de fichier.
    diagLog("waitForServer-start", { url, timeoutMs, pid: proc.pid });
    while (Date.now() - start < timeoutMs) {
      if (controller.signal.aborted) break; // process déjà mort pendant l'attente précédente
      attempt += 1;
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (response.status < 500) {
          // DIAGNOSTIC TEMPORAIRE
          diagLog("waitForServer-ready", { attempt, durationMs: Date.now() - start, status: response.status });
          return;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        if (controller.signal.aborted) break; // fetch annulé car le process vient de mourir
        // Le serveur n'écoute pas encore — on réessaie.
        lastError = error instanceof Error ? error.message : String(error);
      }
      // DIAGNOSTIC TEMPORAIRE — un échantillon toutes les ~3s (10 tentatives à 300ms) plutôt que
      // chaque tentative, pour rester lisible sur un délai pouvant aller jusqu'à 60-70s.
      if (attempt === 1 || attempt % 10 === 0) {
        diagLog("waitForServer-poll", { attempt, elapsedMs: Date.now() - start, lastError: String(lastError) });
      }
      try {
        await setTimeoutPromise(300, undefined, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) break; // annulé pendant l'attente — process mort (voir onExit)
        throw error; // toute autre erreur reste une vraie anomalie, jamais masquée
      }
    }

    if (outcome === "died") {
      throw dieError;
    }
    // DIAGNOSTIC TEMPORAIRE
    diagLog("waitForServer-timeout", { attempts: attempt, durationMs: Date.now() - start, lastError: String(lastError) });
    diagLogPortStatus("waitForServer-timeout");
    throw new Error(`Le serveur Next.js de test n'a pas démarré sous ${timeoutMs}ms.`);
  } finally {
    // Nettoyage systématique, quel que soit le chemin de sortie (prêt / mort / timeout) :
    // l'écouteur ne doit jamais se redéclencher plus tard lors de l'arrêt normal par
    // stopServer(), et aucun fetch()/attente ne doit continuer à tourner en arrière-plan.
    proc.removeListener("exit", onExit);
    if (!controller.signal.aborted) controller.abort();
  }
}

async function stopServer(proc: ChildProcess): Promise<void> {
  if (!proc.pid) return;
  const pid = proc.pid;
  // DIAGNOSTIC TEMPORAIRE
  const stopStart = Date.now();
  diagLog("stopServer-start", { pid });
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", (code, signal) => {
      // DIAGNOSTIC TEMPORAIRE
      diagLog("stopServer-exited", { pid, code, signal, durationMs: Date.now() - stopStart });
      resolve();
    });
  });
  try {
    process.kill(-pid, "SIGTERM");
    diagLog("stopServer-sigterm-sent", { pid }); // DIAGNOSTIC TEMPORAIRE
  } catch {
    return; // déjà arrêté
  }
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), GRACEFUL_SHUTDOWN_TIMEOUT_MS)),
  ]);
  if (timedOut) {
    // Le serveur est bloqué (voir INC-3) et n'a pas réagi à SIGTERM à temps — arrêt forcé.
    diagLog("stopServer-sigkill", { pid, afterMs: Date.now() - stopStart }); // DIAGNOSTIC TEMPORAIRE
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // déjà arrêté entre-temps
    }
    await exited;
  }
}

async function cleanupResidualTestServer(): Promise<void> {
  // Un arrêt brutal de Vitest (SIGKILL, timeout externe, double interruption) ne laisse
  // aucune chance au teardown de ce fichier de s'exécuter — le serveur `next dev` (ou, en
  // mode build/Groupe 4, `next start`) détaché peut alors survivre indéfiniment et bloquer le
  // port de test au prochain lancement (EADDRINUSE). Nettoyage préventif idempotent avant
  // chaque spawn, pattern strictement borné au port de test (jamais le port 3000 de
  // développement). Les deux motifs sont toujours vérifiés, quel que soit SERVER_MODE : sans
  // effet pour les groupes en mode dev (aucun `next start` n'existe jamais pour eux) et
  // nécessaire pour le Groupe 4 en mode build. Complémentaire au filet de sécurité déjà
  // présent dans scripts/test-grouped.mjs, pas un remplacement.
  for (const pattern of [`next dev.*-p ${TEST_PORT}`, `next start.*-p ${TEST_PORT}`]) {
    await new Promise<void>((resolve) => {
      const proc = spawn("pkill", ["-f", pattern]);
      proc.on("exit", () => resolve());
      proc.on("error", () => resolve());
    });
  }
  // pkill retourne dès l'envoi du signal, pas après la sortie effective du process ciblé —
  // cette pause laisse le temps à un éventuel résiduel de terminer sa sortie et de libérer
  // le port avant le spawn suivant.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function startServer(): Promise<ChildProcess> {
  // DIAGNOSTIC TEMPORAIRE
  diagLogPortStatus("before-cleanup");
  await cleanupResidualTestServer();
  diagLogPortStatus("after-cleanup"); // DIAGNOSTIC TEMPORAIRE

  const testEnv: Record<string, string> = {};
  loadDotenv({ path: ".env.test", processEnv: testEnv });

  // Correctif ciblé — repart d'un historique vide à chaque nouveau spawn, pour que l'erreur
  // de waitForServer() (si le process meurt avant d'être prêt) ne montre jamais la sortie
  // d'un cycle de redémarrage précédent.
  recentOutputLines = [];

  const proc = spawn("npx", ["next", "dev", "-p", String(TEST_PORT)], {
    // Les variables déjà présentes dans `env` ne sont jamais écrasées par le
    // chargement interne des fichiers .env de Next.js — la base de test et le
    // secret associé restent donc bien ceux fournis ici.
    // Voir next.config.ts (turbopackFileSystemCacheForDev) : désactive le cache disque
    // Turbopack pour ce serveur uniquement.
    env: { ...process.env, ...testEnv, PORT: String(TEST_PORT), XRENT_TEST_SERVER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  diagLog("startServer-spawned", { pid: proc.pid }); // DIAGNOSTIC TEMPORAIRE

  // INC-3 (Sprint 13E tâche 2) — cause racine confirmée par profilage direct (`sample` sur le
  // process `next-server` gelé : thread principal bloqué en synchrone dans l'appel système
  // `write()`, via `node::StreamBase::WriteString`/`uv__try_write`, jamais dans du code
  // applicatif ou Prisma). `stdio: ["ignore", "pipe", "pipe"]` ci-dessus redirige `stdout` du
  // serveur vers un tube (pipe) dont la capacité est bornée par l'OS (16 Ko sur macOS) — sans
  // lecteur côté parent, ce tube n'est jamais vidé. Next.js journalise une ligne par requête
  // HTTP traitée (`GET ... 200 in Xms`) sur `stdout` ; sous le volume de requêtes de la suite
  // complète (~900 tests, largement plus que ce qu'un groupe de `scripts/test-grouped.mjs`
  // traite par serveur), ce tube finit par se remplir. Le prochain appel `write()` du process
  // enfant devient alors bloquant tant que le parent ne lit rien — gelant le thread principal
  // du serveur (mono-thread pour l'exécution JS/HTTP), d'où le blocage total observé
  // jusqu'ici. Explique aussi pourquoi le runner groupé (nouveau serveur, donc tube vide, à
  // chaque groupe de 7-8 fichiers) n'est jamais touché, et pourquoi la piste « chevauchement
  // de requêtes au démarrage »/« volume de connexions Postgres » ne l'expliquait pas (testées
  // et infirmées séparément — voir INCIDENTS.md). **Correction** : consommer `stdout` en
  // continu élimine la possibilité même que le tube se remplisse — la même primitive que celle
  // déjà en place pour `stderr` juste en dessous, jamais affichée (silencieuse par défaut, pour
  // ne pas polluer la sortie des tests), sauf motif d'erreur explicite comme pour `stderr`.
  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    diagLog("stdout", { pid: proc.pid, text }); // DIAGNOSTIC TEMPORAIRE — sortie brute complète, contrairement au filtre /error/i ci-dessous
    recordRecentOutput(text); // Correctif ciblé — alimente le tampon utilisé par waitForServer()
    if (/error/i.test(text)) {
      process.stderr.write(`[next dev test server] ${text}`);
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    diagLog("stderr", { pid: proc.pid, text }); // DIAGNOSTIC TEMPORAIRE — sortie brute complète, contrairement au filtre /error/i ci-dessous
    recordRecentOutput(text); // Correctif ciblé — alimente le tampon utilisé par waitForServer()
    if (/error/i.test(text)) {
      process.stderr.write(`[next dev test server] ${text}`);
    }
  });

  proc.once("exit", (code, signal) => {
    diagLog("startServer-process-exit", { pid: proc.pid, code, signal }); // DIAGNOSTIC TEMPORAIRE — détecte un crash précoce du process avant même waitForServer()
  });

  await waitForServer(`${TEST_BASE_URL}/`, 60_000, proc);
  return proc;
}

// ============================================================================================
// Expérience E (2026-09-04) — Groupe 4 uniquement (SERVER_MODE === "build"). buildApp() et
// startProdServer() ne sont appelées que depuis setup() ci-dessous, jamais depuis un fichier de
// test ni un worker Vitest forké (pool: "forks" — aucun fichier de test n'importe ce module).
// ============================================================================================

/**
 * `next build` unique, borné, jamais avalé en cas d'échec. Capture stdout/stderr dans un
 * tampon borné en mémoire (jamais d'écriture disque synchrone) pour un message d'erreur
 * exploitable ; le journal des événements (build-start/build-end/build-failed/build-timeout)
 * passe par `process.stderr.write`, un flux déjà consommé en continu par le process parent
 * (scripts/test-grouped.mjs), jamais bloquant.
 */
async function buildApp(): Promise<void> {
  process.stderr.write("[vitest.global-setup] build-start (mode build, Groupe 4) — npx next build\n");
  const buildStart = Date.now();
  const testEnv: Record<string, string> = {};
  loadDotenv({ path: ".env.test", processEnv: testEnv });

  const proc = spawn("npx", ["next", "build"], {
    env: { ...process.env, ...testEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let output: string[] = [];
  const recordOutput = (text: string) => {
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      output.push(line);
    }
    if (output.length > BUILD_OUTPUT_MAX_LINES) output = output.slice(-BUILD_OUTPUT_MAX_LINES);
  };
  proc.stdout?.on("data", (chunk: Buffer) => recordOutput(chunk.toString()));
  proc.stderr?.on("data", (chunk: Buffer) => recordOutput(chunk.toString()));

  const exitCode = new Promise<number | null>((resolve) => {
    proc.once("exit", (code) => resolve(code));
  });

  const timedOut = await Promise.race([
    exitCode.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), BUILD_TIMEOUT_MS)),
  ]);

  if (timedOut) {
    // Borne dure : `stopServer()` (déjà défini plus haut, générique à tout ChildProcess
    // détaché) envoie SIGTERM au groupe de processus entier (npx + next + workers de
    // compilation éventuels — `detached: true` garantit que le signal négatif sur le pid
    // atteint tout le groupe), puis SIGKILL après le délai de grâce existant si nécessaire —
    // jamais de process de build résiduel après un timeout.
    await stopServer(proc);
    const tail = output.join("\n") || "(aucune sortie capturée)";
    process.stderr.write(`[vitest.global-setup] build-timeout après ${BUILD_TIMEOUT_MS}ms\n`);
    throw new Error(
      `next build n'a pas terminé sous ${BUILD_TIMEOUT_MS}ms (mode build, Groupe 4).\n--- Dernières lignes stdout/stderr ---\n${tail}`
    );
  }

  const code = await exitCode;
  const durationMs = Date.now() - buildStart;
  if (code !== 0) {
    // Le process s'est déjà terminé de lui-même (exitCode résolu) — rien à tuer, seule
    // l'erreur explicite doit remonter, jamais masquée.
    const tail = output.join("\n") || "(aucune sortie capturée)";
    process.stderr.write(`[vitest.global-setup] build-failed code=${code} après ${durationMs}ms\n`);
    throw new Error(
      `next build a échoué (code=${code}) après ${durationMs}ms.\n--- Dernières lignes stdout/stderr ---\n${tail}`
    );
  }
  process.stderr.write(`[vitest.global-setup] build-end réussi en ${durationMs}ms\n`);
}

/** Démarre exactement un `next start -p 3811`, jamais `next dev`. Réutilise `waitForServer()`
 * (délai identique, 60s) et `recordRecentOutput()` (tampon partagé, borné) sans aucune
 * duplication. Un échec de démarrage tue explicitement le process avant de propager l'erreur —
 * `waitForServer()` elle-même ne tue jamais le process qu'elle attend (comportement partagé
 * avec le mode dev), donc ce nettoyage est nécessaire ici pour ne jamais laisser de `next
 * start` résiduel derrière un démarrage raté. */
async function startProdServer(): Promise<ChildProcess> {
  await cleanupResidualTestServer();

  const testEnv: Record<string, string> = {};
  loadDotenv({ path: ".env.test", processEnv: testEnv });

  recentOutputLines = [];

  const proc = spawn("npx", ["next", "start", "-p", String(TEST_PORT)], {
    env: { ...process.env, ...testEnv, PORT: String(TEST_PORT), XRENT_TEST_SERVER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  process.stderr.write(`[vitest.global-setup] server-start (mode build, Groupe 4) pid=${proc.pid}\n`);

  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    recordRecentOutput(text);
    if (/error/i.test(text)) {
      process.stderr.write(`[next start test server] ${text}`);
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    recordRecentOutput(text);
    if (/error/i.test(text)) {
      process.stderr.write(`[next start test server] ${text}`);
    }
  });

  proc.once("exit", (code, signal) => {
    process.stderr.write(`[vitest.global-setup] server-exit pid=${proc.pid} code=${code} signal=${signal}\n`);
  });

  try {
    await waitForServer(`${TEST_BASE_URL}/`, 60_000, proc);
  } catch (error) {
    await stopServer(proc);
    throw error;
  }
  process.stderr.write(`[vitest.global-setup] server-ready (mode build, Groupe 4) pid=${proc.pid}\n`);
  return proc;
}

async function restartServer(reason: string): Promise<void> {
  if (restarting || stopped) return;
  restarting = true;
  restartCount += 1;
  const restartStart = Date.now(); // DIAGNOSTIC TEMPORAIRE
  diagLog("restartServer-start", { restartCount, reason }); // DIAGNOSTIC TEMPORAIRE
  process.stderr.write(`[vitest.global-setup] ${reason} — redémarrage contrôlé n°${restartCount}.\n`);
  try {
    const previous = serverProcess;
    if (previous) {
      await stopServer(previous);
    }
    serverProcess = await startServer();
    consecutiveFailures = 0;
    diagLog("restartServer-success", { restartCount, totalDurationMs: Date.now() - restartStart }); // DIAGNOSTIC TEMPORAIRE
    process.stderr.write(`[vitest.global-setup] Serveur de test redémarré avec succès (n°${restartCount}).\n`);
  } catch (error) {
    diagLog("restartServer-failure", {
      restartCount,
      totalDurationMs: Date.now() - restartStart,
      error: String(error),
    }); // DIAGNOSTIC TEMPORAIRE
    process.stderr.write(`[vitest.global-setup] Échec du redémarrage du serveur de test : ${String(error)}\n`);
  } finally {
    restarting = false;
  }
}

function startHealthCheckLoop(): void {
  healthCheckTimer = setInterval(() => {
    if (restarting || stopped) return;
    const controller = new AbortController();
    inFlightHealthCheck = controller;
    const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    fetch(`${TEST_BASE_URL}/`, { signal: controller.signal })
      .then(() => {
        // Réinitialisation correcte après un health check réussi, y compris en mode build :
        // une panne transitoire déjà journalisée (ci-dessous) ne doit jamais s'accumuler avec
        // une panne future sans rapport.
        if (SERVER_MODE === "build" && consecutiveFailures > 0) {
          process.stderr.write(
            `[vitest.global-setup] health-check rétabli après ${consecutiveFailures} échec(s) (mode build, Groupe 4).\n`
          );
        }
        consecutiveFailures = 0;
      })
      .catch(() => {
        if (stopped) return;
        consecutiveFailures += 1;
        if (SERVER_MODE === "build") {
          // Sondages et diagnostics conservés à l'identique du mode dev — seule la tentative
          // de récupération automatique (restartServer) est supprimée pour le Groupe 4.
          process.stderr.write(
            `[vitest.global-setup] health-check échec n°${consecutiveFailures} (mode build, Groupe 4).\n`
          );
          if (consecutiveFailures >= CONSECUTIVE_FAILURES_BEFORE_RESTART) {
            process.stderr.write(
              `[vitest.global-setup] serveur de production injoignable depuis ${(
                (CONSECUTIVE_FAILURES_BEFORE_RESTART * HEALTH_CHECK_INTERVAL_MS) /
                1000
              ).toFixed(0)}s au moins — mode build (Groupe 4) : aucun redémarrage automatique, panne journalisée uniquement.\n`
            );
          }
          return;
        }
        if (consecutiveFailures >= CONSECUTIVE_FAILURES_BEFORE_RESTART) {
          restartPromise = restartServer(
            `INC-3 : serveur de test injoignable depuis ${(
              (CONSECUTIVE_FAILURES_BEFORE_RESTART * HEALTH_CHECK_INTERVAL_MS) /
              1000
            ).toFixed(0)}s au moins`
          );
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        if (inFlightHealthCheck === controller) inFlightHealthCheck = undefined;
      });
  }, HEALTH_CHECK_INTERVAL_MS);
  healthCheckTimer.unref();
}

/**
 * INC-27 (2026-08-30, INCIDENTS.md) : recyclage préventif du serveur de test partagé, distinct du
 * contrôle de vivacité INC-3 ci-dessus (qui ne réagit qu'à une panne déjà avérée). Ce
 * `setInterval` séparé surveille un signal posé par `recordFileCompletion()`
 * (`src/__tests__/helpers/testServerRecycling.ts`, appelée depuis `vitest.setup.ts` après chaque
 * fichier de test) — un redémarrage n'est déclenché qu'à une frontière entre deux fichiers,
 * jamais pendant l'exécution de l'un d'eux (voir le commentaire de ce module pour la garantie
 * complète). Réutilise `restartServer()` telle quelle (même verrou `restarting`, même logique
 * d'arrêt gracieux/forcé) — un redémarrage déjà en cours suite à une panne INC-3 n'est jamais
 * dupliqué. `RECYCLING_POLL_INTERVAL_MS` volontairement plus court que
 * `HEALTH_CHECK_INTERVAL_MS` : un fichier de test reste bloqué (via `recordFileCompletion()`)
 * tant que ce drapeau n'est pas retombé, un intervalle de contrôle trop long ajouterait un délai
 * inutile à chaque cycle de recyclage.
 */
const RECYCLING_POLL_INTERVAL_MS = 250;
let recyclingTimer: NodeJS.Timeout | undefined;

function startRecyclingLoop(): void {
  recyclingTimer = setInterval(() => {
    if (stopped) return;
    if (!isRestartRequested()) return;
    if (SERVER_MODE === "build") {
      // Expérience E (2026-09-04, Groupe 4 uniquement) : aucun recyclage préventif en mode
      // build — la demande est acquittée immédiatement (clearRestartRequest(), qui réinitialise
      // aussi le compteur de fichiers pour le cycle suivant) pour ne jamais laisser le fichier
      // de test appelant (recordFileCompletion(), testServerRecycling.ts) bloqué jusqu'à
      // MAX_WAIT_MS avant de lever une erreur. Le serveur de production partagé n'est jamais
      // redémarré. Ne modifie en rien le protocole pour les autres groupes (branche dev
      // ci-dessous, inchangée).
      process.stderr.write(
        "[vitest.global-setup] recyclage-ignore (mode build, Groupe 4) — demande acquittée sans redémarrage.\n"
      );
      clearRestartRequest();
      return;
    }
    if (restarting) return;
    restartPromise = restartServer(
      `INC-27 : recyclage préventif (${FILES_PER_RESTART} fichiers de test traités)`
    ).then(() => {
      clearRestartRequest();
    });
  }, RECYCLING_POLL_INTERVAL_MS);
  recyclingTimer.unref();
}

export default async function setup() {
  resetRecyclingState();
  if (SERVER_MODE === "build") {
    // Expérience E (2026-09-04) — Groupe 4 uniquement. Seul point d'appel à buildApp() dans
    // tout ce fichier : un build unique par invocation Vitest (setup() est appelée exactement
    // une fois par `vitest run`, jamais depuis un fichier de test ni un worker forké).
    await buildApp();
    serverProcess = await startProdServer();
  } else {
    serverProcess = await startServer();
  }
  startHealthCheckLoop();
  startRecyclingLoop();

  return async () => {
    stopped = true;
    if (healthCheckTimer) clearInterval(healthCheckTimer);
    if (recyclingTimer) clearInterval(recyclingTimer);
    inFlightHealthCheck?.abort();
    // Si un redémarrage est en cours, on le laisse aboutir pour connaître la référence
    // réelle du serveur final avant de l'arrêter — sinon le serveur nouvellement (re)lancé
    // en arrière-plan ne serait jamais arrêté (fuite de processus).
    if (restartPromise) await restartPromise;
    if (serverProcess) await stopServer(serverProcess);
  };
}
