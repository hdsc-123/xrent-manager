"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiDelete, ApiError } from "@/lib/api";
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
} from "@/components/ui";

export interface AgencyRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export function AgenciesTable({
  agencies,
  canManage,
}: {
  agencies: AgencyRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pendingDelete, setPendingDelete] = useState<AgencyRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleDelete() {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      await apiDelete(`/api/agencies/${pendingDelete.id}`);
      toast.success("Agence supprimée.");
      setPendingDelete(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la suppression.");
    } finally {
      setIsDeleting(false);
    }
  }

  const columns = useMemo<DataTableColumn<AgencyRow>[]>(() => {
    const base: DataTableColumn<AgencyRow>[] = [
      { accessorKey: "name", header: "Nom" },
      { accessorKey: "slug", header: "Slug" },
      {
        accessorKey: "createdAt",
        header: "Créée le",
        cell: ({ getValue }) => new Date(getValue<string>()).toLocaleDateString("fr-FR"),
      },
    ];

    if (!canManage) {
      return base;
    }

    return [
      ...base,
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
                <DropdownMenuItem render={<Link href={`/dashboard/agencies/${row.original.id}`} />}>
                  <Pencil className="size-4" />
                  Modifier
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setPendingDelete(row.original)}
                >
                  <Trash2 className="size-4" />
                  Supprimer
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ];
  }, [canManage]);

  return (
    <>
      <DataTable columns={columns} data={agencies} emptyMessage="Aucune agence." />

      <Dialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer l&apos;agence ?</DialogTitle>
            <DialogDescription>
              Cette action est irréversible. L&apos;agence « {pendingDelete?.name} » ne peut être
              supprimée que si elle n&apos;a plus d&apos;utilisateurs rattachés.
            </DialogDescription>
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
