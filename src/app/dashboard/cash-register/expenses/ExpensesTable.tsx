"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { formatMoney } from "@/lib/format";
import { apiPatch, apiDelete, ApiError } from "@/lib/api";
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
  Icon,
  Input,
  Label,
} from "@/components/ui";

export interface ExpenseRow {
  id: string;
  category: string | null;
  amount: number;
  currency: string;
  description: string | null;
  createdAt: string;
  /** Sprint 19 : toujours absent aujourd'hui pour une dépense (seules les entrées ENTRY sont
   * créées automatiquement depuis un paiement), conservé par cohérence/défense en profondeur
   * avec EntriesTable — voir CashEntry.contractId, src/lib/cash-register.ts. */
  contractId: string | null;
}

export function ExpensesTable({
  expenses,
  categories = [],
  canEdit = false,
  canDelete = false,
}: {
  expenses: ExpenseRow[];
  categories?: { id: string; name: string }[];
  /** cash_register.edit (Sprint 19) — n'a d'effet que sur les écritures manuelles (contractId absent). */
  canEdit?: boolean;
  /** cash_register.delete (Sprint 19) — idem. */
  canDelete?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<ExpenseRow | null>(null);
  const [editCategory, setEditCategory] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ExpenseRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  function openEdit(expense: ExpenseRow) {
    setEditing(expense);
    setEditCategory(expense.category ?? "");
    setEditAmount(String(expense.amount / 100));
    setEditDescription(expense.description ?? "");
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
      await apiPatch(`/api/cash-register/${editing.id}`, {
        category: editCategory,
        amount: Math.round(amountMad * 100),
        description: editDescription,
      });
      toast.success("Dépense mise à jour.");
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
      await apiDelete(`/api/cash-register/${pendingDelete.id}`);
      toast.success("Dépense supprimée.");
      setPendingDelete(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la suppression.");
    } finally {
      setIsDeleting(false);
    }
  }

  const showActions = canEdit || canDelete;

  const columns = useMemo<DataTableColumn<ExpenseRow>[]>(
    () => [
      {
        id: "createdAt",
        header: "Date",
        cell: ({ row }) => new Date(row.original.createdAt).toLocaleString("fr-FR"),
      },
      { accessorKey: "category", header: "Catégorie", cell: ({ getValue }) => getValue<string>() ?? "—" },
      { accessorKey: "description", header: "Description", cell: ({ getValue }) => getValue<string>() ?? "—" },
      {
        id: "amount",
        header: "Montant",
        meta: { align: "right" },
        cell: ({ row }) => `-${formatMoney(row.original.amount, row.original.currency)}`,
      },
      ...(showActions
        ? [
            {
              id: "actions",
              header: "",
              cell: ({ row }: { row: { original: ExpenseRow } }) => {
                const expense = row.original;
                const isManual = expense.contractId === null;
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
                          <DropdownMenuItem onClick={() => openEdit(expense)}>
                            <Icon icon={Pencil} className="size-4" />
                            Modifier
                          </DropdownMenuItem>
                        )}
                        {canDelete && (
                          <DropdownMenuItem variant="destructive" onClick={() => setPendingDelete(expense)}>
                            <Icon icon={Trash2} className="size-4" />
                            Supprimer
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              },
            } satisfies DataTableColumn<ExpenseRow>,
          ]
        : []),
    ],
    [showActions, canEdit, canDelete]
  );

  return (
    <>
      <DataTable columns={columns} data={expenses} emptyMessage="Aucune dépense." />

      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modifier la dépense</DialogTitle>
            <DialogDescription>Écriture manuelle uniquement.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-expense-category">Catégorie</Label>
              {categories.length > 0 ? (
                <select
                  id="edit-expense-category"
                  value={editCategory}
                  onChange={(e) => setEditCategory(e.target.value)}
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  {!categories.some((c) => c.name === editCategory) && editCategory && (
                    <option value={editCategory}>{editCategory}</option>
                  )}
                  {categories.map((option) => (
                    <option key={option.id} value={option.name}>
                      {option.name}
                    </option>
                  ))}
                </select>
              ) : (
                <Input id="edit-expense-category" value={editCategory} onChange={(e) => setEditCategory(e.target.value)} />
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-expense-amount" required>Montant (MAD)</Label>
              <Input
                id="edit-expense-amount"
                inputMode="decimal"
                required
                value={editAmount}
                onChange={(e) => setEditAmount(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-expense-description">Description</Label>
              <Input
                id="edit-expense-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
              />
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
            <DialogTitle>Supprimer cette dépense ?</DialogTitle>
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
