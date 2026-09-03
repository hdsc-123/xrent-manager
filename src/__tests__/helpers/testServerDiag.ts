import fs from "node:fs";
import path from "node:path";

/**
 * Diagnostic borné et non bloquant du serveur de test partagé (CI Groupe 4, run 33801946476,
 * 2026-09-03) — remplace l'ancien bloc « DIAGNOSTIC TEMPORAIRE » de `vitest.global-setup.ts`
 * (un `fs.appendFileSync` synchrone à chaque chunk stdout/stderr du serveur `next dev`, sans
 * plafond de taille), identifié comme source plausible de blocage de l'event loop sous charge
 * soutenue. N'écrit plus jamais la sortie brute complète du serveur (déjà couverte, bornée à
 * 20 lignes, par `recentOutputLines` dans `vitest.global-setup.ts` pour le message d'erreur de
 * `waitForServer()`) — uniquement des événements structurés, via un flux asynchrone
 * (`fs.createWriteStream`, jamais un appel `fs.*Sync`) : le thread principal n'attend jamais la
 * fin de l'écriture disque.
 *
 * Module partagé par `vitest.global-setup.ts` et `vitest.diag-reporter.ts` — les deux tournent
 * dans le même process Vitest principal (jamais dans les workers forkés par fichier de test,
 * `pool: "forks"`, `isolate: true`), donc le même module Node : un seul flux, un seul compteur
 * d'octets partagé entre les deux sources d'événements.
 */

const DIAG_FILE = path.join(process.cwd(), "next-server-diag.log");
// Événements structurés uniquement (jamais la sortie brute complète comme l'ancien bloc
// supprimé) : ce volume ne doit normalement jamais être approché sur une exécution de groupe.
const DIAG_MAX_BYTES = 2 * 1024 * 1024;
// Borne dure sur la fermeture du flux (voir closeDiagLog ci-dessous) — même philosophie que
// GRACEFUL_SHUTDOWN_TIMEOUT_MS dans vitest.global-setup.ts : jamais un blocage indéfini du
// teardown si l'événement "finish" ne survient pas pour une raison quelconque.
const CLOSE_TIMEOUT_MS = 2_000;

let stream: fs.WriteStream | undefined;
let capped = false;
// Compteur suivi côté application, incrémenté au moment de l'appel à write() — contrairement à
// `WriteStream.bytesWritten` (reflète les octets déjà flushés sur disque, pas ceux mis en file
// via write() sous pression d'écriture), ce compteur applique le plafond aux octets réellement
// soumis à l'écriture, immédiatement et de façon déterministe, indépendamment du débit disque.
let bytesQueued = 0;

function getStream(): fs.WriteStream {
  if (!stream) {
    stream = fs.createWriteStream(DIAG_FILE, { flags: "a" });
    // Best-effort strict : une erreur d'écriture (disque plein, permissions...) ne doit jamais
    // interrompre le cycle de vie réel du serveur de test — seule la visibilité en pâtirait. Un
    // stream Node sans écouteur "error" fait planter le process entier sur la moindre erreur
    // d'E/S — cet écouteur (jamais retiré) l'empêche structurellement, y compris après un appel
    // write() suivant un end() (ex. sonde de port encore en vol pendant le teardown).
    stream.on("error", () => {});
  }
  return stream;
}

/**
 * Écriture structurée et asynchrone (jamais fs.*Sync). Plafonnée à `DIAG_MAX_BYTES` cumulés
 * (comptés au moment de l'écriture, pas du flush disque — voir `bytesQueued` ci-dessus) — au-delà,
 * une seule ligne `diag-cap-reached` est écrite puis plus rien, pour ne jamais laisser le fichier
 * grossir sans borne. `diagBytes` (taille cumulée déjà soumise à l'écriture) est inclus dans
 * chaque ligne pour suivre la taille du fichier de diagnostic sans sonde périodique séparée.
 * Ne lève jamais d'exception (try/catch systématique) et ne peut jamais bloquer l'appelant
 * (write() est non bloquant ; son retour n'est pas attendu — la donnée est mise en file par
 * Node, jamais perdue silencieusement par ce module, seule l'écriture disque réelle est
 * asynchrone).
 */
export function diagLog(event: string, data: Record<string, unknown> = {}): void {
  if (capped) return;
  try {
    const s = getStream();
    if (bytesQueued >= DIAG_MAX_BYTES) {
      capped = true;
      const capLine = `${JSON.stringify({ ts: new Date().toISOString(), event: "diag-cap-reached", diagBytes: bytesQueued })}\n`;
      bytesQueued += Buffer.byteLength(capLine);
      s.write(capLine);
      return;
    }
    const line = { ts: new Date().toISOString(), event, diagBytes: bytesQueued, ...data };
    const payload = `${JSON.stringify(line)}\n`;
    bytesQueued += Buffer.byteLength(payload);
    s.write(payload);
  } catch {
    // best-effort : ne doit jamais interrompre le cycle de vie réel du serveur/du run.
  }
}

/**
 * Fermeture du flux, appelée (et attendue) depuis le teardown de `vitest.global-setup.ts`.
 * Résout une fois l'événement "finish" (écriture effectivement terminée) reçu, ou après
 * `CLOSE_TIMEOUT_MS` au plus tard — best-effort borné : ne bloque jamais indéfiniment le
 * teardown, ne lève jamais d'exception, même si l'écriture finale échoue.
 */
export function closeDiagLog(): Promise<void> {
  const s = stream;
  stream = undefined;
  if (!s) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, CLOSE_TIMEOUT_MS);
    s.once("finish", done);
    s.once("error", done);
    try {
      s.end();
    } catch {
      done();
    }
  });
}
