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
  Checkbox,
  FuelLevelSelect,
  Input,
  Label,
} from "@/components/ui";

interface Vehicle {
  id: string;
  name: string;
  licensePlate: string;
  status: string;
  /** Optionnel (Sprint 14A) — informatif seulement, jamais la source de vérité de la
   * facturation (voir DOMAINRULES.md section 5/7) : le prix réel est saisi ci-dessous. */
  pricePerDay: number | null;
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

const PAYMENT_METHOD_OPTIONS = [
  { value: "CASH", label: "Espèces" },
  { value: "CARD", label: "Carte" },
  { value: "BANK_TRANSFER", label: "Virement" },
  { value: "CHECK", label: "Chèque" },
  { value: "OTHER", label: "Autre" },
] as const;

type PaymentMethodValue = (typeof PAYMENT_METHOD_OPTIONS)[number]["value"];

export function NewLocationForm() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [vehicleId, setVehicleId] = useState("");
  const [clientId, setClientId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("10:00");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("10:00");
  const [pricePerDay, setPricePerDay] = useState("");
  const [startOdometer, setStartOdometer] = useState("");
  const [startFuelLevel, setStartFuelLevel] = useState("");
  const [endOdometer, setEndOdometer] = useState("");
  const [deposit, setDeposit] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<"PENDING" | "CONFIRMED">("PENDING");
  const [availabilityCheck, setAvailabilityCheck] = useState<AvailabilityCheck | null>(null);

  function handleStartTimeChange(value: string) {
    setStartTime(value);
    setEndTime(value);
  }

  const [paymentDeferred, setPaymentDeferred] = useState(false);
  const [paymentMixed, setPaymentMixed] = useState(false);
  const [paymentPartial, setPaymentPartial] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodValue>("CASH");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod1, setPaymentMethod1] = useState<PaymentMethodValue>("CASH");
  const [paymentAmount1, setPaymentAmount1] = useState("");
  const [paymentMethod2, setPaymentMethod2] = useState<PaymentMethodValue>("CARD");
  const [paymentAmount2, setPaymentAmount2] = useState("");

  const [showNewClient, setShowNewClient] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [isCreatingClient, setIsCreatingClient] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    apiGet<{ vehicles: Vehicle[] }>("/api/vehicles?status=AVAILABLE&excludeDeactivated=true")
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

  // Le prix véhicule (s'il existe) ne sert que de valeur par défaut — jamais la source de
  // vérité de la facturation (DOMAINRULES.md section 5/7). Pré-rempli à chaque changement de
  // véhicule (setState pendant le rendu, pas dans un effet — "Adjusting state when a prop
  // changes" de la doc React, même pattern que la détection de changement d'agence
  // ailleurs dans le projet), modifiable ensuite librement par l'utilisateur.
  const [pricePerDayVehicleId, setPricePerDayVehicleId] = useState(vehicleId);
  if (vehicleId !== pricePerDayVehicleId) {
    setPricePerDayVehicleId(vehicleId);
    setPricePerDay(selectedVehicle?.pricePerDay != null ? (selectedVehicle.pricePerDay / 100).toFixed(2) : "");
  }

