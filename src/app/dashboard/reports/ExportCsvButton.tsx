"use client";

import Papa from "papaparse";
import { Download } from "lucide-react";
import { Button } from "@/components/ui";

interface ExportCsvButtonProps {
  filename: string;
  rows: Record<string, string | number>[];
}

// Sprint 16 (audit sécurité) : neutralise l'injection de formule CSV — un champ texte libre
// (ex. nom d'utilisateur, nom de client) commençant par =, +, -, @, tab ou retour chariot serait
// interprété comme une formule par Excel/LibreOffice à l'ouverture du fichier exporté. Préfixer
// d'une apostrophe force son interprétation en texte, comportement standard recommandé OWASP.
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

export function ExportCsvButton({ filename, rows }: ExportCsvButtonProps) {
  function handleExport() {
    const csv = Papa.unparse(sanitizeCsvRows(rows));
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Button type="button" variant="outline" size="sm" disabled={rows.length === 0} onClick={handleExport}>
      <Download className="size-4" />
      Exporter en CSV
    </Button>
  );
}
