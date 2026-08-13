"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, CheckCircle2, XCircle } from "lucide-react";
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
  Input,
  Label,
} from "@/components/ui";

export interface MaintenanceRow {
  id: string;
  vehicleName: string;
  licensePlate: string;
  agencyName: string;
  type: string;
  status: string;
  scheduledDate: string;
  completedDate: string | null;
  cost: number | null;
  currency: string;
  notes: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  OIL_CHANGE: "Vidange",
  TIRE_CHANGE: "Changement de pneus",
  INSPECTION: "Contrôle technique",
  REPAIR: "Réparation",
  OTHER: "Autre",
};

const STATUS_LABELS: Record<string, string> = {
  SCHEDULED: "Planifiée",
  IN_PROGRESS: "En cours",
  COMPLETED: "Terminée",
  CANCELLED: "Annulée",
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  SCHEDULED: "outline",
  IN_PROGRESS: "secondary",
  COMPLETED: "default",
  CANCELLED: "destructive",
};

const EDITABLE_STATUSES = new Set(["SCHEDULED", "IN_PROGRESS"]);

export function MaintenancesTable({ maintenances }: { maintenances: MaintenanceRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<MaintenanceRow | null>(null);
  const [editScheduledDate, setEditScheduledDate] = useState("");
  const [editCost, setEditCost] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [pendingAction, setPendingAction] = useState<{ row: MaintenanceRow; kind: "complete" | "cancel" } | null>(
    null
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  function openEdit(row: MaintenanceRow) {
    setEditing(row);
    setEditScheduledDate(row.scheduledDate.slice(0, 10));
    setEditCost(row.cost !== null ? (row.cost / 100).toFixed(2) : "");
    setEditNotes(row.notes ?? "");
  }

  async function handleSaveEdit() {
    if (!editing) return;
    setIsSubmitting(true);
    try {
      const costValue = editCost.trim() === "" ? undefined : Math.round(Number(editCost.replace(",", ".")) * 100);
      if (costValue !== undefined && (!Number.isFinite(costValue) || costValue < 0)) {
        toast.error("Le coût doit être un nombre positif ou nul.");
        return;
      }

      await apiPatch(`/api/maintenances/${editing.id}`, {
        scheduledDate: editScheduledDate || undefined,
        cost: costValue,
        notes: editNotes,
      });
      toast.success("Maintenance mise à jour.");
      setEditing(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la mise à jour.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleConfirmAction() {
    if (!pendingAction) return;
    setIsSubmitting(true);
    try {
      const status = pendingAction.kind === "complete" ? "COMPLETED" : "CANCELLED";
      await apiPatch(`/api/maintenances/${pendingAction.row.id}`, { status });
      toast.success(pendingAction.kind === "complete" ? "Maintenance marquée terminée." : "Maintenance annulée.");
      setPendingAction(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors du changement de statut.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const columns = useMemo<DataTableColumn<MaintenanceRow>[]>(
    () => [
      { id: "vehicleName", header: "Véhicule", accessorFn: (row) => `${row.vehicleName} (${row.licensePlate})` },
      { accessorKey: "agencyName", header: "Agence" },
      {
        accessorKey: "type",
        header: "Type",
        cell: ({ getValue }) => TYPE_LABELS[getValue<string>()] ?? getValue<string>(),
      },
      {
        id: "scheduledDate",
        header: "Date prévue",
        cell: ({ row }) => new Date(row.original.scheduledDate).toLocaleDateString("fr-FR"),
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
        id: "cost",
        header: "Coût",
        meta: { align: "right" },
        cell: ({ row }) =>
          row.original.cost !== null ? formatMoney(row.original.cost, row.original.currency) : "—",
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const editable = EDITABLE_STATUSES.has(row.original.status);
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={!editable} onClick={() => openEdit(row.original)}>
                    <Pencil className="size-4" />
                    Modifier
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!editable}
                    onClick={() => setPendingAction({ row: row.original, kind: "complete" })}
                  >
                    <CheckCircle2 className="size-4" />
                    Marquer terminée
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={!editable}
                    onClick={() => setPendingAction({ row: row.original, kind: "cancel" })}
                  >
                    <XCircle className="size-4" />
                    Annuler
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    []
  );

  return (
    <>
      <DataTable columns={columns} data={maintenances} emptyMessage="Aucune maintenance." />

      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modifier la maintenance</DialogTitle>
            <DialogDescription>
              {editing?.vehicleName} ({editing?.licensePlate})
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="editScheduledDate">Date prévue</Label>
              <Input
                id="editScheduledDate"
                type="date"
                value={editScheduledDate}
                onChange={(e) => setEditScheduledDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="editCost">Coût (MAD)</Label>
              <Input
                id="editCost"
                inputMode="decimal"
                placeholder="optionnel"
                value={editCost}
                onChange={(e) => setEditCost(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="editNotes">Notes</Label>
              <Input id="editNotes" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Annuler
            </Button>
            <Button onClick={handleSaveEdit} disabled={isSubmitting}>
              {isSubmitting ? "Enregistrement..." : "Enregistrer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(pendingAction)} onOpenChange={(open) => !open && setPendingAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingAction?.kind === "complete" ? "Marquer terminée ?" : "Annuler la maintenance ?"}
            </DialogTitle>
            <DialogDescription>
              {pendingAction?.row.vehicleName} ({pendingAction?.row.licensePlate}) —{" "}
              {pendingAction?.kind === "complete"
                ? "La date de fin sera enregistrée automatiquement."
                : "Cette maintenance restera visible dans l'historique en statut annulé."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAction(null)}>
              Retour
            </Button>
            <Button
              variant={pendingAction?.kind === "cancel" ? "destructive" : "default"}
              onClick={handleConfirmAction}
              disabled={isSubmitting}
            >
              {isSubmitting ? "Enregistrement..." : "Confirmer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
