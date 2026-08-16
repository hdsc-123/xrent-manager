"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { MoreHorizontal, Eye, Download } from "lucide-react";
import { toast } from "sonner";
import { apiPostDownload, ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";
import {
  Badge,
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
} from "@/components/ui";

export interface InvoiceRow {
  id: string;
  /** Sprint 33 (DOMAINRULES.md section 48) — distingue une facture locative (Invoice) d'une
   * facture de dégâts (DamageInvoice), jamais mélangées dans un calcul, seulement affichées côte
   * à côte pour la recherche transversale. Une ligne DEGAT s'ouvre toujours dans son écran
   * dédié (/dashboard/damage-invoices/[id]) et n'est jamais sélectionnable pour le lot PDF
   * (/api/documents/batch-pdf ne gère que les factures locatives). */
  type: "LOCATION" | "DEGAT";
  number: string;
  contractNumber: string | null;
  clientName: string;
  status: string;
  issuedAt: string;
  totalAmount: number;
  amountPaid: number;
  currency: string;
  /** Sprint 26E : versionnement documentaire — 1 pour une facture jamais versionnée (toujours 1
   * pour une DamageInvoice, qui n'a pas de versionnement). */
  versionNumber: number;
}

const TYPE_LABELS: Record<InvoiceRow["type"], string> = {
  LOCATION: "Location",
  DEGAT: "Dégât",
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Brouillon",
  SENT: "Envoyée",
  PARTIALLY_PAID: "Partiellement payée",
  PAID: "Payée",
  CANCELLED: "Annulée",
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  DRAFT: "outline",
  SENT: "secondary",
  PARTIALLY_PAID: "secondary",
  PAID: "default",
  CANCELLED: "destructive",
};

export function InvoicesTable({ invoices }: { invoices: InvoiceRow[] }) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isDownloading, setIsDownloading] = useState(false);
  const [showRangeDialog, setShowRangeDialog] = useState(false);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [rangeError, setRangeError] = useState<string | null>(null);

  // Sprint 33 : seules les factures locatives sont sélectionnables pour le lot PDF
  // (/api/documents/batch-pdf ne gère pas les DamageInvoice) — une DamageInvoice se télécharge
  // individuellement depuis son propre écran (/dashboard/damage-invoices/[id]).
  const selectableInvoices = useMemo(() => invoices.filter((invoice) => invoice.type === "LOCATION"), [invoices]);
  const allSelected =
    selectableInvoices.length > 0 && selectableInvoices.every((invoice) => selectedIds.has(invoice.id));

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
      setSelectedIds(checked ? new Set(selectableInvoices.map((invoice) => invoice.id)) : new Set());
    },
    [selectableInvoices]
  );

  async function handleDownloadSelection() {
    if (selectedIds.size === 0) return;
    setIsDownloading(true);
    try {
      await apiPostDownload(
        "/api/documents/batch-pdf",
        { type: "INVOICE", ids: Array.from(selectedIds) },
        "lot-factures.pdf"
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la génération du lot PDF.");
    } finally {
      setIsDownloading(false);
    }
  }

  async function handleDownloadRange() {
    setRangeError(null);
    if (!rangeFrom && !rangeTo) {
      setRangeError("Renseignez au moins une date.");
      return;
    }
    setIsDownloading(true);
    try {
      await apiPostDownload(
        "/api/documents/batch-pdf",
        { type: "INVOICE", from: rangeFrom || undefined, to: rangeTo || undefined },
        "lot-factures.pdf"
      );
      setShowRangeDialog(false);
    } catch (err) {
      setRangeError(err instanceof ApiError ? err.message : "Erreur lors de la génération du lot PDF.");
    } finally {
      setIsDownloading(false);
    }
  }

  const columns = useMemo<DataTableColumn<InvoiceRow>[]>(
    () => [
      {
        id: "select",
        header: () => (
          <Checkbox
            checked={allSelected}
            onCheckedChange={(checked: boolean) => toggleSelectAll(checked === true)}
            aria-label="Tout sélectionner"
          />
        ),
        cell: ({ row }) =>
          row.original.type === "LOCATION" ? (
            <Checkbox
              checked={selectedIds.has(row.original.id)}
              onCheckedChange={(checked: boolean) => toggleSelected(row.original.id, checked === true)}
              aria-label="Sélectionner cette facture"
            />
          ) : null,
        size: 32,
      },
      {
        accessorKey: "type",
        header: "Type",
        cell: ({ row }) => (
          <Badge variant={row.original.type === "DEGAT" ? "secondary" : "outline"}>
            {TYPE_LABELS[row.original.type]}
          </Badge>
        ),
      },
      {
        accessorKey: "number",
        header: "Numéro",
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            {row.original.number}
            {row.original.versionNumber > 1 && (
              <Badge variant="outline" className="text-xs">
                v{row.original.versionNumber}
              </Badge>
            )}
          </span>
        ),
      },
      {
        accessorKey: "contractNumber",
        header: "N° contrat",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      { accessorKey: "clientName", header: "Client" },
      {
        id: "issuedAt",
        header: "Émise le",
        cell: ({ row }) => new Date(row.original.issuedAt).toLocaleDateString("fr-FR"),
      },
      {
        accessorKey: "status",
        header: "Statut",
        cell: ({ getValue }) => {
          const status = getValue<string>();
          return <Badge variant={STATUS_VARIANTS[status] ?? "outline"}>{STATUS_LABELS[status] ?? status}</Badge>;
        },
      },
      {
        id: "totalAmount",
        header: "Total",
        meta: { align: "right" },
        cell: ({ row }) => formatMoney(row.original.totalAmount, row.original.currency),
      },
      {
        id: "amountPaid",
        header: "Payé",
        meta: { align: "right" },
        cell: ({ row }) => formatMoney(row.original.amountPaid, row.original.currency),
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
                <DropdownMenuItem
                  render={
                    <Link
                      href={
                        row.original.type === "DEGAT"
                          ? `/dashboard/damage-invoices/${row.original.id}`
                          : `/dashboard/invoices/${row.original.id}`
                      }
                    />
                  }
                >
                  <Eye className="size-4" />
                  Détails
                </DropdownMenuItem>
                <DropdownMenuItem
                  render={
                    <a
                      href={
                        row.original.type === "DEGAT"
                          ? `/api/damage-invoices/${row.original.id}/pdf`
                          : `/api/invoices/${row.original.id}/pdf`
                      }
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  <Download className="size-4" />
                  Télécharger le PDF
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [allSelected, selectedIds, toggleSelectAll, toggleSelected]
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <p className="text-sm text-muted-foreground">{selectedIds.size} sélectionnée(s)</p>
              <Button type="button" size="sm" variant="outline" disabled={isDownloading} onClick={handleDownloadSelection}>
                <Download className="size-4" />
                {isDownloading ? "Génération..." : "Télécharger le lot"}
              </Button>
            </>
          )}
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={() => setShowRangeDialog(true)}>
          <Download className="size-4" />
          Lot par période
        </Button>
      </div>

      <DataTable columns={columns} data={invoices} emptyMessage="Aucune facture." />

      <Dialog open={showRangeDialog} onOpenChange={setShowRangeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Télécharger un lot de factures</DialogTitle>
            <DialogDescription>
              Génère un seul PDF regroupant toutes les factures émises sur la période choisie.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invoiceRangeFrom">Du</Label>
              <Input id="invoiceRangeFrom" type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invoiceRangeTo">Au</Label>
              <Input id="invoiceRangeTo" type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
            </div>
          </div>
          {rangeError && (
            <p role="alert" className="text-sm text-destructive">
              {rangeError}
            </p>
          )}
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
