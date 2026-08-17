"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Eye, Ban, Trash2, Pencil, CheckCircle2, UserX, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { apiPatch, apiPost, apiDelete, ApiError } from "@/lib/api";
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
  Icon,
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
  /** Sprint 19 (DOMAINRULES.md section 37) : seule l'agence de départ peut modifier/annuler
   * cette réservation — calculé par ligne côté serveur (page.tsx), `true` par défaut pour
   * ADMIN ou une agence de départ non résolue (comportement antérieur conservé). */
  canEditAgency: boolean;
}

const CANCELLABLE_STATUSES = new Set(["PENDING", "CONFIRMED"]);
/** Mêmes statuts que deleteReservation (src/lib/reservations.ts) — CONFIRMED/CONVERTED ne
 * sont supprimables qu'après annulation préalable. */
const DELETABLE_STATUSES = new Set(["PENDING", "CANCELLED"]);
/** Une réservation CONVERTED/CANCELLED est terminale — l'éditer n'aurait plus de sens (le
 * contrat, s'il existe, est désormais la source de vérité ; voir DOMAINRULES.md section 21). */
const EDITABLE_STATUSES = new Set(["PENDING", "CONFIRMED"]);
/** Sprint 23 (DOMAINRULES.md section 39) — mêmes statuts que canTransition(status, "NO_SHOW")/
 * "CONVERTED" (src/lib/reservations.ts) : le client ne s'est pas présenté, ou l'agent valide
 * directement vers le formulaire de contrat, uniquement depuis un statut non terminal. */
