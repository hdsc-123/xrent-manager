"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Eye, Ban } from "lucide-react";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
import { formatMoney, combineDateAndTime, calculateDaysCount } from "@/lib/format";
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
  StatusBadge,
} from "@/components/ui";

export interface ReservationRow {
  id: string;
  voucherNumber: string;
  source: string | null;
  flightNumber: string | null;
  clientFirstName: string;
  clientLastName: string;
  startDate: string;
  startTime: string | null;
  endDate: string;
  endTime: string | null;
  pickupAgency: string | null;
  dropoffAgency: string | null;
  vehicleCategory: string | null;
  hasGps: boolean;
  hasBabySeat: boolean;
  hasExtraDriver: boolean;
  totalPrice: number | null;
  gpsPrice: number | null;
  babySeatPrice: number | null;
  extraDriverPrice: number | null;
  currency: string;
  notes: string | null;
  status: string;
}

const CANCELLABLE_STATUSES = new Set(["PENDING", "CONFIRMED"]);
const NOTES_TRUNCATE_LENGTH = 50;

/** "10/08/26 10:00" — date au format court fr-FR + heure telle qu'importée/saisie
 * (voir RESERVATION_IMPORT_COLUMN_MAP, src/lib/reservations.ts). */
function formatDateTimeCell(dateIso: string, time: string | null): string {
  const datePart = new Date(dateIso).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
  return time ? `${datePart} ${time}` : datePart;
}

function YesNoBadge({ value }: { value: boolean }) {
  return value ? (
    <Badge
      variant="outline"
      className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800"
    >
      OUI
    </Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">
      NON
    </Badge>
  );
}

function truncateNotes(notes: string | null): string {
  if (!notes) return "—";
  return notes.length > NOTES_TRUNCATE_LENGTH ? `${notes.slice(0, NOTES_TRUNCATE_LENGTH)}...` : notes;
}

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
        id: "source",
        header: "Source",
        cell: ({ row }) => row.original.source ?? "—",
      },
      {
        id: "flightNumber",
        header: "N° vol",
        cell: ({ row }) => row.original.flightNumber ?? "—",
      },
      {
        id: "client",
        header: "Client",
        accessorFn: (row) => `${row.clientLastName} ${row.clientFirstName}`,
      },
      {
        id: "departure",
        header: "Départ",
        cell: ({ row }) => formatDateTimeCell(row.original.startDate, row.original.startTime),
      },
      {
        id: "return",
        header: "Retour",
        cell: ({ row }) => formatDateTimeCell(row.original.endDate, row.original.endTime),
      },
      {
        id: "daysCount",
        header: "Jours",
        cell: ({ row }) => {
          const start = combineDateAndTime(new Date(row.original.startDate), row.original.startTime);
          const end = combineDateAndTime(new Date(row.original.endDate), row.original.endTime);
          return calculateDaysCount(start, end);
        },
      },
      {
        id: "pickupAgency",
        header: "Ville de départ",
        cell: ({ row }) => row.original.pickupAgency ?? "—",
      },
      {
        id: "dropoffAgency",
        header: "Ville de retour",
        cell: ({ row }) => row.original.dropoffAgency ?? "—",
      },
      {
        id: "vehicleCategory",
        header: "Catégorie",
        cell: ({ row }) => row.original.vehicleCategory ?? "—",
      },
      {
        id: "hasGps",
        header: "GPS",
        cell: ({ row }) => <YesNoBadge value={row.original.hasGps} />,
      },
      {
        id: "hasBabySeat",
        header: "Siège bébé",
        cell: ({ row }) => <YesNoBadge value={row.original.hasBabySeat} />,
      },
      {
        id: "hasExtraDriver",
        header: "Conducteur suppl.",
        cell: ({ row }) => <YesNoBadge value={row.original.hasExtraDriver} />,
      },
      {
        id: "totalPrice",
        header: "Prix total",
        cell: ({ row }) =>
          row.original.totalPrice !== null ? formatMoney(row.original.totalPrice, row.original.currency) : "—",
      },
      {
        id: "finalPrice",
        header: "Prix final",
        cell: ({ row }) => {
          const { totalPrice, gpsPrice, babySeatPrice, extraDriverPrice, currency } = row.original;
          if (totalPrice === null) return "—";
          const finalPrice = totalPrice + (gpsPrice ?? 0) + (babySeatPrice ?? 0) + (extraDriverPrice ?? 0);
          return formatMoney(finalPrice, currency);
        },
      },
      {
        id: "notes",
        header: "Remarque",
        cell: ({ row }) => truncateNotes(row.original.notes),
      },
      {
        accessorKey: "status",
        header: "Statut",
        cell: ({ getValue }) => <StatusBadge status={getValue<string>()} />,
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
