"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
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
  FuelLevelSelect,
  Icon,
  Input,
  Label,
} from "@/components/ui";

export interface VehicleTripRow {
  id: string;
  vehicleName: string;
  licensePlate: string;
  agencyName: string;
  employeeName: string;
  reason: string;
  destination: string;
  departureDate: string;
  returnDate: string | null;
  startOdometer: number;
  endOdometer: number | null;
  status: string;
}

const STATUS_LABELS: Record<string, string> = {
  IN_PROGRESS: "En cours",
  COMPLETED: "Terminé",
  CANCELLED: "Annulé",
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  IN_PROGRESS: "secondary",
  COMPLETED: "default",
  CANCELLED: "destructive",
};

export function VehicleTripsTable({
  trips,
  canReturn = false,
  canCancel = false,
}: {
  trips: VehicleTripRow[];
  /** vehicle_trips.return (voir src/lib/permissions.ts) — calculé côté serveur par la page
   * appelante. */
  canReturn?: boolean;
  /** vehicle_trips.cancel */
  canCancel?: boolean;
}) {
  const router = useRouter();
  const [returning, setReturning] = useState<VehicleTripRow | null>(null);
  const [endOdometer, setEndOdometer] = useState("");
  const [endFuelLevel, setEndFuelLevel] = useState("");
  const [pendingCancel, setPendingCancel] = useState<VehicleTripRow | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openReturn(row: VehicleTripRow) {
    setError(null);
    setEndOdometer("");
    setEndFuelLevel("");
    setReturning(row);
  }

  async function handleReturn() {
    if (!returning) return;
    setError(null);

    const endOdometerValue = Number(endOdometer);
    if (endOdometer.trim() === "" || !Number.isInteger(endOdometerValue)) {
      setError("Le kilométrage de retour est requis.");
      return;
    }
    if (endOdometerValue <= returning.startOdometer) {
      setError(`Le kilométrage de retour doit être strictement supérieur à ${returning.startOdometer}.`);
      return;
    }
    // Sprint 19 (DOMAINRULES.md section 37) : désormais obligatoire au retour.
    if (endFuelLevel.trim() === "") {
      setError("Le niveau de carburant de retour est requis.");
      return;
    }
    const endFuelLevelValue = Number(endFuelLevel);
    if (!Number.isInteger(endFuelLevelValue) || endFuelLevelValue < 0 || endFuelLevelValue > 100) {
      setError("Le niveau de carburant doit être un entier entre 0 et 100.");
      return;
    }

    setIsSubmitting(true);
    try {
      await apiPatch(`/api/vehicle-trips/${returning.id}/return`, {
        endOdometer: endOdometerValue,
        endFuelLevel: endFuelLevelValue,
      });
      toast.success("Retour enregistré — véhicule à nouveau disponible.");
      setReturning(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erreur lors de l'enregistrement du retour.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCancel() {
    if (!pendingCancel) return;
    setIsSubmitting(true);
    try {
      await apiPatch(`/api/vehicle-trips/${pendingCancel.id}/cancel`, {});
      toast.success("Bon de déplacement annulé.");
      setPendingCancel(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de l'annulation.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const columns = useMemo<DataTableColumn<VehicleTripRow>[]>(
    () => [
      { id: "vehicle", header: "Véhicule", accessorFn: (row) => `${row.vehicleName} (${row.licensePlate})` },
      { accessorKey: "employeeName", header: "Employé" },
      { accessorKey: "destination", header: "Destination" },
      { accessorKey: "reason", header: "Motif" },
      {
        id: "departureDate",
        header: "Départ",
        cell: ({ row }) => new Date(row.original.departureDate).toLocaleString("fr-FR"),
      },
      {
        id: "returnDate",
        header: "Retour",
        cell: ({ row }) =>
          row.original.returnDate ? new Date(row.original.returnDate).toLocaleString("fr-FR") : "—",
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
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const inProgress = row.original.status === "IN_PROGRESS";
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                  <Icon icon={MoreHorizontal} className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={!inProgress || !canReturn} onClick={() => openReturn(row.original)}>
                    <Icon icon={CheckCircle2} className="size-4" />
                    Enregistrer le retour
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={!inProgress || !canCancel}
                    onClick={() => setPendingCancel(row.original)}
                  >
                    <Icon icon={XCircle} className="size-4" />
                    Annuler
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    [canReturn, canCancel]
  );

  return (
    <>
      <DataTable columns={columns} data={trips} emptyMessage="Aucun bon de déplacement." />

      <Dialog open={Boolean(returning)} onOpenChange={(open) => !open && setReturning(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enregistrer le retour</DialogTitle>
            <DialogDescription>
              {returning?.vehicleName} ({returning?.licensePlate}) — départ à {returning?.startOdometer} km
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="endOdometer" required>
                Kilométrage retour
              </Label>
              <Input
                id="endOdometer"
                inputMode="numeric"
                placeholder={returning ? `> ${returning.startOdometer}` : undefined}
                value={endOdometer}
                onChange={(e) => setEndOdometer(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="endFuelLevel" required>Carburant retour</Label>
              <FuelLevelSelect id="endFuelLevel" value={endFuelLevel} onChange={setEndFuelLevel} required />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReturning(null)}>
              Retour
            </Button>
            <Button onClick={handleReturn} disabled={isSubmitting}>
              {isSubmitting ? "Enregistrement..." : "Confirmer le retour"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(pendingCancel)} onOpenChange={(open) => !open && setPendingCancel(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Annuler le bon de déplacement ?</DialogTitle>
            <DialogDescription>
              {pendingCancel?.vehicleName} ({pendingCancel?.licensePlate}) — le véhicule redevient disponible.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingCancel(null)}>
              Retour
            </Button>
            <Button variant="destructive" onClick={handleCancel} disabled={isSubmitting}>
              {isSubmitting ? "Annulation..." : "Confirmer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
