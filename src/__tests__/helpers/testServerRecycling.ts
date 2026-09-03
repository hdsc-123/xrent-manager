import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEST_PORT } from "./testServer";

/**
 * INC-27 (2026-08-30, voir INCIDENTS.md) : recyclage préventif du serveur `next dev` de test
 * partagé pour `npm test` (`vitest run` brut, un seul serveur pour toute la suite, jamais
 * redémarré) — même principe que `scripts/test-grouped.mjs` (« recyclage préventif entre
 * groupes »), qui restait la seule commande bénéficiant de ce mécanisme jusqu'ici. Mesuré
 * directement (2026-08-30) : le serveur partagé grossit vite et continûment sous charge soutenue
 * (RSS ~4,0 Go → ~6,6 Go en ~76s sur une machine de développement) — cause déjà documentée dans
 * `vitest.global-setup.ts` (INC-3) comme un comportement interne non configurable de Next.js/
 * Turbopack en mode développement (`getStaticPathsWorker()`, un processus `jest-worker` neuf créé
 * et détruit à chaque rendu d'une page à segment dynamique, jamais réutilisé), jamais corrigible
 * côté code applicatif. `node scripts/test-grouped.mjs` y échappe structurellement (nouveau
 * serveur à chaque groupe) ; `npm test` (aucun redémarrage sur toute la durée du run, suite ayant
 * grossi de ~22% depuis la clôture d'INC-3) y était exposé.
 *
 * Coordination entre deux processus OS distincts (le process principal de Vitest, qui exécute
 * `vitest.global-setup.ts` et possède la référence du serveur enfant, et chaque fichier de test,
 * exécuté dans son propre process forké — `pool: "forks"`, `isolate: true`, confirmé par sonde
 * dédiée lors d'INC-3) : un fichier JSON partagé sur disque (répertoire temporaire du système,
 * jamais dans le dépôt). Sûr par construction, sans verrou dédié : `fileParallelism: false`
 * (vitest.config.mts) garantit qu'un seul fichier de test est actif à la fois, donc un seul
 * écrivain possible à tout instant pour `recordFileCompletion`/`waitForRestartToClear` ci-dessous.
 */

interface RecyclingState {
  completedFiles: number;
  restartRequested: boolean;
}

const STATE_FILE = path.join(os.tmpdir(), `xrent-manager-vitest-server-recycle-${TEST_PORT}.json`);

/** Nombre de fichiers de test traités entre deux redémarrages préventifs. Réduit de 10 à 5
 * (diagnostic CI Groupe 4, run 33690805468, 2026-09-03) : les 10 fichiers de ce groupe passent
 * tous individuellement, avec un serveur neuf chacun (aucun gel constaté en isolation), mais le
 * groupe complet gèle de façon intermittente en CI — cohérent avec une dégradation cumulative
 * du serveur partagé sur plusieurs fichiers consécutifs (même classe qu'INC-27), jamais
 * reproduite en isolation. Un seuil plus bas réduit la fenêtre d'exposition avant recyclage,
 * sans changer aucun timeout ni comportement de test. */
export const FILES_PER_RESTART = 5;

const POLL_INTERVAL_MS = 250;
/** Borne large mais finie — un dépassement signale un défaut réel du mécanisme de recyclage
 * lui-même (jamais une attente silencieuse indéfinie, voir le commentaire de garde ci-dessous).
 * Alignée sur le budget réel de restartServer() (vitest.global-setup.ts) : jusqu'à
 * GRACEFUL_SHUTDOWN_TIMEOUT_MS (5s, arrêt gracieux avant SIGKILL) + jusqu'à 60s pour
 * waitForServer() au redémarrage, soit ~65s de budget légitime — 70s laisse une marge de
 * sécurité au-dessus de ce maximum théorique (diagnostic CI Groupe 4, run 33747296858,
 * 2026-09-03 : un redémarrage a mis 63,7s à se confirmer, alors que 30s le signalaient déjà,
 * à tort, comme un échec). */
const MAX_WAIT_MS = 70_000;

function readState(): RecyclingState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { completedFiles: 0, restartRequested: false };
  }
}

function writeState(state: RecyclingState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

/** Appelée une seule fois par `vitest.global-setup.ts`, avant tout fichier de test — repart
 * toujours d'un état propre (un run précédent interrompu ne doit jamais laisser de résidu). */
export function resetRecyclingState(): void {
  writeState({ completedFiles: 0, restartRequested: false });
}

/**
 * Appelée par chaque fichier de test (`vitest.setup.ts`, `afterAll`) une fois ses propres tests
 * terminés. Incrémente le compteur partagé ; si le seuil est atteint, pose le drapeau
 * `restartRequested` et **attend** que `vitest.global-setup.ts` l'ait effectivement traité
 * (drapeau retombé à `false`) avant de rendre la main — Vitest ne démarre le fichier suivant
 * qu'une fois ce hook résolu, garantissant qu'aucune requête ne peut jamais être en vol pendant
 * le redémarrage (fenêtre sûre par construction, jamais un minutage arbitraire).
 */
export async function recordFileCompletion(): Promise<void> {
  const state = readState();
  state.completedFiles += 1;

  if (state.completedFiles < FILES_PER_RESTART) {
    writeState(state);
    return;
  }

  state.restartRequested = true;
  writeState(state);

  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (!readState().restartRequested) {
      return;
    }
  }

  // Ne jamais masquer un mécanisme de recyclage lui-même défaillant en continuant
  // silencieusement — un dépassement ici est un vrai défaut (global-setup n'a pas traité la
  // demande), pas une simple lenteur à absorber.
  throw new Error(
    `[testServerRecycling] Le redémarrage préventif du serveur de test n'a pas été confirmé sous ${MAX_WAIT_MS}ms.`
  );
}

/** Appelée par `vitest.global-setup.ts` (boucle de surveillance dédiée, indépendante du contrôle
 * de vivacité INC-3 existant) : indique si un redémarrage a été demandé par un fichier de test. */
export function isRestartRequested(): boolean {
  return readState().restartRequested;
}

/** Appelée par `vitest.global-setup.ts` une fois le redémarrage effectivement terminé — débloque
 * le fichier de test en attente (voir `recordFileCompletion` ci-dessus) et réinitialise le
 * compteur pour le prochain cycle. */
export function clearRestartRequest(): void {
  writeState({ completedFiles: 0, restartRequested: false });
}
