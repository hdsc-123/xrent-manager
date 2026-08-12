"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";
import { DuplicateCheck, type DuplicateClientInfo } from "../../clients/DuplicateCheck";

interface Vehicle {
  id: string;
  name: string;
  licensePlate: string;
  status: string;
}

interface ConvertReservationCardProps {
  reservationId: string;
  voucherNumber: string;
  canConvert: boolean;
}

export function ConvertReservationCard({ reservationId, voucherNumber, canConvert }: ConvertReservationCardProps) {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleId, setVehicleId] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateClientInfo | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    apiGet<{ vehicles: Vehicle[] }>("/api/vehicles?status=AVAILABLE")
      .then((data) => setVehicles(data.vehicles))
      .catch(() => setVehicles([]));
  }, [isOpen]);

  async function submit(overrides?: { useExistingClientId?: string; forceCreateClient?: boolean }) {
    if (!vehicleId) {
      setError("Sélectionnez un véhicule.");
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await apiPost<{ location: { id: string } }>(`/api/reservations/${reservationId}/convert`, {
        vehicleId,
        ...overrides,
      });
      toast.success("Réservation convertie en contrat.");
      setIsOpen(false);
      router.push(`/dashboard/locations/${result.location.id}`);
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.body &&
        typeof err.body === "object" &&
        "duplicate" in err.body
      ) {
        setDuplicate((err.body as { duplicate: DuplicateClientInfo }).duplicate);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!canConvert) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Convertir en contrat</CardTitle>
        <CardDescription>Crée un client (si nécessaire), une location et une facture.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" onClick={() => setIsOpen(true)}>
          Convertir en contrat
        </Button>
      </CardContent>

      <Dialog open={isOpen} onOpenChange={(open) => !isSubmitting && setIsOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convertir la réservation {voucherNumber}</DialogTitle>
            <DialogDescription>
              Choisissez le véhicule réel qui sera attribué à ce contrat.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="vehicleId" className="text-xs font-medium text-muted-foreground">
              Véhicule
            </label>
            <select
              id="vehicleId"
              value={vehicleId}
              onChange={(e) => setVehicleId(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="">Sélectionner...</option>
              {vehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.name} ({vehicle.licensePlate})
                </option>
              ))}
            </select>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsOpen(false)} disabled={isSubmitting}>
              Annuler
            </Button>
            <Button type="button" onClick={() => submit()} disabled={isSubmitting || !vehicleId}>
              {isSubmitting ? "Conversion..." : "Convertir"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DuplicateCheck
        duplicate={duplicate}
        isSubmitting={isSubmitting}
        onUseExisting={() => {
          const useExistingClientId = duplicate?.client.id;
          setDuplicate(null);
          if (useExistingClientId) {
            void submit({ useExistingClientId });
          }
        }}
        onCreateAnyway={() => {
          setDuplicate(null);
          void submit({ forceCreateClient: true });
        }}
        onCancel={() => setDuplicate(null)}
      />
    </Card>
  );
}