  // Sprint 24-1 : le kilométrage/carburant de départ du contrat prennent comme point de départ
  // le dernier état connu du véhicule (getVehicleLastKnownState, src/lib/vehicles.ts — retombe
  // lui-même sur Vehicle.currentOdometer/currentFuelLevel si le véhicule n'a encore jamais été
  // loué/transféré/déplacé, Sprint 24) — même source que les formulaires de transfert/bon de
  // déplacement. Contrairement à ces derniers, les champs restent modifiables ensuite (pas
  // verrouillés) : un contrat capture un état réel au comptoir, qui peut légitimement différer de
  // la dernière valeur enregistrée en base.
  useEffect(() => {
    if (!vehicleId) return;
    let cancelled = false;
    apiGet<{ odometer: number | null; fuelLevel: number | null }>(`/api/vehicles/${vehicleId}/last-known-state`)
      .then((data) => {
        if (cancelled) return;
        setStartOdometer(data.odometer !== null ? String(data.odometer) : "");
        setStartFuelLevel(data.fuelLevel !== null ? String(data.fuelLevel) : "");
      })
      .catch(() => {
        if (!cancelled) {
          setStartOdometer("");
          setStartFuelLevel("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [vehicleId]);

  const pricePerDayCentimes = useMemo(() => {
    if (!pricePerDay.trim()) return null;
    const value = Number(pricePerDay.replace(",", "."));
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null;
  }, [pricePerDay]);

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

  const estimatedTotal = pricePerDayCentimes && days > 0 ? pricePerDayCentimes * days : 0;

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

    if (!pricePerDayCentimes) {
      setError("Le prix / jour doit être renseigné (un nombre positif).");
      return;
    }

    const depositMad = deposit ? Number(deposit.replace(",", ".")) : undefined;
    if (deposit && (!Number.isFinite(depositMad) || (depositMad as number) < 0)) {
      setError("La caution doit être un nombre positif.");
      return;
    }

    let payment: Record<string, unknown> | undefined;
    if (paymentDeferred) {
      payment = { deferred: true };
    } else if (paymentMixed) {
      const amount1Centimes = paymentAmount1 ? Math.round(Number(paymentAmount1.replace(",", ".")) * 100) : 0;
      const amount2Centimes = paymentAmount2 ? Math.round(Number(paymentAmount2.replace(",", ".")) * 100) : 0;
      if (amount1Centimes <= 0 && amount2Centimes <= 0) {
        setError("Le paiement mixte nécessite au moins un montant.");
        return;
      }
      if (estimatedTotal > 0 && amount1Centimes + amount2Centimes > estimatedTotal) {
        setError("Le total des deux montants dépasse le prix de la location.");
        return;
      }
      payment = {
        mixed: true,
        method1: paymentMethod1,
        amount1: amount1Centimes > 0 ? amount1Centimes : undefined,
        method2: paymentMethod2,
        amount2: amount2Centimes > 0 ? amount2Centimes : undefined,
      };
    } else {
      const amountCentimes = paymentAmount ? Math.round(Number(paymentAmount.replace(",", ".")) * 100) : undefined;
      if (paymentPartial) {
        if (!amountCentimes || amountCentimes <= 0) {
          setError("Le montant payé doit être renseigné pour un paiement partiel.");
          return;
        }
        if (estimatedTotal > 0 && amountCentimes > estimatedTotal) {
          setError("Le montant payé dépasse le prix de la location.");
          return;
        }
      }
      payment = { method: paymentMethod, partial: paymentPartial, amount: paymentPartial ? amountCentimes : undefined };
    }

    setIsSubmitting(true);
    try {
      const { location, paymentError } = await apiPost<{
        location: { id: string };
        paymentError: string | null;
      }>("/api/locations", {
        vehicleId,
        clientId,
        startDate: startDateTime.toISOString(),
        endDate: endDateTime.toISOString(),
        notes: notes || undefined,
        status,
        pricePerDay: pricePerDayCentimes,
        startOdometer: startOdometer ? Number(startOdometer) : undefined,
        startFuelLevel: startFuelLevel ? Number(startFuelLevel) : undefined,
        endOdometer: endOdometer ? Number(endOdometer) : undefined,
        deposit: depositMad !== undefined ? Math.round(depositMad * 100) : undefined,
        payment,
      });
      if (paymentError) {
        toast.warning(`Location créée, mais le paiement n'a pas pu être enregistré : ${paymentError}`);
      } else {
        toast.success("Location créée.");
      }
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
                    {vehicle.pricePerDay !== null
                      ? ` — ${formatMoney(vehicle.pricePerDay, vehicle.currency)}/jour (indicatif)`
                      : ""}
                  </option>
                ))}
              </select>
              {vehicles.length === 0 && (
                <p className="text-xs text-muted-foreground">Aucun véhicule disponible actuellement.</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startDate" required>Date de début</Label>
                <Input
                  id="startDate"
                  type="date"
                  required
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startTime" required>Heure de début</Label>
                <Input
                  id="startTime"
                  type="time"
                  required
                  value={startTime}
                  onChange={(e) => handleStartTimeChange(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="endDate" required>Date de fin</Label>
                <Input
                  id="endDate"
                  type="date"
                  required
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="endTime" required>Heure de fin</Label>
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pricePerDay" required>Prix / jour</Label>
              <Input
                id="pricePerDay"
                inputMode="decimal"
                required
                placeholder="450.00"
                value={pricePerDay}
                onChange={(e) => setPricePerDay(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Prix réel de cette location — le prix véhicule (s&apos;il existe) n&apos;est qu&apos;une
                valeur par défaut.
              </p>
            </div>

            {selectedVehicle && days > 0 && pricePerDayCentimes && (
              <p className="text-sm text-muted-foreground">
                {days} jour(s) × {formatMoney(pricePerDayCentimes, selectedVehicle.currency)} ={" "}
                <span className="font-medium text-foreground">
                  {formatMoney(estimatedTotal, selectedVehicle.currency)}
                </span>
              </p>
            )}

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="clientId" required>Client</Label>
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
                  Kilométrage départ{" "}
                  <span className="text-muted-foreground">
                    — optionnel, prérempli depuis le dernier état connu du véhicule
                  </span>
                </Label>
                <Input
                  id="startOdometer"
                  type="number"
                  value={startOdometer}
                  onChange={(e) => setStartOdometer(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startFuelLevel">
                  Carburant départ <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <FuelLevelSelect id="startFuelLevel" value={startFuelLevel} onChange={setStartFuelLevel} />
              </div>
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

            <div className="flex flex-col gap-3 rounded-md border border-border p-3">
              <span className="text-sm font-medium">Paiement</span>

              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={paymentDeferred}
                  onCheckedChange={(checked) => setPaymentDeferred(checked === true)}
                />
                Paiement au retour (la facture reste à régler)
              </label>

              {!paymentDeferred && (
                <>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={paymentMixed}
                      onCheckedChange={(checked) => {
                        setPaymentMixed(checked === true);
                        if (checked === true) setPaymentPartial(false);
                      }}
                    />
                    Paiement mixte (deux modes de règlement)
                  </label>

                  {paymentMixed ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="paymentMethod1">Mode 1</Label>
                        <select
                          id="paymentMethod1"
                          value={paymentMethod1}
                          onChange={(e) => setPaymentMethod1(e.target.value as PaymentMethodValue)}
                          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                        >
                          {PAYMENT_METHOD_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <Input
                          inputMode="decimal"
                          placeholder="Montant 1 (MAD)"
                          value={paymentAmount1}
                          onChange={(e) => setPaymentAmount1(e.target.value)}
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="paymentMethod2">Mode 2</Label>
                        <select
                          id="paymentMethod2"
                          value={paymentMethod2}
                          onChange={(e) => setPaymentMethod2(e.target.value as PaymentMethodValue)}
                          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                        >
                          {PAYMENT_METHOD_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <Input
                          inputMode="decimal"
                          placeholder="Montant 2 (MAD)"
                          value={paymentAmount2}
                          onChange={(e) => setPaymentAmount2(e.target.value)}
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="paymentMethod">Mode de paiement</Label>
                        <select
                          id="paymentMethod"
                          value={paymentMethod}
                          onChange={(e) => setPaymentMethod(e.target.value as PaymentMethodValue)}
                          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                        >
                          {PAYMENT_METHOD_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={paymentPartial}
                          onCheckedChange={(checked) => setPaymentPartial(checked === true)}
                        />
                        Paiement partiel
                      </label>

                      {paymentPartial && (
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="paymentAmount">Montant payé (MAD)</Label>
                          <Input
                            id="paymentAmount"
                            inputMode="decimal"
                            value={paymentAmount}
                            onChange={(e) => setPaymentAmount(e.target.value)}
                          />
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
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
