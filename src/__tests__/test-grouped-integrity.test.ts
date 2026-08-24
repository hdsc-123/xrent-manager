import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GROUPS, computeGroupsDrift } from "../../scripts/test-grouped.mjs";

/**
 * Sprint technique 4 : TESTREPORT.md/INCIDENTS.md ont documenté pendant plusieurs sprints des
 * "suites complètes" 100% vertes obtenues via `node scripts/test-grouped.mjs`, alors que 4
 * fichiers de src/__tests__/ (36 tests — credit-notes-ui, damage-invoices-route,
 * damage-invoices-ui, icon-hydration) n'avaient jamais été ajoutés à GROUPS et n'étaient donc
 * jamais exécutés par ce runner malgré son statut de "commande recommandée pour la suite
 * complète". Ce test empêche toute régression silencieuse équivalente : il échoue dès qu'un
 * fichier de test est ajouté/renommé/supprimé sous src/__tests__/ sans mise à jour de GROUPS.
 */
describe("scripts/test-grouped.mjs — GROUPS synchronisé avec src/__tests__/", () => {
  it("ne contient aucun fichier manquant, orphelin ou dupliqué", () => {
    const { missing, orphaned, duplicated } = computeGroupsDrift(new URL("../__tests__/", import.meta.url));
    expect({ missing, orphaned, duplicated }).toEqual({ missing: [], orphaned: [], duplicated: [] });
  });

  it("couvre exactement le même ensemble de fichiers que la lecture directe du répertoire (double vérification indépendante de computeGroupsDrift)", () => {
    const actualNames = readdirSync(new URL("../__tests__/", import.meta.url))
      .filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"))
      .map((f) => f.replace(/\.test\.tsx?$/, ""))
      .sort();
    const groupedNames = GROUPS.flat().slice().sort();
    expect(groupedNames).toEqual(actualNames);
  });
});
