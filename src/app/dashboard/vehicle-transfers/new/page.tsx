"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@/components/ui";

interface Vehicle {
  id: string;
  name: string;
  licensePlate: string;
  agencyId: string;
  status: string;
}

interface Agency {
  id: string;
  name: string;
}

interface User {
  id: string;
  name: string;
}

export default function NewVehicleTransferPage() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [users, setUsers] = useState<User[]>([]);

  const [vehicleId, setVehicleId] = useState("");
  const [toAgencyId, setToAgencyId] = useState("");
  const [fromCity, setFromCity] = useState("");
  const [toCity, setToCity] = useState("");
  const [departureDate, setDepartureDate] = useState("");
  const [startOdometer, setStartOdometer] = useState("");
  const [startFuelLevel, setStartFuelLevel] = useState("");
  const [responsibleUserId, setResponsibleUserId] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    apiGet<{ vehicles: Vehicle[] }>("/api/vehicles?status=AVAILABLE")
      .then((data) => setVehicles(data.vehicles))
      .catch(() => setVehicles([]));
    apiGet<{ agencies: Agency[] }>("/api/agencies")
      .then((data) => setAgencies(data.agencies))
      .catch(() => setAgencies([]));
    apiGet<{ users: User[] }>("/api/users/directory")
      .then((data) => setUsers(data.users))
      .catch(() => setUsers([]));
  }, []);

  const selectedVehicle = vehicles.find((vehicle) => vehicle.id === vehicleId) ?? null;
  const destinationAgencies = agencies.filter((agency) => agency.id !== selectedVehicle?.agencyId);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!vehicleId || !toAgencyId || !responsibleUserId) {
      setError("Véhicule, agence d'arrivée et responsable sont requis.");
      return;
    }

    const startOdometerValue = startOdometer.trim() === "" ? undefined : Number(startOdometer);
    if (startOdometerValue !== undefined && (!Number.isInteger(startOdometerValue) || startOdometerValue < 0)) {
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
      await apiPost("/api/vehicle-transfers", {
        vehicleId,
        toAgencyId,
        fromCity: fromCity || undefined,
        toCity: toCity || undefined,
        departureDate: departureDate || undefined,
        startOdometer: startOdometerValue,
        startFuelLevel: startFuelLevelValue,
        responsibleUserId,
        reason: reason || undefined,
        notes: notes || undefined,
      });
      toast.success("Transfert lancé — le véhicule n'est plus proposé comme disponible.");
      router.push("/dashboard/vehicle-transfers");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold">Nouveau transfert entre agences</h1>

      <Card>
        <CardHeader>
          <CardTitle>Informations</CardTitle>
          <CardDescription>Le véhicule ne sera plus proposé comme disponible une fois le transfert lancé.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vehicleId" required>Véhicule</Label>
              <select
                id="vehicleId"
                required
                value={vehicleId}
                onChange={(e) => {
                  setVehicleId(e.target.value);
                  setToAgencyId("");
                }}
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
                <p className="text-xs text-muted-foreground">Aucun véhicule disponible pour un transfert.</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="toAgencyId" required>Agence d&apos;arrivée</Label>
              <select
                id="toAgencyId"
                required
                value={toAgencyId}
                onChange={(e) => setToAgencyId(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                disabled={!vehicleId}
              >
                <option value="" disabled>
                  Sélectionner l&apos;agence de destination
                </option>
                {destinationAgencies.map((agency) => (
                  <option key={agency.id} value={agency.id}>
                    {agency.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fromCity">Ville de départ</Label>
                <Input id="fromCity" value={fromCity} onChange={(e) => setFromCity(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="toCity">Ville d&apos;arrivée</Label>
                <Input id="toCity" value={toCity} onChange={(e) => setToCity(e.target.value)} />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="departureDate">
                Date de départ <span className="text-muted-foreground">— optionnel, maintenant par défaut</span>
              </Label>
              <Input
                id="departureDate"
                type="datetime-local"
                value={departureDate}
                onChange={(e) => setDepartureDate(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startOdometer">Kilométrage départ</Label>
                <Input id="startOdometer" inputMode="numeric" value={startOdometer} onChange={(e) => setStartOdometer(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startFuelLevel">Carburant départ (%)</Label>
                <Input
                  id="startFuelLevel"
                  inputMode="numeric"
                  value={startFuelLevel}
                  onChange={(e) => setStartFuelLevel(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="responsibleUserId" required>Responsable</Label>
              <select
                id="responsibleUserId"
                required
                value={responsibleUserId}
                onChange={(e) => setResponsibleUserId(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="" disabled>
                  Sélectionner un responsable
                </option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reason">
                Motif <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
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
                {isSubmitting ? "Lancement..." : "Lancer le transfert"}
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
