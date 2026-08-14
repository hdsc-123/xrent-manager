"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";
import { Badge } from "@/components/ui";

export interface VehiclePerformanceRow {
  vehicleId: string;
  model: string;
  make: string;
  licensePlate: string;
  currentAgencyName: string;
  currentOdometer: number | null;
  currentFuelLevel: number | null;
  validatedContractCount: number;
  rentedDays: number;
  revenue: number;
  expenses: number;
  currency: string;
  netMargin: number;
  rank: number;
}

export function VehiclePerformanceTable({ vehicles }: { vehicles: VehiclePerformanceRow[] }) {
  const columns = useMemo<DataTableColumn<VehiclePerformanceRow>[]>(
    () => [
      {
        id: "rank",
        header: "Rang",
        meta: { align: "right" },
        cell: ({ row }) => <Badge variant="outline">#{row.original.rank}</Badge>,
      },
      { accessorKey: "model", header: "Modèle" },
      { accessorKey: "make", header: "Marque" },
      { accessorKey: "licensePlate", header: "Matricule" },
      { accessorKey: "currentAgencyName", header: "Station actuelle" },
      {
        id: "currentOdometer",
        header: "Km actuel",
        meta: { align: "right" },
        cell: ({ row }) => row.original.currentOdometer ?? "—",
      },
      {
        id: "currentFuelLevel",
        header: "Carburant actuel",
        cell: ({ row }) => (row.original.currentFuelLevel !== null ? `${row.original.currentFuelLevel}%` : "—"),
      },
      {
        id: "validatedContractCount",
        header: "Contrats validés",
        meta: { align: "right" },
        accessorKey: "validatedContractCount",
      },
      {
        id: "rentedDays",
        header: "Jours loués",
        meta: { align: "right" },
        accessorKey: "rentedDays",
      },
      {
        id: "revenue",
        header: "CA réalisé",
        meta: { align: "right" },
        accessorFn: (row) => row.revenue,
        cell: ({ row }) => formatMoney(row.original.revenue, row.original.currency),
      },
      {
        id: "expenses",
        header: "Dépenses totales",
        meta: { align: "right" },
        accessorFn: (row) => row.expenses,
        cell: ({ row }) => formatMoney(row.original.expenses, row.original.currency),
      },
      {
        id: "netMargin",
        header: "Marge nette",
        meta: { align: "right" },
        accessorFn: (row) => row.netMargin,
        cell: ({ row }) => formatMoney(row.original.netMargin, row.original.currency),
      },
    ],
    []
  );

  return <DataTable columns={columns} data={vehicles} emptyMessage="Aucun véhicule." />;
}
