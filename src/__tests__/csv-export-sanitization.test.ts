import { describe, expect, it } from "vitest";
import { sanitizeCsvCell } from "@/app/dashboard/reports/ExportCsvButton";

/**
 * Sprint 16 (audit sécurité) : Papa.unparse (papaparse) n'échappe pas les préfixes
 * déclencheurs de formule Excel/LibreOffice — un champ texte libre exporté tel quel
 * (ex. nom d'utilisateur dans l'export CSV de /dashboard/audit) pourrait déclencher
 * l'exécution d'une formule à l'ouverture du fichier par l'ADMIN qui l'a exporté.
 */
describe("sanitizeCsvCell (protection injection de formule CSV)", () => {
  it("laisse un texte normal inchangé", () => {
    expect(sanitizeCsvCell("Jean Dupont")).toBe("Jean Dupont");
  });

  it("laisse un nombre inchangé", () => {
    expect(sanitizeCsvCell(42)).toBe(42);
  });

  it("laisse une chaîne vide inchangée", () => {
    expect(sanitizeCsvCell("")).toBe("");
  });

  it.each(["=cmd|'/c calc'!A1", "+1+1", "-2+3", "@SUM(A1:A2)", "\tformula", "\rformula"])(
    "préfixe d'une apostrophe une valeur commençant par un déclencheur de formule (%s)",
    (malicious) => {
      const sanitized = sanitizeCsvCell(malicious);
      expect(sanitized).toBe(`'${malicious}`);
    }
  );

  it("ne modifie pas un signe présent au milieu de la valeur", () => {
    expect(sanitizeCsvCell("Prix: -100 MAD")).toBe("Prix: -100 MAD");
  });
});
