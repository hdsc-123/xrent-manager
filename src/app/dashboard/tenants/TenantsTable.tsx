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

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export function TenantsTable({ tenants }: { tenants: TenantRow[] }) {
  const router = useRouter();
  const [pendingDelete, setPendingDelete] = useState<TenantRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleDelete() {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      await apiDelete(`/api/tenants/${pendingDelete.id}`);
      toast.success("Tenant supprimé.");
      setPendingDelete(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la suppression.");
    } finally {
      setIsDeleting(false);
    }
  }

  const columns = useMemo<DataTableColumn<TenantRow>[]>(
    () => [
      { accessorKey: "name", header: "Nom" },
      { accessorKey: "slug", header: "Slug" },
      {
        accessorKey: "createdAt",
        header: "Créé le",
        cell: ({ getValue }) => new Date(getValue<string>()).toLocaleDateString("fr-FR"),
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
                <DropdownMenuItem render={<Link href={`/dashboard/tenants/${row.original.id}`} />}>
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
    ],
    []
  );

  return (
    <>
      <DataTable columns={columns} data={tenants} emptyMessage="Aucun tenant." />

      <Dialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer le tenant ?</DialogTitle>
            <DialogDescription>
              Cette action est irréversible. Le tenant « {pendingDelete?.name} » ne peut être
              supprimé que s&apos;il n&apos;a plus aucune agence ni utilisateur actif.
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
