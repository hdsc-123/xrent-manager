"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { formatMoney } from "@/lib/format";
import { apiPatch, apiDelete, ApiError } from "@/lib/api";
import { useStepUpRetry } from "@/lib/step-up-retry";
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
  Icon,
  Input,
  Label,
} from "@/components/ui";

const CATEGORY_OPTIONS = ["VERSEMENT", "COMMISSION", "VIREMENT"];

export interface EntryRow {
  id: string;
  category: string | null;
  amount: number;
  currency: string;
  description: string | null;
  contractNumber: string | null;
  clientName: string | null;
  paymentMethod: string | null;
  createdAt: string;
  /** Sprint 19 : présent uniquement pour une écriture issue d'un paiement — voir
   * CashEntry.contractId, src/lib/cash-register.ts. Une écriture manuelle (contractId
   * absent) est seule modifiable/supprimable, voir canEdit/canDelete ci-dessous. */
  contractId: string | null;
}

const METHOD_LABELS: Record<string, string> = {
  CASH: "Espèces",
  CARD: "Carte",
  BANK_TRANSFER: "Virement",
  CHECK: "Chèque",
  OTHER: "Autre",
};

export function EntriesTable({
  entries,
  canEdit = false,
  canDelete = false,
}: {
  entries: EntryRow[];
  /** cash_register.edit (Sprint 19) — n'a d'effet que sur les écritures manuelles (contractId absent). */
  canEdit?: boolean;
  /** cash_register.delete (Sprint 19) — idem. */
  canDelete?: boolean;
}) {
  const router = useRouter();
  const withStepUpRetry = useStepUpRetry();
  const [editing, setEditing] = useState<EntryRow | null>(null);
  const [editCategory, setEditCategory] = useState(CATEGORY_OPTIONS[0]);
  const [editAmount, setEditAmount] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<EntryRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  function openEdit(entry: EntryRow) {
    setEditing(entry);
    setEditCategory(entry.category ?? CATEGORY_OPTIONS[0]);
    setEditAmount(String(entry.amount / 100));
    setEditDescription(entry.description ?? "");
    setEditError(null);
  }

  async function handleSaveEdit() {
    if (!editing) return;
    const amountMad = Number(editAmount.replace(",", "."));
    if (!Number.isFinite(amountMad) || amountMad <= 0) {
      setEditError("Le montant doit être un nombre positif.");
      return;
    }
    setIsSaving(true);
    setEditError(null);
    try {
      await withStepUpRetry(() =>
        apiPatch(`/api/cash-register/${editing.id}`, {
          category: editCategory,
          amount: Math.round(amountMad * 100),
          description: editDescription,
        })
      );
      toast.success("Écriture mise à jour.");
      setEditing(null);
      router.refresh();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      await withStepUpRetry(() => apiDelete(`/api/cash-register/${pendingDelete.id}`));
      toast.success("Écriture supprimée.");
      setPendingDelete(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la suppression.");
    } finally {
      setIsDeleting(false);
    }
  }

  const showActions = canEdit || canDelete;

  const columns = useMemo<DataTableColumn<EntryRow>[]>(
    () => [
      {
        id: "createdAt",
        header: "Date",
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleString("fr-FR"),
      },
      { accessorKey: "category", header: "Catégorie", cell: ({ getValue }) => getValue<string>() ?? "—" },
      { accessorKey: "description", header: "Description", cell: ({ getValue }) => getValue<string>() ?? "—" },
      {
        accessorKey: "contractNumber",
        header: "N° contrat",
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      { accessorKey: "clientName", header: "Client", cell: ({ getValue }) => getValue<string>() ?? "—" },
      {
        accessorKey: "paymentMethod",
        header: "Mode",
        cell: ({ getValue }) => {
          const method = getValue<string | null>();
          return method ? <Badge variant="outline">{METHOD_LABELS[method] ?? method}</Badge> : "—";
        },
      },
      {
        id: "amount",
        header: "Montant",
        meta: { align: "right" },
        cell: ({ row }) => `+${formatMoney(row.original.amount, row.original.currency)}`,
      },
      ...(showActions
        ? [
            {
              id: "actions",
              header: "",
              cell: ({ row }: { row: { original: EntryRow } }) => {
                const entry = row.original;
                const isManual = entry.contractId === null;
                if (!isManual) {
                  return null;
                }
                return (
                  <div className="flex justify-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <Icon icon={MoreHorizontal} className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canEdit && (
                          <DropdownMenuItem onClick={() => openEdit(entry)}>
                            <Icon icon={Pencil} className="size-4" />
                            Modifier
                          </DropdownMenuItem>
                        )}
                        {canDelete && (
                          <DropdownMenuItem variant="destructive" onClick={() => setPendingDelete(entry)}>
                            <Icon icon={Trash2} className="size-4" />
                            Supprimer
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              },
            } satisfies DataTableColumn<EntryRow>,
          ]
        : []),
    ],
    [showActions, canEdit, canDelete]
  );

  return (
    <>
      <DataTable columns={columns} data={entries} emptyMessage="Aucune entrée." />

      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modifier l&apos;entrée</DialogTitle>
            <DialogDescription>Écriture manuelle uniquement — les entrées liées à un paiement ne sont pas modifiables.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-entry-category">Catégorie</Label>
              <select
                id="edit-entry-category"
                value={editCategory}
                onChange={(e) => setEditCategory(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-entry-amount" required>Montant (MAD)</Label>
              <Input
                id="edit-entry-amount"
                inputMode="decimal"
                required
                value={editAmount}
                onChange={(e) => setEditAmount(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-entry-description">Description</Label>
              <Input id="edit-entry-description" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
            </div>
            {editError && (
              <p role="alert" className="text-sm text-destructive">
                {editError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Annuler
            </Button>
            <Button onClick={handleSaveEdit} disabled={isSaving}>
              {isSaving ? "Enregistrement..." : "Enregistrer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer cette entrée ?</DialogTitle>
            <DialogDescription>Cette action est irréversible.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Annuler
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
