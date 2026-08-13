"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Eye, Ban, FileText } from "lucide-react";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";
import {
  Button,
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
  StatusBadge,
} from "@/components/ui";

export interface LocationRow {
  id: string;
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
    []
  );

  return (
    <>
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
    </>
  );
}
