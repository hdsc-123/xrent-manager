"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Eye, Trash2, Ban, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { apiDelete, apiPost, ApiError } from "@/lib/api";
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
  Icon,
  Input,
  Label,
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
  /** État administratif (sprint "statut opérationnel automatique", 2026-08-28) — remplace
   * l'ancien VehicleStatus.INACTIVE, orthogonal au statut opérationnel calculé ci-dessus. */
  deactivatedAt: string | null;
  deactivatedReason: string | null;
  /** Optionnel (Sprint 14A) — informatif, jamais la source de vérité de la facturation. */
  pricePerDay: number | null;
  currency: string;
  agencyName: string;
}

const STATUS_LABELS: Record<string, string> = {
  AVAILABLE: "Disponible",
  RENTED: "Loué",
  MAINTENANCE: "Maintenance",
  TRANSFERRING: "En transfert",
  ON_TRIP: "En déplacement",
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  AVAILABLE: "default",
  RENTED: "secondary",
  MAINTENANCE: "outline",
  TRANSFERRING: "outline",
  ON_TRIP: "outline",
};

export function VehiclesTable({
  vehicles,
  canDelete = false,
  canDeactivate = false,
}: {
  vehicles: VehicleRow[];
  /** vehicles.delete (voir src/lib/permissions.ts) — masque la suppression si absent,
   * calculé côté serveur par la page appelante. */
  canDelete?: boolean;
  /** Désactivation/réactivation réservée ADMIN (contrôle de rôle strict côté route, voir
   * POST /api/vehicles/[id]/deactivate|reactivate) — calculé côté serveur par la page appelante. */
  canDeactivate?: boolean;
}) {
  const router = useRouter();
  const [pendingDelete, setPendingDelete] = useState<VehicleRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [pendingDeactivate, setPendingDeactivate] = useState<VehicleRow | null>(null);
  const [deactivateReason, setDeactivateReason] = useState("");
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [pendingReactivate, setPendingReactivate] = useState<VehicleRow | null>(null);
  const [isReactivating, setIsReactivating] = useState(false);

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

  async function handleDeactivate() {
    if (!pendingDeactivate || !deactivateReason.trim()) return;
    setIsDeactivating(true);
    try {
      await apiPost(`/api/vehicles/${pendingDeactivate.id}/deactivate`, { reason: deactivateReason.trim() });
      toast.success("Véhicule désactivé.");
      setPendingDeactivate(null);
      setDeactivateReason("");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la désactivation.");
    } finally {
      setIsDeactivating(false);
    }
  }

  async function handleReactivate() {
    if (!pendingReactivate) return;
    setIsReactivating(true);
    try {
      await apiPost(`/api/vehicles/${pendingReactivate.id}/reactivate`, {});
      toast.success("Véhicule réactivé.");
      setPendingReactivate(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la réactivation.");
    } finally {
      setIsReactivating(false);
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
        header: "Statut opérationnel",
        cell: ({ getValue }) => {
          const status = getValue<string>();
          return <Badge variant={STATUS_VARIANTS[status] ?? "outline"}>{STATUS_LABELS[status] ?? status}</Badge>;
        },
      },
      {
        id: "administrativeState",
        header: "État",
        cell: ({ row }) =>
          row.original.deactivatedAt ? (
            <Badge variant="destructive">Désactivé</Badge>
          ) : (
            <Badge variant="outline">Actif</Badge>
          ),
      },
      {
        id: "pricePerDay",
        header: "Prix / jour",
        meta: { align: "right" },
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
                <Icon icon={MoreHorizontal} className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem render={<Link href={`/dashboard/vehicles/${row.original.id}`} />}>
                  <Icon icon={Eye} className="size-4" />
                  Détails
                </DropdownMenuItem>
                {canDeactivate && !row.original.deactivatedAt && (
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setPendingDeactivate(row.original)}
                  >
                    <Icon icon={Ban} className="size-4" />
                    Désactiver
                  </DropdownMenuItem>
                )}
                {canDeactivate && row.original.deactivatedAt && (
                  <DropdownMenuItem onClick={() => setPendingReactivate(row.original)}>
                    <Icon icon={RotateCcw} className="size-4" />
                    Réactiver
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setPendingDelete(row.original)}
                  >
                    <Icon icon={Trash2} className="size-4" />
                    Supprimer
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [canDelete, canDeactivate]
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

      <Dialog
        open={Boolean(pendingDeactivate)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeactivate(null);
            setDeactivateReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Désactiver le véhicule ?</DialogTitle>
            <DialogDescription>
              Le véhicule « {pendingDeactivate?.name} » ne pourra plus recevoir de nouvelle
              location, maintenance, transfert ou déplacement tant qu&apos;il n&apos;aura pas été
              réactivé. Un motif est obligatoire.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="deactivateReason">Motif</Label>
            <Input
              id="deactivateReason"
              value={deactivateReason}
              onChange={(e) => setDeactivateReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPendingDeactivate(null);
                setDeactivateReason("");
              }}
            >
              Annuler
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeactivate}
              disabled={isDeactivating || !deactivateReason.trim()}
            >
              {isDeactivating ? "Désactivation..." : "Désactiver"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(pendingReactivate)} onOpenChange={(open) => !open && setPendingReactivate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Réactiver le véhicule ?</DialogTitle>
            <DialogDescription>
              Le véhicule « {pendingReactivate?.name} » redeviendra utilisable pour de nouvelles
              opérations.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingReactivate(null)}>
              Annuler
            </Button>
            <Button onClick={handleReactivate} disabled={isReactivating}>
              {isReactivating ? "Réactivation..." : "Réactiver"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
