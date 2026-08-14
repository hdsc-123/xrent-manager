"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Eye, Ban, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { apiPatch, apiDelete, ApiError } from "@/lib/api";
import { formatMoney, combineDateAndTime, calculateDaysCount } from "@/lib/format";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";
import {
  Badge,
  Button,
  Checkbox,
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
  /** Sprint 15 : devise des options (GPS/siège bébé/conducteur suppl.), distincte de
   * `currency` (qui reste dédiée à totalPrice/pricePerDay) — un broker facture parfois le
   * prix total dans une devise et les options systématiquement dans une autre. */
  optionsCurrency: string;
  notes: string | null;
  status: string;
}

const CANCELLABLE_STATUSES = new Set(["PENDING", "CONFIRMED"]);
/** Mêmes statuts que deleteReservation (src/lib/reservations.ts) — CONFIRMED/CONVERTED ne
 * sont supprimables qu'après annulation préalable. */
const DELETABLE_STATUSES = new Set(["PENDING", "CANCELLED"]);
/** Une réservation CONVERTED/CANCELLED est terminale — l'éditer n'aurait plus de sens (le
 * contrat, s'il existe, est désormais la source de vérité ; voir DOMAINRULES.md section 21). */
const EDITABLE_STATUSES = new Set(["PENDING", "CONFIRMED"]);
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

