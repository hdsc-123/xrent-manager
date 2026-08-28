"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FuelLevelSelect, Input, Label } from "@/components/ui";

interface Vehicle {
  id: string;
  name: string;
  licensePlate: string;
}

interface User {
  id: string;
  name: string;
}

export function NewVehicleTripForm() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [users, setUsers] = useState<User[]>([]);

  const [vehicleId, setVehicleId] = useState("");
  const [employeeUserId, setEmployeeUserId] = useState("");
  const [reason, setReason] = useState("");
  const [destination, setDestination] = useState("");
  const [startOdometer, setStartOdometer] = useState("");
  const [startFuelLevel, setStartFuelLevel] = useState("");
  const [remarks, setRemarks] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    apiGet<{ vehicles: Vehicle[] }>("/api/vehicles?status=AVAILABLE&excludeDeactivated=true")
      .then((data) => setVehicles(data.vehicles))
      .catch(() => setVehicles([]));
    apiGet<{ users: User[] }>("/api/users/directory")
      .then((data) => setUsers(data.users))
      .catch(() => setUsers([]));
  }, []);

  // Sprint 19 (DOMAINRULES.md section 37) : dernier kilométrage/carburant connus du véhicule
  // choisi, pré-remplis automatiquement — même logique que les transferts entre agences, voir
  // GET /api/vehicles/[id]/last-known-state. Sprint 24 : non modifiables ensuite (verrouillés),
  // même correctif que NewVehicleTransferForm.tsx pour un comportement cohérent partout où le
  // kilométrage/carburant de départ d'un mouvement est auto-rempli. Aucun reset à "" nécessaire
  // ici (pas d'effet de bord synchrone dans l'effet) : vehicleId ne revient jamais à "" après
  // une première sélection dans ce formulaire (sélecteur unique, sans option vide re-sélectionnable),
  // et l'état initial est déjà "" (useState).
  useEffect(() => {
    if (!vehicleId) return;
    apiGet<{ odometer: number | null; fuelLevel: number | null }>(`/api/vehicles/${vehicleId}/last-known-state`)
      .then((data) => {
        setStartOdometer(data.odometer !== null ? String(data.odometer) : "");
        setStartFuelLevel(data.fuelLevel !== null ? String(data.fuelLevel) : "");
      })
      .catch(() => {
        setStartOdometer("");
        setStartFuelLevel("");
      });
  }, [vehicleId]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!vehicleId || !employeeUserId || !reason.trim() || !destination.trim() || startOdometer.trim() === "") {
      setError("Véhicule, employé, motif et destination sont requis (kilométrage de départ inconnu pour ce véhicule).");
      return;
    }

    const startOdometerValue = Number(startOdometer);
    if (!Number.isInteger(startOdometerValue) || startOdometerValue < 0) {
      setError("Le kilométrage de départ doit être un entier positif ou nul.");
      return;
    }
    const startFuelLevelValue = startFuelLevel.trim() === "" ? undefined : Number(startFuelLevel);
    if (
      startFuelLevelValue !== undefined &&
      (!Number.isInteger(startFuelLevelValue) || startFuelLevelValue < 0 || startFuelLevelValue > 100)
    ) {
      setError("Le niveau de carburant doit être un entier entre 0 et 100.");
      return;
    }

    setIsSubmitting(true);
    try {
      await apiPost("/api/vehicle-trips", {
        vehicleId,
        employeeUserId,
        reason,
        destination,
        startOdometer: startOdometerValue,
        startFuelLevel: startFuelLevelValue,
        remarks: remarks || undefined,
      });
      toast.success("Bon de déplacement créé — départ enregistré.");
      router.push("/dashboard/vehicle-trips");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold">Nouveau bon de déplacement</h1>

      <Card>
        <CardHeader>
          <CardTitle>Informations</CardTitle>
          <CardDescription>
            Déplacement professionnel interne — le départ (km, carburant) est enregistré immédiatement.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vehicleId" required>Véhicule</Label>
              <select
                id="vehicleId"
                required
                value={vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="" disabled>
                  Sélectionner un véhicule disponible
                </option>
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicle.name} ({vehicle.licensePlate})
                  </option>
                ))}
              </select>
              {vehicles.length === 0 && (
                <p className="text-xs text-muted-foreground">Aucun véhicule disponible pour un déplacement.</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="employeeUserId" required>Employé</Label>
              <select
                id="employeeUserId"
                required
                value={employeeUserId}
                onChange={(e) => setEmployeeUserId(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="" disabled>
                  Sélectionner un employé
                </option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="destination" required>Destination</Label>
              <Input id="destination" required value={destination} onChange={(e) => setDestination(e.target.value)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reason" required>Motif</Label>
              <Input id="reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startOdometer" required>
                  Kilométrage départ <span className="text-muted-foreground">— auto, verrouillé</span>
                </Label>
                <Input id="startOdometer" value={startOdometer || "—"} disabled />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startFuelLevel">
                  Carburant départ <span className="text-muted-foreground">— auto, verrouillé</span>
                </Label>
                <FuelLevelSelect id="startFuelLevel" value={startFuelLevel} onChange={() => {}} disabled />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="remarks">
                Remarques <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex gap-2">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Création..." : "Enregistrer le départ"}
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
