import "dotenv/config";
import { afterAll } from "vitest";
import { recordFileCompletion } from "./src/__tests__/helpers/testServerRecycling";

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
afterAll(async () => {
  await recordFileCompletion();
});
