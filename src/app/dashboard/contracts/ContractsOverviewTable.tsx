"use client";

import { useMemo } from "react";
import Link from "next/link";
import { formatMoney, calculateDaysCount } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";
import { Badge } from "@/components/ui";

export interface ContractOverviewRow {
  id: string;
  contractNumber: string | null;
  clientName: string;
  source: string | null;
  startDate: string;
  endDate: string;
  make: string;
  licensePlate: string;
  startOdometer: number | null;
  endOdometer: number | null;
  startFuelLevel: number | null;
  endFuelLevel: number | null;
  totalPrice: number;
  currency: string;
  status: string;
}

/** Sprint 23 (DOMAINRULES.md section 39) : l'onglet ne montre que des états dérivés de
 * `Location.status` — « Validé » pour tout ce qui n'est pas CANCELLED (PENDING/CONFIRMED/
 * ACTIVE/COMPLETED, un contrat en cours de vie normale), « Annulé » pour CANCELLED. Le
 * détail fin des 5 statuts reste consultable sur la fiche du contrat (StatusBadge). */
function ContractStateBadge({ status }: { status: string }) {
  if (status === "CANCELLED") {
    return (
      <Badge
        variant="outline"
        className="bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800"
      >
        Annulé
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800"
    >
      Validé
    </Badge>
  );
}

function fuelLabel(value: number | null): string {
  if (value === null) return "—";
  return `${value}%`;
}

export function ContractsOverviewTable({ contracts }: { contracts: ContractOverviewRow[] }) {
  const columns = useMemo<DataTableColumn<ContractOverviewRow>[]>(
    () => [
      {
        id: "contractNumber",
        header: "N° contrat",
        cell: ({ row }) => (
          <Link href={`/dashboard/locations/${row.original.id}`} className="text-primary hover:underline">
            {row.original.contractNumber ?? "—"}
          </Link>
        ),
      },
      { accessorKey: "clientName", header: "Nom prénom" },
      {
        id: "source",
        header: "Source",
        accessorFn: (row) => row.source ?? "",
        cell: ({ row }) => row.original.source ?? "—",
      },
      {
        id: "startDate",
        header: "Départ",
        accessorFn: (row) => new Date(row.startDate).getTime(),
        cell: ({ row }) => new Date(row.original.startDate).toLocaleString("fr-FR"),
        size: 130,
      },
      {
        id: "endDate",
        header: "Retour",
        accessorFn: (row) => new Date(row.endDate).getTime(),
        cell: ({ row }) => new Date(row.original.endDate).toLocaleString("fr-FR"),
        size: 130,
      },
      {
        id: "daysCount",
        header: "Jours",
        meta: { align: "right" },
        cell: ({ row }) => calculateDaysCount(new Date(row.original.startDate), new Date(row.original.endDate)),
      },
      { accessorKey: "make", header: "Marque" },
      { accessorKey: "licensePlate", header: "Immatriculation" },
      {
        id: "startOdometer",
        header: "Km départ",
        meta: { align: "right" },
        cell: ({ row }) => row.original.startOdometer ?? "—",
      },
      {
        id: "startFuelLevel",
        header: "Carburant départ",
        cell: ({ row }) => fuelLabel(row.original.startFuelLevel),
      },
      {
        id: "endOdometer",
        header: "Km retour",
        meta: { align: "right" },
        cell: ({ row }) => row.original.endOdometer ?? "—",
      },
      {
        id: "endFuelLevel",
        header: "Carburant retour",
        cell: ({ row }) => fuelLabel(row.original.endFuelLevel),
      },
      {
        id: "totalPrice",
        header: "Total final",
        meta: { align: "right" },
        accessorFn: (row) => row.totalPrice,
        cell: ({ row }) => formatMoney(row.original.totalPrice, row.original.currency),
      },
      {
        accessorKey: "status",
        header: "État",
        cell: ({ getValue }) => <ContractStateBadge status={getValue<string>()} />,
      },
    ],
    []
  );

  return <DataTable columns={columns} data={contracts} emptyMessage="Aucun contrat." />;
}
