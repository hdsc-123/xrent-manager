import Papa from "papaparse";

/**
 * Sprint 16 (audit sécurité) : neutralise l'injection de formule CSV — un champ texte libre
 * (ex. nom d'utilisateur, nom de client) commençant par =, +, -, @, tab ou retour chariot serait
 * interprété comme une formule par Excel/LibreOffice à l'ouverture du fichier exporté. Préfixer
 * d'une apostrophe force son interprétation en texte, comportement standard recommandé OWASP.
 *
 * Sprint 13E tâche 3 : déplacée depuis src/app/dashboard/reports/ExportCsvButton.tsx (qui la
 * réexporte pour compatibilité) — module serveur-safe utilisable à la fois par le bouton client
 * existant (Rapports/Audit) et par les nouvelles routes d'export serveur (src/lib/exports.ts),
 * sans dépendre d'un composant "use client". Implémentation strictement inchangée.
 */
export function sanitizeCsvCell(value: string | number): string | number {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function sanitizeCsvRows(
  rows: Record<string, string | number>[]
): Record<string, string | number>[] {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, sanitizeCsvCell(value)]))
  );
}

/**
 * Sprint 18 : BOM UTF-8 (U+FEFF) en tête du fichier — sans lui, Excel ouvert en double-clic
 * (le geste le plus probable pour un utilisateur non technique) suppose l'encodage de la
 * locale système (souvent Windows-1252) plutôt que l'UTF-8 réel du fichier, et affiche les
 * caractères accentués (noms de clients/agences) de façon illisible (mojibake). Exportée
 * (même principe que sanitizeCsvCell) pour être testée unitairement sans DOM.
 */
export function buildCsvFileContent(rows: Record<string, string | number>[]): string {
  return "﻿" + Papa.unparse(sanitizeCsvRows(rows));
}

/**
 * Divise un entier par 100 et rend une chaîne décimale à 2 décimales fixes, sans jamais passer
 * par une division flottante (contrairement à `(n / 100).toFixed(2)`) — arithmétique entière
 * uniquement (division/modulo), donc exacte pour toute valeur représentable en `number`, sans
 * risque d'arrondi flottant. Partagée par `formatAmountForCsv` (montants) et
 * `formatPercentFromBasisPoints` (taux) ci-dessous — même opération arithmétique (÷100), deux
 * significations métier distinctes.
 */
function divideBy100ToFixedDecimalString(value: number): string {
  const negative = value < 0;
  const abs = Math.abs(Math.trunc(value));
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;
  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(2, "0")}`;
}

/**
 * Sprint 13E tâche 3 : conversion entier-centimes → chaîne décimale pour l'export CSV — les
 * montants financiers sont toujours des entiers dans la plus petite unité monétaire
 * (DOMAINRULES.md section 14), jamais représentés en flottant.
 */
export function formatAmountForCsv(amountInSmallestUnit: number): string {
  return divideBy100ToFixedDecimalString(amountInSmallestUnit);
}

/**
 * Sprint 13E tâche 3 (correctif) : `Invoice.taxRate` est stocké en points de base (ex. `2000` =
 * 20,00 %, `TAX_RATE_BASIS = 10_000` dans src/lib/invoices.ts — 1 point de pourcentage = 100
 * points de base) — jamais un pourcentage déjà réduit. La première version de l'export invoices
 * exportait la valeur brute (`2000`) sous une colonne nommée "tauxTVAPourcent", ce qui aurait
 * affiché 2000 % au lieu de 20 % à quiconque lit le fichier — corrigé ici. Contrairement à
 * `formatAmountForCsv` (toujours 2 décimales fixes, ex. "50.00"), un taux affiche une décimale
 * "propre" (zéros de fin retirés : 20,00 % → "20", 7,50 % → "7.5") — plus lisible pour un taux
 * de TVA, dont la partie décimale est très généralement nulle. `null`/`undefined`/`NaN` (jamais
 * produits par le schéma actuel — `taxRate` est un `Int` non nul par défaut à 0 — mais le type
 * de la fonction les accepte pour rester défensif) rendent une chaîne vide, même convention que
 * les autres cellules nullables de l'export (voir `cell()`, src/lib/exports.ts).
 */
export function formatPercentFromBasisPoints(basisPoints: number | null | undefined): string {
  if (basisPoints === null || basisPoints === undefined || Number.isNaN(basisPoints)) {
    return "";
  }
  const fixed = divideBy100ToFixedDecimalString(basisPoints);
  return fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/**
 * Sprint 13E tâche 3 : format de date stable/reparsable pour l'export CSV — ISO 8601 (UTC),
 * même choix que l'export Audit existant (`new Date(log.createdAt).toISOString()`), préféré à un
 * format localisé fr-FR (non reparsable de façon fiable, ambigu selon les paramètres régionaux
 * du tableur qui rouvre le fichier).
 */
export function formatDateForCsv(date: Date): string {
  return date.toISOString();
}