export function ReservationsTable({
  reservations,
  canDelete = false,
  canEdit = false,
}: {
  reservations: ReservationRow[];
  /** reservations.delete (voir src/lib/permissions.ts) — masque la sélection/suppression si
   * absent, calculé côté serveur par la page appelante. */
  canDelete?: boolean;
  /** reservations.edit — masque l'action « Modifier » si absent. */
  canEdit?: boolean;
}) {
  const router = useRouter();
  const [pendingCancel, setPendingCancel] = useState<ReservationRow | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ReservationRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const deletableReservations = useMemo(
    () => reservations.filter((reservation) => DELETABLE_STATUSES.has(reservation.status)),
    [reservations]
  );
  const allDeletableSelected =
    deletableReservations.length > 0 && deletableReservations.every((r) => selectedIds.has(r.id));

  const toggleSelected = useCallback((id: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(
    (checked: boolean) => {
      setSelectedIds(checked ? new Set(deletableReservations.map((r) => r.id)) : new Set());
    },
    [deletableReservations]
  );

  async function handleDelete() {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      await apiDelete(`/api/reservations/${pendingDelete.id}`);
      toast.success("Réservation supprimée.");
      setPendingDelete(null);
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(pendingDelete.id);
        return next;
      });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la suppression.");
    } finally {
      setIsDeleting(false);
    }
  }

  // Pas de route bulk dédiée : enchaîne DELETE /api/reservations/[id] (existant) pour chaque
  // ligne sélectionnée — une ligne refusée (statut non supprimable entre-temps) n'empêche pas
  // la suppression des autres.
  async function handleBulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setIsBulkDeleting(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => apiDelete(`/api/reservations/${id}`)));
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - succeeded;
      if (failed === 0) {
        toast.success(`${succeeded} réservation(s) supprimée(s).`);
      } else {
        toast.warning(`${succeeded} supprimée(s), ${failed} refusée(s) (statut non supprimable).`);
      }
      setSelectedIds(new Set());
      router.refresh();
    } finally {
      setIsBulkDeleting(false);
    }
  }

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
      ...(canDelete
        ? [
            {
              id: "select",
              header: () => (
                <Checkbox
                  checked={allDeletableSelected}
                  onCheckedChange={(checked: boolean) => toggleSelectAll(checked === true)}
                  aria-label="Tout sélectionner"
                />
              ),
              cell: ({ row }: { row: { original: ReservationRow } }) =>
                DELETABLE_STATUSES.has(row.original.status) ? (
                  <Checkbox
                    checked={selectedIds.has(row.original.id)}
                    onCheckedChange={(checked: boolean) => toggleSelected(row.original.id, checked === true)}
                    aria-label="Sélectionner cette réservation"
                  />
                ) : null,
              size: 32,
            } satisfies DataTableColumn<ReservationRow>,
          ]
        : []),
      { accessorKey: "voucherNumber", header: "Voucher" },
      {
        id: "source",
        header: "Source",
        accessorFn: (row) => row.source ?? "",
        cell: ({ row }) => row.original.source ?? "—",
      },
      {
        id: "client",
        header: "Client",
        accessorFn: (row) => `${row.clientLastName} ${row.clientFirstName}`,
        size: 140,
      },
      {
        id: "departure",
        header: "Départ",
        // accessorFn (plutôt qu'un simple cell) : nécessaire pour que le tri fonctionne — sans
        // accesseur, TanStack Table n'a aucune valeur comparable et le bouton de tri de l'en-tête
        // reste sans effet (Sprint 15, correctif du tri Départ/Retour demandé par l'énoncé).
        accessorFn: (row) => combineDateAndTime(new Date(row.startDate), row.startTime).getTime(),
        cell: ({ row }) => formatDateTimeCell(row.original.startDate, row.original.startTime),
      },
      {
        id: "return",
        header: "Retour",
        accessorFn: (row) => combineDateAndTime(new Date(row.endDate), row.endTime).getTime(),
        cell: ({ row }) => formatDateTimeCell(row.original.endDate, row.original.endTime),
      },
      {
        id: "daysCount",
        header: "Jours",
        meta: { align: "right" },
        cell: ({ row }) => {
          const start = combineDateAndTime(new Date(row.original.startDate), row.original.startTime);
          const end = combineDateAndTime(new Date(row.original.endDate), row.original.endTime);
          return calculateDaysCount(start, end);
        },
      },
      {
        id: "pickupAgency",
        header: "Ville de départ",
        accessorFn: (row) => row.pickupAgency ?? "",
        cell: ({ row }) => row.original.pickupAgency ?? "—",
        size: 110,
      },
      {
        id: "dropoffAgency",
        header: "Ville de retour",
        accessorFn: (row) => row.dropoffAgency ?? "",
        cell: ({ row }) => row.original.dropoffAgency ?? "—",
        size: 110,
      },
      {
        id: "vehicleCategory",
        header: "Catégorie",
        accessorFn: (row) => row.vehicleCategory ?? "",
        cell: ({ row }) => row.original.vehicleCategory ?? "—",
        size: 100,
      },
      {
        id: "flightNumber",
        header: "N° vol",
        cell: ({ row }) => row.original.flightNumber ?? "—",
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
        meta: { align: "right" },
        accessorFn: (row) => row.totalPrice ?? 0,
        cell: ({ row }) =>
          row.original.totalPrice !== null ? formatMoney(row.original.totalPrice, row.original.currency) : "—",
      },
      {
        id: "finalPrice",
        header: "Prix final",
        meta: { align: "right" },
        cell: ({ row }) => {
          const { totalPrice, gpsPrice, babySeatPrice, extraDriverPrice, currency, optionsCurrency } = row.original;
          if (totalPrice === null) return "—";
          const optionsSum = (gpsPrice ?? 0) + (babySeatPrice ?? 0) + (extraDriverPrice ?? 0);
          // Sprint 15 : totalPrice/pricePerDay sont en `currency`, les options (GPS/siège
          // bébé/conducteur suppl.) en `optionsCurrency` — jamais additionnées sans conversion
          // si elles diffèrent (ex. broker facturant le total en EUR, les options en MAD).
          if (optionsSum === 0 || optionsCurrency === currency) {
            return formatMoney(totalPrice + optionsSum, currency);
          }
          return `${formatMoney(totalPrice, currency)} + ${formatMoney(optionsSum, optionsCurrency)}`;
        },
      },
      {
        id: "notes",
        header: "Remarque",
        cell: ({ row }) => truncateNotes(row.original.notes),
        size: 160,
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
                {canEdit && EDITABLE_STATUSES.has(row.original.status) && (
                  <DropdownMenuItem render={<Link href={`/dashboard/reservations/${row.original.id}/edit`} />}>
                    <Pencil className="size-4" />
                    Modifier
                  </DropdownMenuItem>
                )}
                {CANCELLABLE_STATUSES.has(row.original.status) && (
                  <DropdownMenuItem variant="destructive" onClick={() => setPendingCancel(row.original)}>
                    <Ban className="size-4" />
                    Annuler
                  </DropdownMenuItem>
                )}
                {canDelete && DELETABLE_STATUSES.has(row.original.status) && (
                  <DropdownMenuItem variant="destructive" onClick={() => setPendingDelete(row.original)}>
                    <Trash2 className="size-4" />
                    Supprimer
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [canDelete, canEdit, selectedIds, allDeletableSelected, toggleSelectAll, toggleSelected]
  );

  return (
    <>
      {canDelete && selectedIds.size > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-md border border-border bg-muted/50 px-3 py-2">
          <p className="text-sm text-muted-foreground">{selectedIds.size} sélectionnée(s)</p>
          <Button variant="destructive" size="sm" onClick={handleBulkDelete} disabled={isBulkDeleting}>
            <Trash2 className="size-4" />
            {isBulkDeleting ? "Suppression..." : "Supprimer la sélection"}
          </Button>
        </div>
      )}

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

      <Dialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer la réservation ?</DialogTitle>
            <DialogDescription>
              La réservation « {pendingDelete?.voucherNumber} » sera définitivement supprimée. Cette action est
              irréversible.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Retour
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? "Suppression..." : "Supprimer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
