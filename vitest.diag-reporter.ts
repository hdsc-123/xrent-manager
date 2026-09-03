import type { Reporter, TestModule } from "vitest/node";
import { diagLog } from "./src/__tests__/helpers/testServerDiag";

/**
 * Reporter Vitest dédié au diagnostic CI Groupe 4 (run 33801946476, 2026-09-03) — expose, dans
 * le même journal borné que `vitest.global-setup.ts` (voir `testServerDiag.ts`), le timestamp de
 * début/fin de CHAQUE fichier de test. Cette information était absente jusqu'ici côté serveur :
 * seule la fin d'un fichier était visible indirectement via le heartbeat de
 * `scripts/test-grouped.mjs`, dans un fichier séparé, non corrélable finement avec les
 * événements du serveur de test partagé (health check, recyclage). API officielle
 * `onTestModuleStart`/`onTestModuleEnd` (confirmée dans `node_modules/vitest` 4.1.10,
 * `dist/chunks/reporters.d.*.d.ts`) — tourne dans le même process Vitest principal que
 * `globalSetup` (jamais dans les workers forkés par fichier, `pool: "forks"`), d'où le partage
 * du même flux/compteur d'octets. N'est jamais importé par un fichier de test métier — déclaré
 * uniquement dans `test.reporters` (`vitest.config.mts`), en complément du reporter `"default"`
 * (sortie console inchangée, donc parsing heartbeat de `scripts/test-grouped.mjs` inchangé).
 */
export default class DiagReporter implements Reporter {
  onTestModuleStart(testModule: TestModule): void {
    diagLog("file-start", { file: testModule.moduleId });
  }

  onTestModuleEnd(testModule: TestModule): void {
    diagLog("file-end", { file: testModule.moduleId });
  }
}
