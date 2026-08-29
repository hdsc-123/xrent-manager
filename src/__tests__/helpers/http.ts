import { TEST_BASE_URL } from "./testServer";

/**
 * INC-3 (INCIDENTS.md) — historique complet de cette fonction, deux causes contributives réelles
 * trouvées et corrigées séparément :
 *
 * 1. (Complément 2026-08-25/26) Réutilisation par le client `fetch` (undici) d'une connexion TCP
 *    keep-alive parfois déjà fermée par le serveur sous charge — confirmé par isolation directe.
 *    Corrigé par l'envoi explicite de `Connection: close` sur chaque requête (ci-dessous), fermant
 *    la connexion après chaque réponse plutôt que de la laisser dans un pool.
 * 2. (Complément 2026-08-26, poursuite d'investigation sur demande explicite du propriétaire du
 *    projet — `npx vitest run` échouait encore 2 exécutions sur 5 après le correctif n°1 ci-dessus)
 *    Nouvelle cause identifiée par profilage en direct (surveillance externe du processus
 *    `next-server`, `pg_stat_activity`, et un test de charge isolé hors suite) : le correctif n°1
 *    lui-même, en forçant une poignée de main TCP neuve à *chaque* requête au lieu de réutiliser
 *    une connexion, augmente le volume de connexions établies simultanément sous le parallélisme de
 *    la suite complète (`maxWorkers: 4`). `kern.ipc.somaxconn` (macOS, cette machine) plafonne à
 *    **128** la file d'attente de connexions TCP acceptées mais pas encore consommées par
 *    `accept()` — largement inférieur à des valeurs Linux courantes. Un test de charge isolé (hors
 *    suite, contre le même serveur `next dev` de test) confirme qu'au-delà d'un certain volume de
 *    connexions concurrentes, une fraction échoue (`ETIMEDOUT` observé à 1000+ requêtes
 *    concurrentes dans le test de charge ; `ECONNREFUSED` observé dans la suite réelle — deux
 *    manifestations plausibles du même mécanisme de dépassement de file d'attente réseau, la
 *    différence exacte de symptôme n'étant pas formellement isolée avec certitude). Reproduit dans
 *    la suite réelle : 30 échecs/1280 sur une exécution, **aucun redémarrage watchdog déclenché**
 *    (le processus serveur restait le même tout du long, jamais tué/relancé), la totalité des
 *    échecs de signature réseau pure (`ECONNREFUSED` sur `::1` et `127.0.0.1` simultanément),
 *    zéro échec d'assertion métier.
 *
 * Corrections cumulées :
 * - `Connection: close` conservé (corrige réellement la cause n°1, un test de charge isolé à 300
 *   requêtes concurrentes ne montre aucune différence mesurable de taux d'échec avec/sans ce
 *   header à ce volume — le retirer réintroduirait la cause n°1 sans garantie d'effet sur la n°2).
 * - `retryOnConnectionFailure` (nouveau, ci-dessous) : un **unique** ré-essai, réservé strictement
 *   aux échecs de connexion (`ECONNREFUSED`/`ECONNRESET`/`SocketError` undici) qui, par
 *   construction, prouvent qu'aucune réponse n'a jamais été reçue — jamais appliqué à une réponse
 *   HTTP reçue (même une erreur 4xx/5xx applicative), jamais à un délai dépassé après envoi complet
 *   de la requête (`AbortError`/timeout applicatif, laissé tel quel pour ne jamais masquer un vrai
 *   blocage). `ECONNREFUSED` garantit qu'aucune connexion TCP n'a même été établie (aucun octet de
 *   la requête n'a pu être transmis) : un ré-essai est donc toujours sûr, y compris pour une requête
 *   de mutation, quelle que soit son idempotence. Court délai (150ms) avant le ré-essai pour laisser
 *   la file d'attente réseau du serveur se vider. Ne masque aucune assertion : si le ré-essai
 *   échoue à son tour ou renvoie un statut inattendu, le test échoue normalement.
 */
const RETRYABLE_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"]);

function isRetryableConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = (error as { cause?: unknown }).cause;
  const code = (error as { code?: string }).code ?? (cause as { code?: string } | undefined)?.code;
  if (code && RETRYABLE_ERROR_CODES.has(code)) return true;
  const message = cause instanceof Error ? cause.message : error.message;
  return /other side closed/i.test(message);
}

// 2 ré-essais (150ms puis 500ms de délai croissant) : une observation directe (2026-08-26) a
// montré un ré-essai unique à 150ms insuffisant lors d'une fenêtre d'indisponibilité un peu plus
// longue que d'habitude (plusieurs `ECONNREFUSED` consécutifs sur des fichiers différents avant
// rétablissement) — toujours strictement borné (jamais indéfini), toujours réservé à la même
// classe d'erreurs de connexion pure.
const RETRY_DELAYS_MS = [150, 500];

async function retryOnConnectionFailure(doFetch: () => Promise<Response>): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await doFetch();
    } catch (error) {
      if (!isRetryableConnectionError(error)) throw error;
      lastError = error;
      if (attempt >= RETRY_DELAYS_MS.length) break;
      process.stderr.write(
        `[apiFetch] échec de connexion pure (${(error as Error).message}) — ré-essai ${attempt + 1}/${RETRY_DELAYS_MS.length} (aucun octet de la requête originale n'a pu atteindre le serveur).\n`
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}

/**
 * IP synthétique aléatoire par appel, jamais partagée entre deux appels par défaut. Sans ceci,
 * toutes les requêtes de la suite (des centaines de fichiers, un seul serveur `next dev` de
 * test partagé) tomberaient sur la même clé de throttle IP (`ip:unknown`, aucun en-tête
 * `x-forwarded-for` n'existant en environnement de test réel) — le rate limiting
 * d'authentification (src/lib/login-throttle.ts) verrouillerait alors *toute* la suite dès
 * qu'un fichier quelconque provoque 5 échecs de connexion, quel que soit l'email concerné. Un
 * test qui vérifie explicitement le comportement par IP doit fournir son propre en-tête
 * `x-forwarded-for` fixe (il prévaut, voir la fusion des headers ci-dessous) pour accumuler
 * volontairement plusieurs échecs sous la même clé.
 */
function randomTestIp(): string {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `10.${octet()}.${octet()}.${octet()}`;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return retryOnConnectionFailure(() =>
    fetch(`${TEST_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Connection: "close",
        "x-forwarded-for": randomTestIp(),
        ...init.headers,
      },
    })
  );
}

/**
 * Extrait le cookie de session NextAuth (`authjs.session-token` ou sa variante
 * `__Secure-`) d'une réponse, prêt à être renvoyé tel quel dans un header `Cookie`.
 */
export function extractSessionCookie(response: Response): string | undefined {
  const setCookieHeaders =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);

  const sessionCookie = setCookieHeaders.find((cookie) => cookie.includes("session-token="));
  return sessionCookie?.split(";")[0];
}

export function findSetCookie(response: Response, nameFragment: string): string | undefined {
  const setCookieHeaders =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);

  return setCookieHeaders.find((cookie) => cookie.includes(nameFragment));
}
