"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Eye, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiDelete, ApiError } from "@/lib/api";
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

export interface VehicleRow {
  id: string;
  name: string;
  licensePlate: string;
  make: string;
  model: string;
  year: number;
  category: string;
  status: string;
  /** Optionnel (Sprint 14A) — informatif, jamais la source de vérité de la facturation. */
  pricePerDay: number | null;
  currency: string;
  agencyName: string;
}

const STATUS_LABELS: Record<string, string> = {
  AVAILABLE: "Disponible",
  RENTED: "Loué",
  MAINTENANCE: "Maintenance",
  INACTIVE: "Inactif",
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  AVAILABLE: "default",
  RENTED: "secondary",
  MAINTENANCE: "outline",
  INACTIVE: "destructive",
};

export function VehiclesTable({ vehicles }: { vehicles: VehicleRow[] }) {
  const router = useRouter();
  const [pendingDelete, setPendingDelete] = useState<VehicleRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleDelete() {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      await apiDelete(`/api/vehicles/${pendingDelete.id}`);
      toast.success("Véhicule supprimé.");
      setPendingDelete(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la suppression.");
    } finally {
      setIsDeleting(false);
    }
  }

  const columns = useMemo<DataTableColumn<VehicleRow>[]>(
    () => [
      { accessorKey: "name", header: "Nom" },
      { accessorKey: "licensePlate", header: "Immatriculation" },
      {
        id: "makeModel",
        header: "Marque / modèle",
        accessorFn: (row) => `${row.make} ${row.model} (${row.year})`,
      },
      { accessorKey: "category", header: "Catégorie" },
      { accessorKey: "agencyName", header: "Agence" },
      {
        accessorKey: "status",
        header: "Statut",
        cell: ({ getValue }) => {
          const status = getValue<string>();
          return <Badge variant={STATUS_VARIANTS[status] ?? "outline"}>{STATUS_LABELS[status] ?? status}</Badge>;
        },
      },
      {
        id: "pricePerDay",
        header: "Prix / jour",
        cell: ({ row }) =>
          row.original.pricePerDay !== null
            ? formatMoney(row.original.pricePerDay, row.original.currency)
            : "—",
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
                <DropdownMenuItem render={<Link href={`/dashboard/vehicles/${row.original.id}`} />}>
                  <Eye className="size-4" />
                  Détails
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
      <DataTable columns={columns} data={vehicles} emptyMessage="Aucun véhicule." />

      <Dialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer le véhicule ?</DialogTitle>
            <DialogDescription>
              Cette action est irréversible. Le véhicule « {pendingDelete?.name} » ne peut être
              supprimé que s&apos;il n&apos;a aucune location associée.
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
