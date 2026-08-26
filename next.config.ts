import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Sprint de stabilisation technique (2026-08-26) — désactive le worker de validation
    // dev des « Cache Components » (`node_modules/next/dist/server/dev/next-dev-server.js`,
    // gated par `process.env.TURBOPACK && experimental.devValidationWorker !== false`).
    // Cause racine démontrée par surveillance directe des processus (`ps` en continu pendant
    // une exécution complète de la suite de tests) : ce worker se ré-instancie comme un tout
    // nouveau processus OS (`next/dist/compiled/jest-worker/processChild.js`) à chaque
    // invalidation du cache de modules (HMR/recompilation d'une route pas encore visitée) —
    // mesuré à 185 processus distincts sur une seule exécution complète (~1280 tests), au
    // rythme soutenu d'environ 3 par seconde pendant la quasi-totalité de la durée du run,
    // en concurrence directe pour le CPU avec la capacité du serveur `next dev` partagé à
    // accepter de nouvelles connexions HTTP — contributeur réel à l'instabilité réseau
    // intermittente documentée dans INCIDENTS.md (INC-3).
    // Cette validation ne concerne QUE la directive expérimentale `"use cache"`/Cache
    // Components — confirmé absente de tout le code de ce projet (`grep` exhaustif sur
    // `src/`, aucune occurrence). La désactiver ne peut donc masquer aucun comportement
    // réellement exercé par l'application ou par la suite de tests. Ce code ne s'exécute
    // jamais en production (`server/dev/next-dev-server.js` est exclusif à `next dev`,
    // jamais chargé par le serveur de production `next start`/`next build`) — build de
    // production revérifié inchangé après ce réglage.
    devValidationWorker: false,
  },
};

export default nextConfig;