const NO_SHOWABLE_STATUSES = new Set(["PENDING", "CONFIRMED"]);
const CONVERTIBLE_STATUSES = new Set(["PENDING", "CONFIRMED"]);
/** Réinitialisation à zéro (ADMIN uniquement) — depuis n'importe quel statut terminal. */
const RESETTABLE_STATUSES = new Set(["CONVERTED", "CANCELLED", "NO_SHOW"]);
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
  canConvert = false,
  canCancel = false,
  canNoShow = false,
  isAdmin = false,
}: {
  reservations: ReservationRow[];
  /** reservations.delete (voir src/lib/permissions.ts) — masque la sélection/suppression si
   * absent, calculé côté serveur par la page appelante. */
  canDelete?: boolean;
  /** reservations.edit — masque l'action « Modifier » si absent. */
  canEdit?: boolean;
  /** Sprint 23 — reservations.convert : masque l'action rapide « Valider » si absent. */
  canConvert?: boolean;
  /** Sprint 24 — reservations.cancel, distincte de reservations.edit : masque « Annuler » si
   * absent. */
  canCancel?: boolean;
  /** Sprint 24 — reservations.no_show, distincte de reservations.edit : masque « No Show » si
   * absent. */
  canNoShow?: boolean;
  /** Sprint 23 — réinitialisation à zéro, réservée ADMIN (jamais une permission granulaire,
   * voir DOMAINRULES.md section 39). */
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const [pendingCancel, setPendingCancel] = useState<ReservationRow | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [pendingNoShow, setPendingNoShow] = useState<ReservationRow | null>(null);
  const [isMarkingNoShow, setIsMarkingNoShow] = useState(false);
  const [pendingReset, setPendingReset] = useState<ReservationRow | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ReservationRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const deletableReservations = useMemo(
    () =>
      reservations.filter(
        (reservation) => DELETABLE_STATUSES.has(reservation.status) && reservation.canEditAgency
      ),
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

  async function handleNoShow() {
    if (!pendingNoShow) return;
    setIsMarkingNoShow(true);
    try {
      await apiPatch(`/api/reservations/${pendingNoShow.id}`, { status: "NO_SHOW" });
      toast.success("Réservation marquée No Show.");
      setPendingNoShow(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors du marquage No Show.");
    } finally {
      setIsMarkingNoShow(false);
    }
  }

  // Sprint 23 (DOMAINRULES.md section 39) — réinitialisation à zéro, ADMIN uniquement ;
  // POST /api/reservations/[id]/reset (nouveau) peut refuser (409) si un contrat lié n'est pas
  // encore annulé par un admin, message renvoyé tel quel.
  async function handleReset() {
    if (!pendingReset) return;
    setIsResetting(true);
    try {
      await apiPost(`/api/reservations/${pendingReset.id}/reset`, {});
      toast.success("Réservation réinitialisée à zéro.");
      setPendingReset(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la réinitialisation.");
    } finally {
      setIsResetting(false);
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
                DELETABLE_STATUSES.has(row.original.status) && row.original.canEditAgency ? (
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
                <Icon icon={MoreHorizontal} className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem render={<Link href={`/dashboard/reservations/${row.original.id}`} />}>
                  <Icon icon={Eye} className="size-4" />
                  Détails
                </DropdownMenuItem>
                {/* Sprint 23 (point A de l'énoncé) — action rapide « Valider » : mène
                    directement au formulaire de contrat existant (convert/page.tsx, inchangé),
                    cohérent avec la transition PENDING/CONFIRMED → CONVERTED déjà autorisée
                    directement (DOMAINRULES.md section 21). */}
                {canConvert && row.original.canEditAgency && CONVERTIBLE_STATUSES.has(row.original.status) && (
                  <DropdownMenuItem render={<Link href={`/dashboard/reservations/${row.original.id}/convert`} />}>
                    <Icon icon={CheckCircle2} className="size-4" />
                    Valider
                  </DropdownMenuItem>
                )}
                {canEdit && row.original.canEditAgency && EDITABLE_STATUSES.has(row.original.status) && (
                  <DropdownMenuItem render={<Link href={`/dashboard/reservations/${row.original.id}/edit`} />}>
                    <Icon icon={Pencil} className="size-4" />
                    Modifier
                  </DropdownMenuItem>
                )}
                {/* Sprint 24 : gatée par reservations.cancel, plus reservations.edit — clé
                    dédiée, distincte de la modification de champs (voir src/lib/permissions.ts).
                    Sprint 19 : + canEditAgency — seule l'agence de départ peut annuler, voir
                    DOMAINRULES.md section 37. */}
                {canCancel && row.original.canEditAgency && CANCELLABLE_STATUSES.has(row.original.status) && (
                  <DropdownMenuItem variant="destructive" onClick={() => setPendingCancel(row.original)}>
                    <Icon icon={Ban} className="size-4" />
                    Annuler
                  </DropdownMenuItem>
                )}
                {/* Sprint 23 — No Show : le client ne s'est pas présenté, distinct d'Annuler.
                    Sprint 24 : gatée par reservations.no_show, plus reservations.edit. */}
                {canNoShow && row.original.canEditAgency && NO_SHOWABLE_STATUSES.has(row.original.status) && (
                  <DropdownMenuItem variant="destructive" onClick={() => setPendingNoShow(row.original)}>
                    <Icon icon={UserX} className="size-4" />
                    No Show
                  </DropdownMenuItem>
                )}
                {canDelete && row.original.canEditAgency && DELETABLE_STATUSES.has(row.original.status) && (
                  <DropdownMenuItem variant="destructive" onClick={() => setPendingDelete(row.original)}>
                    <Icon icon={Trash2} className="size-4" />
                    Supprimer
                  </DropdownMenuItem>
                )}
                {/* Sprint 23 — réinitialisation à zéro, ADMIN uniquement (jamais une permission
                    granulaire, DOMAINRULES.md section 39) : corrige une erreur d'agent (mauvais
                    clic Annuler/No Show, ou reprise à zéro après annulation admin d'un contrat). */}
                {isAdmin && RESETTABLE_STATUSES.has(row.original.status) && (
                  <DropdownMenuItem onClick={() => setPendingReset(row.original)}>
                    <Icon icon={RotateCcw} className="size-4" />
                    Réinitialiser à zéro
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [canDelete, canEdit, canConvert, canCancel, canNoShow, isAdmin, selectedIds, allDeletableSelected, toggleSelectAll, toggleSelected]
  );

  return (
    <>
      {canDelete && selectedIds.size > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-md border border-border bg-muted/50 px-3 py-2">
          <p className="text-sm text-muted-foreground">{selectedIds.size} sélectionnée(s)</p>
          <Button variant="destructive" size="sm" onClick={handleBulkDelete} disabled={isBulkDeleting}>
            <Icon icon={Trash2} className="size-4" />
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

      <Dialog open={Boolean(pendingNoShow)} onOpenChange={(open) => !open && setPendingNoShow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Marquer No Show ?</DialogTitle>
            <DialogDescription>
              Le client ne s&apos;est pas présenté pour la réservation « {pendingNoShow?.voucherNumber} ».
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingNoShow(null)}>
              Retour
            </Button>
            <Button variant="destructive" onClick={handleNoShow} disabled={isMarkingNoShow}>
              {isMarkingNoShow ? "Enregistrement..." : "Marquer No Show"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(pendingReset)} onOpenChange={(open) => !open && setPendingReset(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Réinitialiser à zéro ?</DialogTitle>
            <DialogDescription>
              La réservation « {pendingReset?.voucherNumber} » repassera à « En attente ». Si un contrat a déjà été
              généré, il doit d&apos;abord être annulé (fiche du contrat) — sinon cette action sera refusée.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingReset(null)}>
              Retour
            </Button>
            <Button onClick={handleReset} disabled={isResetting}>
              {isResetting ? "Réinitialisation..." : "Réinitialiser"}
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
