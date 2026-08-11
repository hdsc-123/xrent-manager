"use client";

import { useMemo } from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";
import { Badge } from "@/components/ui";

export interface PaymentRow {
  id: string;
  invoiceNumber: string;
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

export function PaymentsTable({ payments }: { payments: PaymentRow[] }) {
  const columns = useMemo<DataTableColumn<PaymentRow>[]>(
    () => [
      {
        id: "invoiceNumber",
        header: "Facture",
        cell: ({ row }) => (
          <Link href={`/dashboard/invoices`} className="text-primary hover:underline">
            {row.original.invoiceNumber}
          </Link>
        ),
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
        cell: ({ row }) => formatMoney(row.original.amount, row.original.currency),
      },
    ],
    []
  );

  return <DataTable columns={columns} data={payments} emptyMessage="Aucun paiement." />;
}
