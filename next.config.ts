import type { NextConfig } from "next";

// Phase 5 (2026-08-31, mode livraison efficace) — en-têtes de sécurité HTTP, absents avant
// cette phase (aucune occurrence de Content-Security-Policy/X-Frame-Options/etc. dans tout le
// code, vérifié par grep exhaustif). Portée volontairement globale (`source: "/:path*"`,
// pages ET routes API) : Next.js applique `headers()` avant le système de fichiers (routes
// comprises), donc une seule déclaration couvre tout — voir
// node_modules/next/dist/docs/.../headers.md.
//
// `isDev`/`isProd` dérivés de NODE_ENV, jamais d'une variable d'environnement séparée : c'est
// la même distinction déjà utilisée ailleurs dans ce fichier (devValidationWorker) et dans
// scripts/env-guard.js, et elle correspond exactement à la réalité d'exécution (`next dev` et
// le serveur `next dev` de test de la suite Vitest tournent tous deux en `development` ; seul
// `next build` + `next start` passe en `production`).
const isDev = process.env.NODE_ENV === "development";
const isProd = process.env.NODE_ENV === "production";

// CSP adaptée au projet (pas un gabarit générique) : vérifié par grep exhaustif qu'aucun script
// tiers, aucune police/CDN externe (next/font/google auto-héberge les fichiers de police au
// build, aucune requête runtime vers Google) et aucun dangerouslySetInnerHTML n'existent dans
// ce projet. `'unsafe-eval'` n'est donc jamais nécessaire en production (React ne l'utilise
// qu'en développement, pour reconstruire les piles d'erreur — voir la doc CSP Next.js) ;
// conservé en dev uniquement pour ne pas casser le fonctionnement local (objectif 10).
//
// `'unsafe-inline'` sur script-src et style-src, en revanche, est nécessaire dans TOUTE
// configuration sans nonce (dev ET prod) — approche "Without Nonces" documentée telle quelle
// par Next.js (node_modules/next/dist/docs/.../content-security-policy.md), retenue ici plutôt
// que l'approche à nonce (proxy + rendu dynamique forcé sur toutes les pages, y compris
// /login qui est aujourd'hui statique — changement d'architecture plus large, hors périmètre
// de cet audit). Vérifié empiriquement (`next build && next start`, page /login) : sans
// `'unsafe-inline'` sur script-src, le script inline de streaming RSC que Next.js injecte lui
// -même dans le HTML (`self.__next_f.push(...)`, nécessaire à l'hydratation) est bloqué par le
// CSP — la page rend une coquille vide (React error #412, hydratation avortée). Aucun style
// inline dans le DOM applicatif réel (seuls les 2 `style={{...}}` du dépôt sont dans des
// gabarits @react-pdf/renderer, qui ne produisent jamais de HTML/DOM), mais `'unsafe-inline'`
// est conservé aussi sur style-src par cohérence avec la même recommandation officielle et
// pour ne pas dépendre d'un futur inline injecté par Next.js lui-même. Compromis documenté
// dans SECURITY.md : script-src reste borné à 'self' (aucune origine externe autorisée), ce qui
// bloque l'essentiel du risque réel pour ce projet (aucun script tiers nulle part) ; seule
// l'injection *inline* n'est plus bloquée par le CSP lui-même (mitigée par ailleurs : aucun
// dangerouslySetInnerHTML, entrées utilisateur toujours rendues via React, jamais concaténées
// en HTML brut).
const cspHeader = `
  default-src 'self';
  script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""};
  style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data:;
  font-src 'self';
  connect-src 'self';
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'none';
  ${isProd ? "upgrade-insecure-requests;" : ""}
`
  .replace(/\s{2,}/g, " ")
  .trim();

const securityHeaders = [
  { key: "Content-Security-Policy", value: cspHeader },
  // Superflu en présence de `frame-ancestors 'none'` pour les navigateurs récents, conservé en
  // complément pour les clients qui ne supportent que l'en-tête historique (objectif 4 : "l'un
  // OU l'autre, de façon cohérente" — ici les deux, avec la même politique : refus total).
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // "strict-origin-when-cross-origin" : URL complète envoyée en same-origin (nécessaire, ex.
  // navigation interne au dashboard), seule l'origine (jamais le chemin, potentiellement
  // porteur d'identifiants métier — /dashboard/clients/<id>) en cross-origin.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Aucune API (caméra/micro/géolocalisation/USB/paiement) utilisée nulle part dans ce projet
  // (vérifié par grep exhaustif : getUserMedia, navigator.geolocation, mediaDevices, capture) —
  // tout est donc désactivé, y compris pour les iframes tierces (il n'y en a aucune).
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
  // Uniquement en production : sous HTTP (dev local, serveur `next dev` de test), le
  // navigateur ignore de toute façon cet en-tête (RFC 6797 §8.1, un canal non sécurisé ne peut
  // pas l'établir) — mais ne jamais l'envoyer en développement évite toute confusion si un test
  // HTTPS local (ex. mkcert) est un jour mis en place (objectif 2 : "uniquement sous
  // HTTPS/environnement approprié"). `preload` volontairement omis : aucune soumission à la
  // liste de préchargement HSTS n'a été demandée par le propriétaire du projet, et cette
  // décision engagerait tous les sous-domaines de façon quasi irréversible.
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
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
    // Diagnostic Groupe 4 CI (2026-09-03, INCIDENTS.md) : désactive le cache disque Turbopack
    // UNIQUEMENT pour le serveur `next dev` de test (XRENT_TEST_SERVER, injecté par
    // vitest.global-setup.ts) — `npm run dev` en local n'est jamais concerné et conserve le
    // cache persistant entre redémarrages.
    turbopackFileSystemCacheForDev: !process.env.XRENT_TEST_SERVER,
  },
};

export default nextConfig;
