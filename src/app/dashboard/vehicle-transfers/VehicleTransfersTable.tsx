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
  Input,
  Label,
} from "@/components/ui";

export interface VehicleTransferRow {
  id: string;
  vehicleName: string;
  licensePlate: string;
  fromAgencyName: string;
  toAgencyName: string;
  fromCity: string | null;
  toCity: string | null;
  departureDate: string;
  arrivalDate: string | null;
  startOdometer: number | null;
  responsibleName: string;
  reason: string | null;
  status: string;
  /** true si l'appelant a accès à l'agence d'arrivée (seule habilitée à valider la réception). */
  canValidate: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  IN_TRANSIT: "En transit",
  COMPLETED: "Réceptionné",
  CANCELLED: "Annulé",
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  IN_TRANSIT: "secondary",
  COMPLETED: "default",
  CANCELLED: "destructive",
};

export function VehicleTransfersTable({
  transfers,
  canCancel = false,
}: {
  transfers: VehicleTransferRow[];
  /** vehicle_transfers.cancel (voir src/lib/permissions.ts) — calculé côté serveur par la page
   * appelante. La validation de réception est déjà gérée par row.canValidate (combine agence
   * accessible et vehicle_transfers.validate). */
  canCancel?: boolean;
}) {
  const router = useRouter();
  const [validating, setValidating] = useState<VehicleTransferRow | null>(null);
  const [arrivalOdometer, setArrivalOdometer] = useState("");
  const [arrivalFuelLevel, setArrivalFuelLevel] = useState("");
  const [arrivalDriverName, setArrivalDriverName] = useState("");
  const [pendingCancel, setPendingCancel] = useState<VehicleTransferRow | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openValidate(row: VehicleTransferRow) {
    setError(null);
    setArrivalOdometer("");
    setArrivalFuelLevel("");
    setArrivalDriverName("");
    setValidating(row);
  }

  async function handleValidate() {
    if (!validating) return;
    setError(null);

    // Sprint 24 : kilométrage/carburant/chauffeur d'arrivée deviennent obligatoires à la
    // réception d'un véhicule transféré (voir aussi PATCH .../validate, qui applique la même
    // règle côté serveur, seule garantie réelle — cette vérification n'est qu'une aide UX).
    if (arrivalOdometer.trim() === "") {
      setError("Le kilométrage d'arrivée est requis.");
      return;
    }
    const endOdometer = Number(arrivalOdometer);
    if (!Number.isInteger(endOdometer) || endOdometer < 0) {
      setError("Le kilométrage d'arrivée doit être un entier positif ou nul.");
      return;
    }
    if (arrivalFuelLevel.trim() === "") {
      setError("Le carburant à l'arrivée est requis.");
      return;
    }
    const endFuelLevel = Number(arrivalFuelLevel);
    if (!Number.isInteger(endFuelLevel) || endFuelLevel < 0 || endFuelLevel > 100) {
      setError("Le niveau de carburant doit être un entier entre 0 et 100.");
      return;
    }
    if (arrivalDriverName.trim() === "") {
      setError("Le nom du chauffeur à l'arrivée est requis.");
      return;
    }

    setIsSubmitting(true);
    try {
      await apiPatch(`/api/vehicle-transfers/${validating.id}/validate`, {
        endOdometer,
        endFuelLevel,
        arrivalDriverName: arrivalDriverName.trim(),
      });
      toast.success("Transfert validé — véhicule rattaché à l'agence d'arrivée.");
      setValidating(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erreur lors de la validation.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCancel() {
    if (!pendingCancel) return;
    setIsSubmitting(true);
    try {
      await apiPatch(`/api/vehicle-transfers/${pendingCancel.id}/cancel`, {});
      toast.success("Transfert annulé.");
      setPendingCancel(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de l'annulation.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const columns = useMemo<DataTableColumn<VehicleTransferRow>[]>(
    () => [
      { id: "vehicle", header: "Véhicule", accessorFn: (row) => `${row.vehicleName} (${row.licensePlate})` },
      {
        id: "route",
        header: "De → Vers",
        cell: ({ row }) => (
          <span>
            {row.original.fromAgencyName} → {row.original.toAgencyName}
            {row.original.fromCity || row.original.toCity ? (
              <span className="block text-xs text-muted-foreground">
                {row.original.fromCity ?? "—"} → {row.original.toCity ?? "—"}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "departureDate",
        header: "Date départ",
        cell: ({ row }) => new Date(row.original.departureDate).toLocaleDateString("fr-FR"),
      },
      {
        id: "arrivalDate",
        header: "Date arrivée",
        cell: ({ row }) =>
          row.original.arrivalDate ? new Date(row.original.arrivalDate).toLocaleDateString("fr-FR") : "—",
      },
      { accessorKey: "responsibleName", header: "Responsable" },
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
          const inTransit = row.original.status === "IN_TRANSIT";
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={!inTransit || !row.original.canValidate}
                    onClick={() => openValidate(row.original)}
                  >
                    <CheckCircle2 className="size-4" />
                    Valider la réception
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={!inTransit || !canCancel}
                    onClick={() => setPendingCancel(row.original)}
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
    [canCancel]
  );

  return (
    <>
      <DataTable columns={columns} data={transfers} emptyMessage="Aucun transfert." />

      <Dialog open={Boolean(validating)} onOpenChange={(open) => !open && setValidating(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Valider la réception</DialogTitle>
            <DialogDescription>
              {validating?.vehicleName} ({validating?.licensePlate}) — {validating?.fromAgencyName} →{" "}
              {validating?.toAgencyName}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="arrivalOdometer" required>Kilométrage à l&apos;arrivée</Label>
              <Input
                id="arrivalOdometer"
                required
                inputMode="numeric"
                placeholder={validating?.startOdometer != null ? `≥ ${validating.startOdometer}` : undefined}
                value={arrivalOdometer}
                onChange={(e) => setArrivalOdometer(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              {/* Sprint 24 : jauge métier (Vide/1-4/2-4/3-4/Plein), alignée sur le carburant
                  départ (transferts) et sur les bons de déplacement — un champ numérique libre
                  était jusqu'ici seul incohérent avec le reste de l'app. */}
              <Label htmlFor="arrivalFuelLevel" required>Carburant à l&apos;arrivée</Label>
              <FuelLevelSelect id="arrivalFuelLevel" required value={arrivalFuelLevel} onChange={setArrivalFuelLevel} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="arrivalDriverName" required>Nom du chauffeur à l&apos;arrivée</Label>
              <Input
                id="arrivalDriverName"
                required
                value={arrivalDriverName}
                onChange={(e) => setArrivalDriverName(e.target.value)}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setValidating(null)}>
              Retour
            </Button>
            <Button onClick={handleValidate} disabled={isSubmitting}>
              {isSubmitting ? "Validation..." : "Valider"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(pendingCancel)} onOpenChange={(open) => !open && setPendingCancel(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Annuler le transfert ?</DialogTitle>
            <DialogDescription>
              {pendingCancel?.vehicleName} ({pendingCancel?.licensePlate}) — le véhicule redevient disponible à
              l&apos;agence de départ.
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
