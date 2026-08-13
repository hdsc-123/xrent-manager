"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";
import { Badge } from "@/components/ui";

export interface EntryRow {
  id: string;
  category: string | null;
  amount: number;
  currency: string;
  description: string | null;
  contractNumber: string | null;
  clientName: string | null;
  paymentMethod: string | null;
  createdAt: string;
}

const METHOD_LABELS: Record<string, string> = {
  CASH: "Espèces",
  CARD: "Carte",
  BANK_TRANSFER: "Virement",
  CHECK: "Chèque",
  OTHER: "Autre",
};

export function EntriesTable({ entries }: { entries: EntryRow[] }) {
  const columns = useMemo<DataTableColumn<EntryRow>[]>(
    () => [
      {
        id: "createdAt",
        header: "Date",
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleString("fr-FR"),
      },
      { accessorKey: "category", header: "Catégorie", cell: ({ getValue }) => getValue<string>() ?? "—" },
      { accessorKey: "description", header: "Description", cell: ({ getValue }) => getValue<string>() ?? "—" },
      {
        accessorKey: "contractNumber",
        header: "N° contrat",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      { accessorKey: "clientName", header: "Client", cell: ({ getValue }) => getValue<string>() ?? "—" },
      {
        accessorKey: "paymentMethod",
        header: "Mode",
        cell: ({ getValue }) => {
          const method = getValue<string | null>();
          return method ? <Badge variant="outline">{METHOD_LABELS[method] ?? method}</Badge> : "—";
        },
      },
      {
        id: "amount",
        header: "Montant",
        meta: { align: "right" },
        cell: ({ row }) => `+${formatMoney(row.original.amount, row.original.currency)}`,
      },
    ],
    []
  );

  return <DataTable columns={columns} data={entries} emptyMessage="Aucune entrée." />;
}
