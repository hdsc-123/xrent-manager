import { spawn, type ChildProcess } from "node:child_process";
import { config as loadDotenv } from "dotenv";
import { TEST_BASE_URL, TEST_PORT } from "./src/__tests__/helpers/testServer";

/**
 * Les routes app/api/** appellent NextAuth (`auth()`), qui utilise `next/headers` en
 * interne — cette API ne fonctionne que dans le contexte d'une vraie requête servie par
 * Next.js (vérifié : un appel direct depuis Vitest lève "headers was called outside a
 * request scope"). Les tests d'intégration démarrent donc un vrai serveur `next dev`,
 * pointé sur la base de test dédiée (`xrent_test`, voir .env.test), et lui envoient de
 * vraies requêtes HTTP.
 */
let serverProcess: ChildProcess | undefined;

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

export default async function setup() {
  const testEnv: Record<string, string> = {};
  loadDotenv({ path: ".env.test", processEnv: testEnv });

  serverProcess = spawn("npx", ["next", "dev", "-p", String(TEST_PORT)], {
    // Les variables déjà présentes dans `env` ne sont jamais écrasées par le
    // chargement interne des fichiers .env de Next.js — la base de test et le
    // secret associé restent donc bien ceux fournis ici.
    env: { ...process.env, ...testEnv, PORT: String(TEST_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  serverProcess.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (/error/i.test(text)) {
      process.stderr.write(`[next dev test server] ${text}`);
    }
  });

  await waitForServer(`${TEST_BASE_URL}/`, 60_000);

  return async () => {
    if (serverProcess?.pid) {
      try {
        process.kill(-serverProcess.pid, "SIGTERM");
      } catch {
        // Processus déjà arrêté.
      }
    }
  };
}
