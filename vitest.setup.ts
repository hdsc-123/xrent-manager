import "dotenv/config";
import { afterAll } from "vitest";
import { recordFileCompletion, MAX_WAIT_MS } from "./src/__tests__/helpers/testServerRecycling";

/**
 * INC-27 (2026-08-30, INCIDENTS.md) : signale à `vitest.global-setup.ts` que ce fichier de test a
 * terminé — voir `src/__tests__/helpers/testServerRecycling.ts` pour le mécanisme complet de
 * recyclage préventif du serveur de test partagé (uniquement pour `npm test`, `node
 * scripts/test-grouped.mjs` bénéficie déjà de son propre redémarrage entre groupes). Sûr par
 * construction indépendamment de l'ordre relatif entre ce hook et les éventuels `afterAll` propres
 * au fichier de test (nettoyage de données, etc.) : un `afterAll`, quel qu'il soit, ne s'exécute
 * jamais avant que tous les blocs `it`/`test` du fichier — donc toute requête HTTP vers le serveur
 * partagé qu'ils contiennent — ne soient déjà résolus. Aucune requête ne peut donc jamais être en
 * vol au moment où ce hook (et l'attente de redémarrage qu'il peut déclencher) s'exécute.
 */
// Diagnostic CI Groupe 4 (run 33792747392, 2026-09-03) : un redémarrage de recyclage a mis
// jusqu'à 67 956ms à se confirmer, au-delà du hookTimeout global (60 000ms, vitest.config.mts)
// qui interrompait alors ce hook avec un message générique ("Hook timed out in 60000ms") AVANT
// que recordFileCompletion() n'ait pu aboutir ou lever sa propre erreur explicite. Timeout local
// dédié à CE hook, strictement au-dessus du budget interne déjà documenté de
// recordFileCompletion() (MAX_WAIT_MS) — ne touche à aucun autre hook ni au hookTimeout global,
// qui reste la borne voulue partout ailleurs (notamment pour détecter rapidement un blocage
// hors recyclage, comme celui encore non résolu sur `registerTenantAdmin`).
const RECORD_FILE_COMPLETION_HOOK_TIMEOUT_MS = MAX_WAIT_MS + 5_000;

afterAll(async () => {
  await recordFileCompletion();
}, RECORD_FILE_COMPLETION_HOOK_TIMEOUT_MS);
