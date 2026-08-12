"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Eye, Ban } from "lucide-react";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";
import {
  Badge,
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
} from "@/components/ui";

export interface ReservationRow {
  id: string;
  voucherNumber: string;
  clientFirstName: string;
  clientLastName: string;
  startDate: string;
  endDate: string;
  status: string;
  source: string | null;
  totalPrice: number | null;
  currency: string;
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  CONFIRMED: "Confirmée",
  CONVERTED: "Convertie",
  CANCELLED: "Annulée",
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  PENDING: "outline",
  CONFIRMED: "secondary",
  CONVERTED: "default",
  CANCELLED: "destructive",
};

const CANCELLABLE_STATUSES = new Set(["PENDING", "CONFIRMED"]);

export function ReservationsTable({ reservations }: { reservations: ReservationRow[] }) {
  const router = useRouter();
  const [pendingCancel, setPendingCancel] = useState<ReservationRow | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  async function handleCancel() {
    if (!pendingCancel) return;
    setIsCancelling(true);
    try {
      await apiPatch(`/api/reservations/${pendingCancel.id}`, { status: "CANCELLED" });
      toast.success("Réservation annulée.");
      setPendingCancel(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de l'annulation.");
    } finally {
      setIsCancelling(false);
    }
  }

  const columns = useMemo<DataTableColumn<ReservationRow>[]>(
    () => [
      { accessorKey: "voucherNumber", header: "Voucher" },
      {
        id: "client",
        header: "Client",
        accessorFn: (row) => `${row.clientFirstName} ${row.clientLastName}`,
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
        id: "source",
        header: "Source",
        cell: ({ row }) => row.original.source ?? "—",
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
        id: "totalPrice",
        header: "Total",
        cell: ({ row }) =>
          row.original.totalPrice !== null ? formatMoney(row.original.totalPrice, row.original.currency) : "—",
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
                <DropdownMenuItem render={<Link href={`/dashboard/reservations/${row.original.id}`} />}>
                  <Eye className="size-4" />
                  Détails
                </DropdownMenuItem>
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
      <DataTable columns={columns} data={reservations} emptyMessage="Aucune réservation." />

      <Dialog open={Boolean(pendingCancel)} onOpenChange={(open) => !open && setPendingCancel(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Annuler la réservation ?</DialogTitle>
            <DialogDescription>
              La réservation « {pendingCancel?.voucherNumber} » sera annulée. Cette action est irréversible.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingCancel(null)}>
              Retour
            </Button>
            <Button variant="destructive" onClick={handleCancel} disabled={isCancelling}>
              {isCancelling ? "Annulation..." : "Annuler la réservation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
