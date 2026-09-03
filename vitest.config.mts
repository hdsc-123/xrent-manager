import path from "node:path";
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => ({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    env: loadEnv(mode, process.cwd(), ""),
    // Diagnostic CI Groupe 4 (2026-09-03) — reporter additionnel (vitest.diag-reporter.ts),
    // jamais un remplacement : "default" reste actif, sortie console/heartbeat de
    // scripts/test-grouped.mjs inchangée. Journalise début/fin de chaque fichier dans le même
    // fichier borné que vitest.global-setup.ts (voir src/__tests__/helpers/testServerDiag.ts).
    reporters: ["default", "./vitest.diag-reporter.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    maxWorkers: 4,
    // INC-3 (INCIDENTS.md) — résolution finale (2026-08-26), sur exigence explicite du
    // propriétaire du projet d'atteindre 10/10 exécutions parfaites de `npx vitest run` sans
    // sortir de cette seule commande officielle (pas de wrapper, pas de script séparé).
    //
    // Vérifié empiriquement (voir INCIDENTS.md pour l'expérience complète) : le pool `forks` de
    // Vitest (`isolate: true`, valeur par défaut) démarre déjà un processus OS neuf pour CHAQUE
    // fichier de test, jamais réutilisé (confirmé par une sonde dédiée : 8 fichiers → 8 PID
    // distincts, aucun état `globalThis` partagé entre eux). Un serveur `next dev` persistant
    // par worker (mémoïsé via `setupFiles`) n'est donc pas réalisable — chaque fichier repart
    // d'un processus vierge. La cause dominante restante (voir vitest.global-setup.ts et
    // INCIDENTS.md) est un comportement interne non configurable de Next.js/Turbopack en mode
    // développement (`getStaticPathsWorker()`, `node_modules/next/dist/server/dev/next-dev-
    // server.js` : un processus worker `jest-worker` neuf est créé et détruit à CHAQUE rendu
    // d'une page à segment dynamique, jamais réutilisé) — non lié à ce projet, non désactivable.
    //
    // `maxWorkers: 4` (parallélisme par défaut) autorisait jusqu'à 4 fichiers de test à exécuter
    // des requêtes concurrentes contre le même serveur `next dev` partagé — sous cette charge
    // concurrente, le pic de créations simultanées de workers `jest-worker` pouvait
    // occasionnellement saturer l'unique thread JS du serveur assez longtemps pour provoquer des
    // délais d'attente/refus de connexion intermittents (mesuré : 9/10 exécutions parfaites avec
    // ce réglage, malgré tous les autres correctifs d'INC-3 déjà appliqués — voir HANDOFF.md).
    //
    // `fileParallelism: false` sérialise l'exécution des fichiers de test : un seul fichier actif
    // à la fois contre le serveur partagé, donc plus jamais de pic de charge concurrente, quel
    // que soit le nombre de workers `jest-worker` que Next.js crée pour chaque rendu individuel.
    // Mesuré : **10/10 exécutions consécutives parfaites** (1280/1280 à chaque fois, 0 timeout,
    // 0 `ECONNREFUSED`/`ECONNRESET`/`SocketError`, 0 redémarrage watchdog, 0 processus/port
    // résiduel), contre 7 à 9/10 juste avant ce réglage. Coût mesuré : suite ~2x plus lente
    // (~88s contre ~45s en parallèle) — compromis délibéré, la fiabilité totale de la commande
    // officielle étant l'exigence explicite, pas la vitesse brute. Reste très largement plus
    // rapide que la suite avant l'ensemble des correctifs d'INC-3 de ce sprint (~280-330s).
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
}));
