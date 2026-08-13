"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Eye, Ban, FileText, Download } from "lucide-react";
import { toast } from "sonner";
import { apiPatch, apiPostDownload, ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  StatusBadge,
} from "@/components/ui";

export interface LocationRow {
  id: string;
  contractNumber: string | null;
  clientName: string;
  vehicleName: string;
  licensePlate: string;
  startDate: string;
  endDate: string;
  status: string;
  totalPrice: number;
  currency: string;
  invoiceId: string | null;
}

const CANCELLABLE_STATUSES = new Set(["PENDING", "CONFIRMED", "ACTIVE"]);

export function LocationsTable({ locations }: { locations: LocationRow[] }) {
  const router = useRouter();
  const [pendingCancel, setPendingCancel] = useState<LocationRow | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isDownloading, setIsDownloading] = useState(false);
  const [showRangeDialog, setShowRangeDialog] = useState(false);
  const [rangeMode, setRangeMode] = useState<"DATE" | "NUMBER">("DATE");
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [numberFrom, setNumberFrom] = useState("");
  const [numberTo, setNumberTo] = useState("");
  const [rangeError, setRangeError] = useState<string | null>(null);

  // Seuls les contrats numérotés (Location.contractNumber non nul) peuvent figurer dans un lot
  // PDF — voir POST /api/documents/batch-pdf, qui les exclut de toute façon côté serveur.
  const numberedLocations = useMemo(() => locations.filter((l) => l.contractNumber), [locations]);
  const allNumberedSelected =
    numberedLocations.length > 0 && numberedLocations.every((l) => selectedIds.has(l.id));

  const toggleSelected = useCallback((id: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(
    (checked: boolean) => {
      setSelectedIds(checked ? new Set(numberedLocations.map((l) => l.id)) : new Set());
    },
    [numberedLocations]
  );

  async function handleDownloadSelection() {
    if (selectedIds.size === 0) return;
    setIsDownloading(true);
    try {
      await apiPostDownload(
        "/api/documents/batch-pdf",
        { type: "CONTRACT", ids: Array.from(selectedIds) },
        "lot-contrats.pdf"
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la génération du lot PDF.");
    } finally {
      setIsDownloading(false);
    }
  }

  async function handleDownloadRange() {
    setRangeError(null);
    const body =
      rangeMode === "DATE"
        ? { type: "CONTRACT" as const, from: rangeFrom || undefined, to: rangeTo || undefined }
        : {
            type: "CONTRACT" as const,
            contractNumberFrom: Number(numberFrom),
            contractNumberTo: Number(numberTo),
          };

    if (rangeMode === "DATE" && !rangeFrom && !rangeTo) {
      setRangeError("Renseignez au moins une date.");
      return;
    }
    if (rangeMode === "NUMBER" && (!numberFrom || !numberTo)) {
      setRangeError("Renseignez les deux numéros (de/à).");
      return;
    }

    setIsDownloading(true);
    try {
      await apiPostDownload("/api/documents/batch-pdf", body, "lot-contrats.pdf");
      setShowRangeDialog(false);
    } catch (err) {
      setRangeError(err instanceof ApiError ? err.message : "Erreur lors de la génération du lot PDF.");
    } finally {
      setIsDownloading(false);
    }
  }

  async function handleCancel() {
    if (!pendingCancel) return;
    setIsCancelling(true);
    try {
      await apiPatch(`/api/locations/${pendingCancel.id}`, { status: "CANCELLED" });
      toast.success("Location annulée.");
      setPendingCancel(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de l'annulation.");
    } finally {
      setIsCancelling(false);
    }
  }

  const columns = useMemo<DataTableColumn<LocationRow>[]>(
    () => [
      {
        id: "select",
        header: () => (
          <Checkbox
            checked={allNumberedSelected}
            onCheckedChange={(checked: boolean) => toggleSelectAll(checked === true)}
            aria-label="Tout sélectionner"
          />
        ),
        cell: ({ row }) =>
          row.original.contractNumber ? (
            <Checkbox
              checked={selectedIds.has(row.original.id)}
              onCheckedChange={(checked: boolean) => toggleSelected(row.original.id, checked === true)}
              aria-label="Sélectionner ce contrat"
            />
          ) : null,
        size: 32,
      },
      {
        accessorKey: "contractNumber",
        header: "N° contrat",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      { accessorKey: "clientName", header: "Client" },
      {
        id: "vehicle",
        header: "Véhicule",
        accessorFn: (row) => `${row.vehicleName} (${row.licensePlate})`,
      },
      {
        id: "period",
        header: "Période",
        cell: ({ row }) =>
          `${new Date(row.original.startDate).toLocaleDateString("fr-FR")} → ${new Date(
            row.original.endDate
          ).toLocaleDateString("fr-FR")}`,
      },
      {
        accessorKey: "status",
        header: "Statut",
        cell: ({ getValue }) => <StatusBadge status={getValue<string>()} />,
      },
      {
        id: "totalPrice",
        header: "Total",
        cell: ({ row }) => formatMoney(row.original.totalPrice, row.original.currency),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem render={<Link href={`/dashboard/locations/${row.original.id}`} />}>
                  <Eye className="size-4" />
                  Détails
                </DropdownMenuItem>
                {row.original.invoiceId && (
                  <DropdownMenuItem render={<Link href={`/dashboard/invoices/${row.original.invoiceId}`} />}>
                    <FileText className="size-4" />
                    Voir facture
                  </DropdownMenuItem>
                )}
                {CANCELLABLE_STATUSES.has(row.original.status) && (
                  <DropdownMenuItem variant="destructive" onClick={() => setPendingCancel(row.original)}>
                    <Ban className="size-4" />
                    Annuler
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [allNumberedSelected, selectedIds, toggleSelectAll, toggleSelected]
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <p className="text-sm text-muted-foreground">{selectedIds.size} sélectionné(s)</p>
              <Button type="button" size="sm" variant="outline" disabled={isDownloading} onClick={handleDownloadSelection}>
                <Download className="size-4" />
                {isDownloading ? "Génération..." : "Télécharger le lot"}
              </Button>
            </>
          )}
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={() => setShowRangeDialog(true)}>
          <Download className="size-4" />
          Lot par période / plage de numéros
        </Button>
      </div>

      <DataTable columns={columns} data={locations} emptyMessage="Aucune location." />

      <Dialog open={Boolean(pendingCancel)} onOpenChange={(open) => !open && setPendingCancel(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Annuler la location ?</DialogTitle>
            <DialogDescription>
              La location de « {pendingCancel?.clientName} » pour « {pendingCancel?.vehicleName} » sera
              annulée. Cette action est irréversible.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingCancel(null)}>
              Retour
            </Button>
            <Button variant="destructive" onClick={handleCancel} disabled={isCancelling}>
              {isCancelling ? "Annulation..." : "Annuler la location"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRangeDialog} onOpenChange={setShowRangeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Télécharger un lot de contrats</DialogTitle>
            <DialogDescription>
              Génère un seul PDF regroupant tous les contrats correspondant à la période ou à la
              plage de numéros choisie.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={rangeMode === "DATE" ? "default" : "outline"}
                onClick={() => setRangeMode("DATE")}
              >
                Par période
              </Button>
              <Button
                type="button"
                size="sm"
                variant={rangeMode === "NUMBER" ? "default" : "outline"}
                onClick={() => setRangeMode("NUMBER")}
              >
                Par plage de numéros
              </Button>
            </div>

            {rangeMode === "DATE" ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rangeFrom">Du</Label>
                  <Input id="rangeFrom" type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rangeTo">Au</Label>
                  <Input id="rangeTo" type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="numberFrom">Numéro de</Label>
                  <Input
                    id="numberFrom"
                    type="number"
                    min={0}
                    value={numberFrom}
                    onChange={(e) => setNumberFrom(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="numberTo">Numéro à</Label>
                  <Input
                    id="numberTo"
                    type="number"
                    min={0}
                    value={numberTo}
                    onChange={(e) => setNumberTo(e.target.value)}
                  />
                </div>
              </div>
            )}

            {rangeError && (
              <p role="alert" className="text-sm text-destructive">
                {rangeError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRangeDialog(false)}>
              Annuler
            </Button>
            <Button onClick={handleDownloadRange} disabled={isDownloading}>
              {isDownloading ? "Génération..." : "Télécharger"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
