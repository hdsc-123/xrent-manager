/**
 * Sprint de stabilisation technique (2026-08-26) — coût bcrypt centralisé, configurable
 * uniquement pour l'environnement de test (`BCRYPT_COST` dans `.env.test`, absent de `.env`).
 *
 * Cause racine démontrée par profilage CPU réel (V8 `--cpu-prof`) du serveur `next dev` de test
 * partagé : 62,5 % du temps CPU total échantillonné était passé dans `_encipher` (le chiffrement
 * Blowfish de `bcryptjs`, implémentation pure JavaScript sans binding natif — tout son calcul
 * s'exécute sur l'unique thread JS du serveur, en concurrence directe avec sa capacité à accepter
 * de nouvelles connexions HTTP). Au coût 12 (4096 tours Blowfish), et sous la charge concurrente
 * de la suite complète (`maxWorkers: 4`, la quasi-totalité des ~50 fichiers de test créent et
 * connectent au moins un utilisateur dans leur `beforeAll`), ce calcul sature suffisamment
 * l'unique cœur JS pour provoquer les micro-blocages intermittents (~200ms à 1s, confirmés en
 * direct) à l'origine de l'instabilité réseau résiduelle de `npx vitest run` (INCIDENTS.md, INC-3).
 *
 * `BCRYPT_COST` n'affecte **jamais** la production : absent de `.env`/`.env.local`, la valeur par
 * défaut (12, coût de production standard, inchangé) s'applique automatiquement. Une valeur
 * absente, non numérique, ou hors de la plage valide de bcrypt (4 à 31) retombe silencieusement
 * sur ce même défaut de 12 — jamais une erreur au démarrage, jamais un coût plus faible que prévu
 * par accident de configuration.
 *
 * Fichier dédié, volontairement sans aucune dépendance vers `@/lib/auth` (qui initialise
 * `NextAuth(...)`, lequel importe `next/server` — indisponible hors du runtime Next.js réel) :
 * `src/lib/invitations.ts`/`src/lib/users.ts` et leurs tests importent directement ce fichier
 * indépendamment, sans jamais tirer NextAuth dans leur graphe de dépendances.
 */
const DEFAULT_BCRYPT_COST = 12;
const MIN_BCRYPT_COST = 4;
const MAX_BCRYPT_COST = 31;

function resolveBcryptCost(): number {
  const raw = process.env.BCRYPT_COST;
  if (!raw) return DEFAULT_BCRYPT_COST;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_BCRYPT_COST || parsed > MAX_BCRYPT_COST) {
    return DEFAULT_BCRYPT_COST;
  }
  return parsed;
}

export const BCRYPT_COST = resolveBcryptCost();
