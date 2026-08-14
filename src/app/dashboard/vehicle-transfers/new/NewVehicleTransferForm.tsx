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
  agencyId: string;
  status: string;
}

interface Agency {
  id: string;
  name: string;
  city: string | null;
}

interface User {
  id: string;
  name: string;
}

function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function NewVehicleTransferForm() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [users, setUsers] = useState<User[]>([]);

  // Sprint 19 (DOMAINRULES.md section 37) : agence de départ (station) choisie en premier —
  // le sélecteur de véhicule ne propose ensuite que les véhicules de cette agence, plus de
  // liste tenant-wide (bug corrigé : un agent voyait jusqu'ici tous les véhicules disponibles
  // de toutes les agences, pas seulement les siens).
  const [fromAgencyId, setFromAgencyId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [toAgencyId, setToAgencyId] = useState("");
  const [departureDate, setDepartureDate] = useState(() => toDatetimeLocalValue(new Date()));
  const [startOdometer, setStartOdometer] = useState("");
  const [startFuelLevel, setStartFuelLevel] = useState("");
  const [responsibleUserId, setResponsibleUserId] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    apiGet<{ agencies: Agency[] }>("/api/agencies")
      .then((data) => setAgencies(data.agencies))
      .catch(() => setAgencies([]));
    apiGet<{ users: User[] }>("/api/users/directory")
      .then((data) => setUsers(data.users))
      .catch(() => setUsers([]));
  }, []);

  // Sprint 19 : véhicules filtrés à l'agence de départ choisie (station), pas la liste
  // complète du tenant — voir le commentaire ci-dessus. Le reset de vehicleId se fait dans le
  // onChange du sélecteur d'agence (synchrone), pas ici, pour ne jamais appeler setState
  // directement dans le corps d'un effet.
  useEffect(() => {
    if (!fromAgencyId) return;
    apiGet<{ vehicles: Vehicle[] }>(`/api/vehicles?status=AVAILABLE&agencyId=${fromAgencyId}`)
      .then((data) => setVehicles(data.vehicles))
      .catch(() => setVehicles([]));
  }, [fromAgencyId]);

  // Sprint 19 : dernier kilométrage/carburant connus du véhicule choisi, pré-remplis
  // automatiquement (modifiables ensuite) — voir GET /api/vehicles/[id]/last-known-state.
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

  const fromAgency = agencies.find((agency) => agency.id === fromAgencyId) ?? null;
  const toAgency = agencies.find((agency) => agency.id === toAgencyId) ?? null;
  const destinationAgencies = agencies.filter((agency) => agency.id !== fromAgencyId);

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

    setIsSubmitting(true);
    try {
      await apiPost("/api/vehicle-transfers", {
        vehicleId,
        toAgencyId,
        fromCity: fromAgency?.city ?? undefined,
        toCity: toAgency?.city ?? undefined,
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
              <Label htmlFor="fromAgencyId" required>Agence de départ (station)</Label>
              <select
                id="fromAgencyId"
                required
                value={fromAgencyId}
                onChange={(e) => {
                  setFromAgencyId(e.target.value);
                  setVehicleId("");
                  setVehicles([]);
                }}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="" disabled>
                  Sélectionner l&apos;agence de départ
                </option>
                {agencies.map((agency) => (
                  <option key={agency.id} value={agency.id}>
                    {agency.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vehicleId" required>Véhicule</Label>
              <select
                id="vehicleId"
                required
                value={vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                disabled={!fromAgencyId}
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
              {fromAgencyId && vehicles.length === 0 && (
                <p className="text-xs text-muted-foreground">Aucun véhicule disponible dans cette agence.</p>
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
                <Input id="fromCity" value={fromAgency?.city ?? ""} disabled placeholder="Dérivée de l'agence" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="toCity">Ville d&apos;arrivée</Label>
                <Input id="toCity" value={toAgency?.city ?? ""} disabled placeholder="Dérivée de l'agence" />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="departureDate" required>Date de départ</Label>
              <Input
                id="departureDate"
                type="datetime-local"
                required
                value={departureDate}
                onChange={(e) => setDepartureDate(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startOdometer">
                  Kilométrage départ <span className="text-muted-foreground">— auto, modifiable</span>
                </Label>
                <Input id="startOdometer" inputMode="numeric" value={startOdometer} onChange={(e) => setStartOdometer(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startFuelLevel">
                  Carburant départ <span className="text-muted-foreground">— auto, modifiable</span>
                </Label>
                <FuelLevelSelect id="startFuelLevel" value={startFuelLevel} onChange={setStartFuelLevel} />
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
