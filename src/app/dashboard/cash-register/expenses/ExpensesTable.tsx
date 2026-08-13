"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";

export interface ExpenseRow {
  id: string;
  category: string | null;
  amount: number;
  currency: string;
  description: string | null;
  createdAt: string;
}

export function ExpensesTable({ expenses }: { expenses: ExpenseRow[] }) {
  const columns = useMemo<DataTableColumn<ExpenseRow>[]>(
    () => [
      {
        id: "createdAt",
        header: "Date",
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleString("fr-FR"),
      },
      { accessorKey: "category", header: "Catégorie", cell: ({ getValue }) => getValue<string>() ?? "—" },
      { accessorKey: "description", header: "Description", cell: ({ getValue }) => getValue<string>() ?? "—" },
      {
        id: "amount",
        header: "Montant",
        meta: { align: "right" },
        cell: ({ row }) => `-${formatMoney(row.original.amount, row.original.currency)}`,
      },
    ],
    []
  );

  return <DataTable columns={columns} data={expenses} emptyMessage="Aucune dépense." />;
}
