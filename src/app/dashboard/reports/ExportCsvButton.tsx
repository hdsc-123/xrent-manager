"use client";

import Papa from "papaparse";
import { Download } from "lucide-react";
import { Button } from "@/components/ui";

interface ExportCsvButtonProps {
  filename: string;
  rows: Record<string, string | number>[];
}

export function ExportCsvButton({ filename, rows }: ExportCsvButtonProps) {
  function handleExport() {
    const csv = Papa.unparse(rows);
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
