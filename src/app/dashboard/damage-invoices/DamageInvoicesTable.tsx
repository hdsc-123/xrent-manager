"use client";

import { useMemo } from "react";
import Link from "next/link";
import { MoreHorizontal, Eye, Download } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";

export interface DamageInvoiceRow {
  id: string;
  number: string;
  contractNumber: string | null;
  clientName: string;
  status: string;
  issuedAt: string;
  totalAmount: number;
  amountPaid: number;
  currency: string;
}

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

export function DamageInvoicesTable({ damageInvoices }: { damageInvoices: DamageInvoiceRow[] }) {
  const columns = useMemo<DataTableColumn<DamageInvoiceRow>[]>(
    () => [
      { accessorKey: "number", header: "Numéro" },
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
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem render={<Link href={`/dashboard/damage-invoices/${row.original.id}`} />}>
                  <Eye className="size-4" />
                  Détails
                </DropdownMenuItem>
                <DropdownMenuItem
                  render={<a href={`/api/damage-invoices/${row.original.id}/pdf`} target="_blank" rel="noreferrer" />}
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
    []
  );

  return <DataTable columns={columns} data={damageInvoices} emptyMessage="Aucune facture de dégâts." />;
}
