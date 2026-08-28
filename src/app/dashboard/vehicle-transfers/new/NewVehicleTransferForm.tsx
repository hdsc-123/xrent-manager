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

interface NewVehicleTransferFormProps {
  /** Sprint 24 (DOMAINRULES.md) : agences réellement accessibles à l'appelant (toutes celles
   * du tenant pour un ADMIN, sinon uniquement celles rattachées via UserAgency) — voir
   * page.tsx. Remplace l'ancien sélecteur libre parmi toutes les agences du tenant. */
  ownAgencies: Agency[];
}

export function NewVehicleTransferForm({ ownAgencies }: NewVehicleTransferFormProps) {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [destinationAgencies, setDestinationAgencies] = useState<Agency[]>([]);

  // Sprint 24 : la ville/agence de départ est désormais dérivée de l'agence de l'utilisateur
  // (verrouillée, non modifiable) — un seul choix possible pour un user rattaché à une seule
  // agence (le cas le plus courant), pré-sélectionné automatiquement et non éditable. Un user
  // rattaché à plusieurs agences (ou un ADMIN) choisit uniquement parmi les siennes, jamais
  // une agence à laquelle il n'est pas rattaché.
  const [fromAgencyId, setFromAgencyId] = useState(ownAgencies.length === 1 ? ownAgencies[0].id : "");
  const fromAgencyLocked = ownAgencies.length === 1;
  const [vehicleId, setVehicleId] = useState("");
  const [toAgencyId, setToAgencyId] = useState("");
  const [departureDate, setDepartureDate] = useState(() => toDatetimeLocalValue(new Date()));
  // Sprint 24 : kilométrage/carburant de départ ne sont plus modifiables — auto-remplis depuis
  // le dernier état connu du véhicule (GET /api/vehicles/[id]/last-known-state) puis verrouillés.
  const [startOdometer, setStartOdometer] = useState<number | null>(null);
  const [startFuelLevel, setStartFuelLevel] = useState<number | null>(null);
  const [responsibleUserId, setResponsibleUserId] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [users, setUsers] = useState<User[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    apiGet<{ agencies: Agency[] }>("/api/agencies")
      .then((data) => setDestinationAgencies(data.agencies))
      .catch(() => setDestinationAgencies([]));
    // Sprint 24 : annuaire déjà filtré par agence/ville de l'appelant côté serveur (voir
    // GET /api/users/directory) — un agent ne voit que les responsables/agents de sa propre
    // agence ou ville, plus aucun user d'une autre agence/ville.
    apiGet<{ users: User[] }>("/api/users/directory")
      .then((data) => setUsers(data.users))
      .catch(() => setUsers([]));
  }, []);

  // Sprint 19 : véhicules filtrés à l'agence de départ (désormais verrouillée sur l'agence de
  // l'utilisateur, Sprint 24), pas la liste complète du tenant.
  useEffect(() => {
    if (!fromAgencyId) return;
    apiGet<{ vehicles: Vehicle[] }>(`/api/vehicles?status=AVAILABLE&excludeDeactivated=true&agencyId=${fromAgencyId}`)
      .then((data) => setVehicles(data.vehicles))
      .catch(() => setVehicles([]));
  }, [fromAgencyId]);

  // Sprint 19 : dernier kilométrage/carburant connus du véhicule choisi, pré-remplis
  // automatiquement — Sprint 24 : non modifiables ensuite (verrouillés). Le reset lorsque
  // vehicleId redevient vide se fait dans le onChange du sélecteur d'agence (synchrone, voir
  // plus bas), pas ici, pour ne jamais appeler setState directement dans le corps d'un effet.
  useEffect(() => {
    if (!vehicleId) return;
    apiGet<{ odometer: number | null; fuelLevel: number | null }>(`/api/vehicles/${vehicleId}/last-known-state`)
      .then((data) => {
        setStartOdometer(data.odometer);
        setStartFuelLevel(data.fuelLevel);
      })
      .catch(() => {
        setStartOdometer(null);
        setStartFuelLevel(null);
      });
  }, [vehicleId]);

  const fromAgency = ownAgencies.find((agency) => agency.id === fromAgencyId) ?? null;
  const toAgency = destinationAgencies.find((agency) => agency.id === toAgencyId) ?? null;
  const availableDestinationAgencies = destinationAgencies.filter((agency) => agency.id !== fromAgencyId);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!fromAgencyId || !vehicleId || !toAgencyId || !responsibleUserId) {
      setError("Agence de départ, véhicule, agence d'arrivée et responsable sont requis.");
      return;
    }

    setIsSubmitting(true);
    try {
      await apiPost("/api/vehicle-transfers", {
        vehicleId,
        toAgencyId,
        fromCity: fromAgency?.city ?? undefined,
        toCity: toAgency?.city ?? undefined,
        departureDate: departureDate || undefined,
        // Sprint 24 : toujours la valeur verrouillée telle qu'auto-remplie, jamais une saisie
        // libre — envoyée telle quelle (undefined si jamais connue pour ce véhicule).
        startOdometer: startOdometer ?? undefined,
        startFuelLevel: startFuelLevel ?? undefined,
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
              <Label htmlFor="fromAgencyId" required>
                Agence de départ (station) <span className="text-muted-foreground">— votre agence, verrouillée</span>
              </Label>
              {fromAgencyLocked ? (
                <Input id="fromAgencyId" value={fromAgency?.name ?? ""} disabled />
              ) : (
                <select
                  id="fromAgencyId"
                  required
                  value={fromAgencyId}
                  onChange={(e) => {
                    setFromAgencyId(e.target.value);
                    setVehicleId("");
                    setVehicles([]);
                    setStartOdometer(null);
                    setStartFuelLevel(null);
                  }}
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  <option value="" disabled>
                    Sélectionner votre agence de départ
                  </option>
                  {ownAgencies.map((agency) => (
                    <option key={agency.id} value={agency.id}>
                      {agency.name}
                    </option>
                  ))}
                </select>
              )}
              {ownAgencies.length === 0 && (
                <p className="text-xs text-destructive">
                  Vous n&apos;êtes rattaché à aucune agence — un ADMIN doit vous en assigner une avant de pouvoir
                  lancer un transfert.
                </p>
              )}
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
                {availableDestinationAgencies.map((agency) => (
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
                  Kilométrage départ <span className="text-muted-foreground">— auto, verrouillé</span>
                </Label>
                <Input id="startOdometer" value={startOdometer ?? "—"} disabled />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startFuelLevel">
                  Carburant départ <span className="text-muted-foreground">— auto, verrouillé</span>
                </Label>
                <FuelLevelSelect
                  id="startFuelLevel"
                  value={startFuelLevel !== null ? String(startFuelLevel) : ""}
                  onChange={() => {}}
                  disabled
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
