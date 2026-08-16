"use client";

import { useMemo } from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";
import { Badge } from "@/components/ui";

export interface PaymentRow {
  id: string;
  /** Sprint 33 — distingue un paiement locatif (Invoice) d'un paiement de dégât
   * (DamageInvoice), jamais mélangés dans un calcul, seulement affichés côte à côte. */
  type: "LOCATION" | "DEGAT";
  /** id de l'Invoice ou de la DamageInvoice selon `type` — sert uniquement au lien de détail. */
  invoiceId: string;
  invoiceNumber: string;
  contractNumber: string | null;
  clientName: string;
  method: string;
  paidAt: string;
  amount: number;
  currency: string;
  reference: string | null;
}

const METHOD_LABELS: Record<string, string> = {
  CASH: "Espèces",
  CARD: "Carte",
  BANK_TRANSFER: "Virement",
  CHECK: "Chèque",
  OTHER: "Autre",
};

const TYPE_LABELS: Record<PaymentRow["type"], string> = {
  LOCATION: "Location",
  DEGAT: "Dégât",
};

export function PaymentsTable({ payments }: { payments: PaymentRow[] }) {
  const columns = useMemo<DataTableColumn<PaymentRow>[]>(
    () => [
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
        id: "invoiceNumber",
        header: "Facture",
        cell: ({ row }) => (
          <Link
            href={
              row.original.type === "DEGAT"
                ? `/dashboard/damage-invoices/${row.original.invoiceId}`
                : `/dashboard/invoices/${row.original.invoiceId}`
            }
            className="text-primary hover:underline"
          >
            {row.original.invoiceNumber}
          </Link>
        ),
      },
      {
        accessorKey: "contractNumber",
        header: "N° contrat",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      { accessorKey: "clientName", header: "Client" },
      {
        id: "paidAt",
        header: "Date",
        cell: ({ row }) => new Date(row.original.paidAt).toLocaleDateString("fr-FR"),
      },
      {
        accessorKey: "method",
        header: "Méthode",
        cell: ({ getValue }) => {
          const method = getValue<string>();
          return <Badge variant="outline">{METHOD_LABELS[method] ?? method}</Badge>;
        },
      },
      { accessorKey: "reference", header: "Référence" },
      {
        id: "amount",
        header: "Montant",
        meta: { align: "right" },
        cell: ({ row }) => formatMoney(row.original.amount, row.original.currency),
      },
    ],
    []
  );

  return <DataTable columns={columns} data={payments} emptyMessage="Aucun paiement." />;
}
