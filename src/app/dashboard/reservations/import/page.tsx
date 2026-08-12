"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui";
import { RESERVATION_IMPORT_COLUMNS_CLIENT } from "./columns";

interface PreviewRow {
  row: number;
  voucherNumber: string;
  clientFirstName: string;
  clientLastName: string;
  startDate: string;
  endDate: string;
}

interface RowError {
  row: number;
  error: string;
}

interface RowDuplicate {
  row: number;
  voucherNumber: string;
}

interface ImportReport {
  imported: number;
  errors: RowError[];
  duplicates: RowDuplicate[];
  preview?: PreviewRow[];
}

async function uploadFile(file: File, mode: "preview" | "commit"): Promise<ImportReport> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("mode", mode);

  const response = await fetch("/api/reservations/import", { method: "POST", body: formData });
  const body = await response.json();
  if (!response.ok) {
    throw new ApiError(body?.error ?? `Erreur ${response.status}.`, response.status, body);
  }
  return body as ImportReport;
}

export default function ImportReservationsPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportReport | null>(null);
  const [result, setResult] = useState<ImportReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePreview() {
    if (!file) return;
    setError(null);
    setIsLoading(true);
    try {
      const report = await uploadFile(file, "preview");
      setPreview(report);
      setResult(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleConfirm() {
    if (!file) return;
    setError(null);
    setIsLoading(true);
    try {
      const report = await uploadFile(file, "commit");
      setResult(report);
      setPreview(null);
      toast.success(`${report.imported} réservation(s) importée(s).`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold">Importer des réservations (Excel)</h1>

      <Card>
        <CardHeader>
          <CardTitle>Fichier</CardTitle>
          <CardDescription>
            Fichier .xlsx, première feuille, première ligne = en-têtes exacts : {RESERVATION_IMPORT_COLUMNS_CLIENT.join(", ")}.
            Colonnes requises : voucherNumber, clientFirstName, clientLastName, startDate, endDate.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
              setResult(null);
              setError(null);
            }}
            className="text-sm"
          />

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={!file || isLoading} onClick={handlePreview}>
              {isLoading ? "Analyse..." : "Aperçu"}
            </Button>
            <Button type="button" disabled={!file || isLoading} onClick={handleConfirm}>
              {isLoading ? "Import..." : "Importer directement"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => router.push("/dashboard/reservations")}>
              Retour
            </Button>
          </div>
        </CardContent>
      </Card>

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>Aperçu</CardTitle>
            <CardDescription>
              {preview.imported} ligne(s) valide(s) prête(s) à être importées, {preview.errors.length} erreur(s),{" "}
              {preview.duplicates.length} doublon(s) ignoré(s) (voucher déjà existant).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {preview.preview && preview.preview.length > 0 && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ligne</TableHead>
                      <TableHead>Voucher</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Départ</TableHead>
                      <TableHead>Retour</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.preview.map((row) => (
                      <TableRow key={row.row}>
                        <TableCell>{row.row}</TableCell>
                        <TableCell>{row.voucherNumber}</TableCell>
                        <TableCell>
                          {row.clientFirstName} {row.clientLastName}
                        </TableCell>
                        <TableCell>{new Date(row.startDate).toLocaleDateString("fr-FR")}</TableCell>
                        <TableCell>{new Date(row.endDate).toLocaleDateString("fr-FR")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {preview.errors.length > 0 && (
              <div className="flex flex-col gap-1 text-sm text-destructive">
                {preview.errors.map((e) => (
                  <p key={e.row}>
                    Ligne {e.row} : {e.error}
                  </p>
                ))}
              </div>
            )}

            <Button type="button" disabled={isLoading || preview.imported === 0} onClick={handleConfirm}>
              {isLoading ? "Import..." : `Confirmer l'import de ${preview.imported} réservation(s)`}
            </Button>
          </CardContent>
        </Card>
      )}

      {result && (
        <Card>
          <CardHeader>
            <CardTitle>Rapport d&apos;import</CardTitle>
            <CardDescription>
              {result.imported} réservation(s) importée(s), {result.errors.length} erreur(s), {result.duplicates.length}{" "}
              doublon(s) ignoré(s).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {result.errors.length > 0 && (
              <div className="flex flex-col gap-1 text-sm text-destructive">
                {result.errors.map((e) => (
                  <p key={e.row}>
                    Ligne {e.row} : {e.error}
                  </p>
                ))}
              </div>
            )}
            {result.duplicates.length > 0 && (
              <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                {result.duplicates.map((d) => (
                  <p key={d.row}>
                    Ligne {d.row} : voucher {d.voucherNumber} déjà existant, ignoré.
                  </p>
                ))}
              </div>
            )}
            <Button type="button" onClick={() => router.push("/dashboard/reservations")}>
              Voir les réservations
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
