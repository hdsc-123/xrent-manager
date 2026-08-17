"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { apiPost, ApiError } from "@/lib/api";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Icon,
  Input,
  Label,
} from "@/components/ui";
import { PermissionCheckboxGrid, type PermissionDef } from "./PermissionCheckboxGrid";

export interface PermissionGroupRow {
  id: string;
  name: string;
  permissionCount: number;
}

export function PermissionGroupsPanel({
  groups,
  permissions,
}: {
  groups: PermissionGroupRow[];
  permissions: PermissionDef[];
}) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Le nom est requis.");
      return;
    }

    setIsSubmitting(true);
    try {
      await apiPost("/api/permission-groups", { name, permissions: Array.from(selected) });
      toast.success("Groupe créé.");
      setDialogOpen(false);
      setName("");
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const columns = useMemo<DataTableColumn<PermissionGroupRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Nom",
        cell: ({ row }) => (
          <Link href={`/dashboard/permission-groups/${row.original.id}`} className="underline">
            {row.original.name}
          </Link>
        ),
      },
      { accessorKey: "permissionCount", header: "Permissions" },
    ],
    []
  );

  return (
    <>
      <div className="flex justify-end">
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button />}>
            <Icon icon={Plus} className="size-4" />
            Créer un groupe
          </DialogTrigger>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Créer un groupe de permissions</DialogTitle>
              <DialogDescription>Sélectionnez les permissions accordées à ce groupe.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name" required>Nom</Label>
                <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
              </div>

              <PermissionCheckboxGrid permissions={permissions} selected={selected} onChange={setSelected} />

              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                  Annuler
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Création..." : "Créer"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <DataTable columns={columns} data={groups} emptyMessage="Aucun groupe de permissions." />
    </>
  );
}
