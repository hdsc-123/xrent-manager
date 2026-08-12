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
  Input,
  Label,
} from "@/components/ui";

interface Vehicle {
  id: string;
  name: string;
  licensePlate: string;
}

const TYPE_OPTIONS = [
  { value: "OIL_CHANGE", label: "Vidange" },
  { value: "TIRE_CHANGE", label: "Changement de pneus" },
  { value: "INSPECTION", label: "Contrôle technique" },
  { value: "REPAIR", label: "Réparation" },
  { value: "OTHER", label: "Autre" },
];

export default function NewMaintenancePage() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleId, setVehicleId] = useState("");
  const [type, setType] = useState("OIL_CHANGE");
  const [scheduledDate, setScheduledDate] = useState("");
  const [cost, setCost] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    apiGet<{ vehicles: Vehicle[] }>("/api/vehicles")
      .then((data) => setVehicles(data.vehicles))
      .catch(() => setVehicles([]));
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!vehicleId || !scheduledDate) {
      setError("Véhicule et date prévue sont requis.");
      return;
    }

    let costCentimes: number | undefined;
    if (cost.trim() !== "") {
      const costEuros = Number(cost.replace(",", "."));
      if (!Number.isFinite(costEuros) || costEuros < 0) {
        setError("Le coût doit être un nombre positif ou nul.");
        return;
      }
      costCentimes = Math.round(costEuros * 100);
    }

    setIsSubmitting(true);
    try {
      await apiPost("/api/maintenances", {
        vehicleId,
        type,
        scheduledDate,
        cost: costCentimes,
        notes: notes || undefined,
      });
      toast.success("Maintenance planifiée.");
      router.push("/dashboard/maintenances");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold">Planifier une maintenance</h1>

      <Card>
        <CardHeader>
          <CardTitle>Informations</CardTitle>
          <CardDescription>Véhicule, type d&apos;entretien et date prévue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vehicleId">Véhicule</Label>
              <select
                id="vehicleId"
                required
                value={vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="" disabled>
                  Sélectionner un véhicule
                </option>
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicle.name} ({vehicle.licensePlate})
                  </option>
                ))}
              </select>
              {vehicles.length === 0 && (
                <p className="text-xs text-muted-foreground">Aucun véhicule accessible.</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="type">Type</Label>
                <select
                  id="type"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  {TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="scheduledDate">Date prévue</Label>
                <Input
                  id="scheduledDate"
                  type="date"
                  required
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cost">
                Coût estimé (MAD) <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notes">
                Notes <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex gap-2">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Création..." : "Planifier"}
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Annuler
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
