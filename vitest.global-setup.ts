import { spawn, type ChildProcess } from "node:child_process";
import { config as loadDotenv } from "dotenv";
import { TEST_BASE_URL, TEST_PORT } from "./src/__tests__/helpers/testServer";
import {
  resetRecyclingState,
  isRestartRequested,
  clearRestartRequest,
  FILES_PER_RESTART,
} from "./src/__tests__/helpers/testServerRecycling";

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

let serverProcess: ChildProcess | undefined;
let healthCheckTimer: NodeJS.Timeout | undefined;
let restarting = false;
let consecutiveFailures = 0;
let restartCount = 0;
let stopped = false;
let inFlightHealthCheck: AbortController | undefined;
let restartPromise: Promise<void> | undefined;

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        return;
      }
    } catch {
      // Le serveur n'écoute pas encore — on réessaie.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Le serveur Next.js de test n'a pas démarré sous ${timeoutMs}ms.`);
}

async function stopServer(proc: ChildProcess): Promise<void> {
  if (!proc.pid) return;
  const pid = proc.pid;
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
  });
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return; // déjà arrêté
  }
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), GRACEFUL_SHUTDOWN_TIMEOUT_MS)),
  ]);
  if (timedOut) {
    // Le serveur est bloqué (voir INC-3) et n'a pas réagi à SIGTERM à temps — arrêt forcé.
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
  // aucune chance au teardown de ce fichier de s'exécuter — le serveur `next dev` détaché
  // (voir startServer plus bas) peut alors survivre indéfiniment et bloquer le port de test
  // au prochain lancement (EADDRINUSE). Nettoyage préventif idempotent avant chaque spawn,
  // pattern strictement borné au port de test (jamais le port 3000 de développement).
  // Complémentaire au filet de sécurité déjà présent dans scripts/test-grouped.mjs, pas un
  // remplacement.
  await new Promise<void>((resolve) => {
    const proc = spawn("pkill", ["-f", `next dev.*-p ${TEST_PORT}`]);
    proc.on("exit", () => resolve());
    proc.on("error", () => resolve());
  });
  // pkill retourne dès l'envoi du signal, pas après la sortie effective du process ciblé —
  // cette pause laisse le temps à un éventuel résiduel de terminer sa sortie et de libérer
  // le port avant le spawn suivant.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function startServer(): Promise<ChildProcess> {
  await cleanupResidualTestServer();

  const testEnv: Record<string, string> = {};
  loadDotenv({ path: ".env.test", processEnv: testEnv });

  const proc = spawn("npx", ["next", "dev", "-p", String(TEST_PORT)], {
    // Les variables déjà présentes dans `env` ne sont jamais écrasées par le
    // chargement interne des fichiers .env de Next.js — la base de test et le
    // secret associé restent donc bien ceux fournis ici.
    env: { ...process.env, ...testEnv, PORT: String(TEST_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

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
    if (/error/i.test(text)) {
      process.stderr.write(`[next dev test server] ${text}`);
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (/error/i.test(text)) {
      process.stderr.write(`[next dev test server] ${text}`);
    }
  });

  await waitForServer(`${TEST_BASE_URL}/`, 60_000);
  return proc;
}

async function restartServer(reason: string): Promise<void> {
  if (restarting || stopped) return;
  restarting = true;
  restartCount += 1;
  process.stderr.write(`[vitest.global-setup] ${reason} — redémarrage contrôlé n°${restartCount}.\n`);
  try {
    const previous = serverProcess;
    if (previous) {
      await stopServer(previous);
    }
    serverProcess = await startServer();
    consecutiveFailures = 0;
    process.stderr.write(`[vitest.global-setup] Serveur de test redémarré avec succès (n°${restartCount}).\n`);
  } catch (error) {
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
        consecutiveFailures = 0;
      })
      .catch(() => {
        if (stopped) return;
        consecutiveFailures += 1;
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
    if (stopped || restarting) return;
    if (!isRestartRequested()) return;
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
  serverProcess = await startServer();
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
