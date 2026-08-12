"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";
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
  status: string;
  pricePerDay: number;
  currency: string;
}

interface Client {
  id: string;
  name: string;
}

interface AvailabilityResult {
  available: boolean;
  conflictingLocations: { startDate: string; endDate: string }[];
}

interface AvailabilityCheck {
  key: string;
  result: AvailabilityResult | "error";
}

export default function NewLocationPage() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [vehicleId, setVehicleId] = useState("");
  const [clientId, setClientId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("10:00");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("10:00");
  const [startOdometer, setStartOdometer] = useState("");
  const [endOdometer, setEndOdometer] = useState("");
  const [deposit, setDeposit] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<"PENDING" | "CONFIRMED">("PENDING");
  const [availabilityCheck, setAvailabilityCheck] = useState<AvailabilityCheck | null>(null);

  const [showNewClient, setShowNewClient] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [isCreatingClient, setIsCreatingClient] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    apiGet<{ vehicles: Vehicle[] }>("/api/vehicles?status=AVAILABLE")
      .then((data) => setVehicles(data.vehicles))
      .catch(() => setVehicles([]));
    apiGet<{ clients: Client[] }>("/api/clients")
      .then((data) => setClients(data.clients))
      .catch(() => setClients([]));
  }, []);

  const selectedVehicle = useMemo(
    () => vehicles.find((vehicle) => vehicle.id === vehicleId) ?? null,
    [vehicles, vehicleId]
  );

  const startDateTime = useMemo(() => {
    if (!startDate || !startTime) return null;
    const value = new Date(`${startDate}T${startTime}`);
    return Number.isNaN(value.getTime()) ? null : value;
  }, [startDate, startTime]);

  const endDateTime = useMemo(() => {
    if (!endDate || !endTime) return null;
    const value = new Date(`${endDate}T${endTime}`);
    return Number.isNaN(value.getTime()) ? null : value;
  }, [endDate, endTime]);

  /** Même règle que calculateTotalPrice (src/lib/locations.ts) : jours arrondis au jour
   * supérieur, minimum 1 jour — tout dépassement, même d'une minute, compte comme un jour
   * supplémentaire. */
  const days = useMemo(() => {
    if (!startDateTime || !endDateTime || endDateTime <= startDateTime) return 0;
    return Math.max(
      1,
      Math.ceil((endDateTime.getTime() - startDateTime.getTime()) / (24 * 60 * 60 * 1000))
    );
  }, [startDateTime, endDateTime]);

  const estimatedTotal = selectedVehicle && days > 0 ? selectedVehicle.pricePerDay * days : 0;

  const availabilityKey =
    vehicleId && startDateTime && endDateTime && days > 0
      ? `${vehicleId}|${startDateTime.toISOString()}|${endDateTime.toISOString()}`
      : null;

  useEffect(() => {
    if (!availabilityKey || !startDateTime || !endDateTime) return;

    let cancelled = false;
    apiGet<AvailabilityResult>(
      `/api/vehicles/${vehicleId}/availability?start=${encodeURIComponent(
        startDateTime.toISOString()
      )}&end=${encodeURIComponent(endDateTime.toISOString())}`
    )
      .then((result) => {
        if (!cancelled) setAvailabilityCheck({ key: availabilityKey, result });
      })
      .catch(() => {
        if (!cancelled) setAvailabilityCheck({ key: availabilityKey, result: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [availabilityKey, vehicleId, startDateTime, endDateTime]);

  // "checking" et "availability" sont dérivés (pas de setState synchrone dans l'effet) :
  // tant qu'aucun résultat ne correspond à la clé véhicule+dates courante, on est en attente.
  const checkingAvailability = availabilityKey !== null && availabilityCheck?.key !== availabilityKey;
  const availabilityResult =
    availabilityKey && availabilityCheck?.key === availabilityKey ? availabilityCheck.result : null;
  const availability = availabilityResult && availabilityResult !== "error" ? availabilityResult : null;

  async function handleCreateClient() {
    if (!newClientName) return;
    setIsCreatingClient(true);
    try {
      const { client } = await apiPost<{ client: Client }>("/api/clients", {
        name: newClientName,
        email: newClientEmail || undefined,
        phone: newClientPhone || undefined,
      });
      setClients((current) => [...current, client]);
      setClientId(client.id);
      setShowNewClient(false);
      setNewClientName("");
      setNewClientEmail("");
      setNewClientPhone("");
      toast.success("Client créé.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la création du client.");
    } finally {
      setIsCreatingClient(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!vehicleId || !clientId || !startDateTime || !endDateTime) {
      setError("Véhicule, client, dates et heures sont requis.");
      return;
    }

    if (availability && !availability.available) {
      setError("Le véhicule n'est pas disponible sur cette période.");
      return;
    }

    const depositMad = deposit ? Number(deposit.replace(",", ".")) : undefined;
    if (deposit && (!Number.isFinite(depositMad) || (depositMad as number) < 0)) {
      setError("La caution doit être un nombre positif.");
      return;
    }

    setIsSubmitting(true);
    try {
      const { location } = await apiPost<{ location: { id: string } }>("/api/locations", {
        vehicleId,
        clientId,
        startDate: startDateTime.toISOString(),
        endDate: endDateTime.toISOString(),
        notes: notes || undefined,
        status,
        startOdometer: startOdometer ? Number(startOdometer) : undefined,
        endOdometer: endOdometer ? Number(endOdometer) : undefined,
        deposit: depositMad !== undefined ? Math.round(depositMad * 100) : undefined,
      });
      toast.success("Location créée.");
      router.push(`/dashboard/locations/${location.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold">Créer une location</h1>

      <Card>
        <CardHeader>
          <CardTitle>Informations</CardTitle>
          <CardDescription>Véhicule disponible, client, période et statut initial.</CardDescription>
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
                  Sélectionner un véhicule disponible
                </option>
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicle.name} ({vehicle.licensePlate}) —{" "}
                    {formatMoney(vehicle.pricePerDay, vehicle.currency)}/jour
                  </option>
                ))}
              </select>
              {vehicles.length === 0 && (
                <p className="text-xs text-muted-foreground">Aucun véhicule disponible actuellement.</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startDate">Date de début</Label>
                <Input
                  id="startDate"
                  type="date"
                  required
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startTime">Heure de début</Label>
                <Input
                  id="startTime"
                  type="time"
                  required
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="endDate">Date de fin</Label>
                <Input
                  id="endDate"
                  type="date"
                  required
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="endTime">Heure de fin</Label>
                <Input
                  id="endTime"
                  type="time"
                  required
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              </div>
            </div>

            {checkingAvailability && (
              <p className="text-xs text-muted-foreground">Vérification de la disponibilité...</p>
            )}
            {availability && !availability.available && (
              <p role="alert" className="text-sm text-destructive">
                Véhicule indisponible sur cette période ({availability.conflictingLocations.length}{" "}
                conflit(s)).
              </p>
            )}
            {selectedVehicle && days > 0 && (
              <p className="text-sm text-muted-foreground">
                {days} jour(s) × {formatMoney(selectedVehicle.pricePerDay, selectedVehicle.currency)} ={" "}
                <span className="font-medium text-foreground">
                  {formatMoney(estimatedTotal, selectedVehicle.currency)}
                </span>
              </p>
            )}

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="clientId">Client</Label>
                <button
                  type="button"
                  onClick={() => setShowNewClient((v) => !v)}
                  className="text-xs text-primary hover:underline"
                >
                  {showNewClient ? "Sélectionner un client existant" : "Nouveau client"}
                </button>
              </div>

              {showNewClient ? (
                <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                  <Input
                    placeholder="Nom"
                    value={newClientName}
                    onChange={(e) => setNewClientName(e.target.value)}
                  />
                  <Input
                    placeholder="Email (optionnel)"
                    value={newClientEmail}
                    onChange={(e) => setNewClientEmail(e.target.value)}
                  />
                  <Input
                    placeholder="Téléphone (optionnel)"
                    value={newClientPhone}
                    onChange={(e) => setNewClientPhone(e.target.value)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!newClientName || isCreatingClient}
                    onClick={handleCreateClient}
                  >
                    {isCreatingClient ? "Création..." : "Créer ce client"}
                  </Button>
                </div>
              ) : (
                <select
                  id="clientId"
                  required
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  <option value="" disabled>
                    Sélectionner un client
                  </option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="status">Statut initial</Label>
              <select
                id="status"
                value={status}
                onChange={(e) => setStatus(e.target.value as "PENDING" | "CONFIRMED")}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="PENDING">En attente</option>
                <option value="CONFIRMED">Confirmée</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startOdometer">
                  Kilométrage départ <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input
                  id="startOdometer"
                  type="number"
                  value={startOdometer}
                  onChange={(e) => setStartOdometer(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="endOdometer">
                  Kilométrage retour <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input
                  id="endOdometer"
                  type="number"
                  value={endOdometer}
                  onChange={(e) => setEndOdometer(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="deposit">
                Caution (MAD) <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input
                id="deposit"
                inputMode="decimal"
                value={deposit}
                onChange={(e) => setDeposit(e.target.value)}
              />
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
              <Button type="submit" disabled={isSubmitting || (availability !== null && !availability.available)}>
                {isSubmitting ? "Création..." : "Créer"}
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
