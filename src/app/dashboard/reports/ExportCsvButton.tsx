"use client";

import { Download } from "lucide-react";
import { Button, Icon } from "@/components/ui";
// Sprint 13E tâche 3 : sanitizeCsvCell/buildCsvFileContent déplacées vers src/lib/csv.ts (module
// serveur-safe, réutilisé par les nouvelles routes d'export /api/exports/[entity]) — réexportées
// ici à l'identique pour ne rien changer pour les appelants existants (ce composant, la page
// Audit, et le test unitaire src/__tests__/csv-export-sanitization.test.ts qui importe depuis ce
// même chemin).
import { sanitizeCsvCell, buildCsvFileContent } from "@/lib/csv";
export { sanitizeCsvCell, buildCsvFileContent };

interface ExportCsvButtonProps {
  filename: string;
  rows: Record<string, string | number>[];
}

export function ExportCsvButton({ filename, rows }: ExportCsvButtonProps) {
  function handleExport() {
    const blob = new Blob([buildCsvFileContent(rows)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Button type="button" variant="outline" size="sm" disabled={rows.length === 0} onClick={handleExport}>
      <Icon icon={Download} className="size-4" />
      Exporter en CSV
    </Button>
  );
}
