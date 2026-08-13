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

interface LocationOption {
  id: string;
  startDate: string;
  endDate: string;
  totalPrice: number;
  currency: string;
  vehicleId: string;
  clientId: string;
  clientName: string;
  vehicleName: string;
  licensePlate: string;
}

export default function NewInvoicePage() {
  const router = useRouter();
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locationId, setLocationId] = useState("");
  const [taxRatePercent, setTaxRatePercent] = useState("0");
  const [discountAmount, setDiscountAmount] = useState("0");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    // /api/locations ne renvoie pas les relations client/vehicle : jointure faite ici
    // côté client à partir de /api/clients et /api/vehicles (déjà chargés par ailleurs).
    Promise.all([
      apiGet<{
        locations: {
          id: string;
          startDate: string;
          endDate: string;
          totalPrice: number;
          currency: string;
          vehicleId: string;
          clientId: string;
        }[];
      }>("/api/locations"),
      apiGet<{ clients: { id: string; name: string }[] }>("/api/clients"),
      apiGet<{ vehicles: { id: string; name: string; licensePlate: string }[] }>("/api/vehicles"),
    ])
      .then(([locationsData, clientsData, vehiclesData]) => {
        const clientsById = new Map(clientsData.clients.map((client) => [client.id, client]));
        const vehiclesById = new Map(vehiclesData.vehicles.map((vehicle) => [vehicle.id, vehicle]));

        setLocations(
          locationsData.locations.map((location) => ({
            id: location.id,
            startDate: location.startDate,
            endDate: location.endDate,
            totalPrice: location.totalPrice,
            currency: location.currency,
            vehicleId: location.vehicleId,
            clientId: location.clientId,
            clientName: clientsById.get(location.clientId)?.name ?? "—",
            vehicleName: vehiclesById.get(location.vehicleId)?.name ?? "—",
            licensePlate: vehiclesById.get(location.vehicleId)?.licensePlate ?? "—",
          }))
        );
      })
      .catch(() => setLocations([]));
  }, []);

  const selectedLocation = useMemo(
    () => locations.find((location) => location.id === locationId) ?? null,
    [locations, locationId]
  );

  const preview = useMemo(() => {
    if (!selectedLocation) return null;
    const taxRatePoints = Math.round(Number(taxRatePercent.replace(",", ".")) * 100);
    const discount = Math.round(Number(discountAmount.replace(",", ".")) * 100);
    if (!Number.isFinite(taxRatePoints) || !Number.isFinite(discount)) return null;
    const taxAmount = Math.round((selectedLocation.totalPrice * taxRatePoints) / 10_000);
    const totalAmount = selectedLocation.totalPrice - discount + taxAmount;
    return { taxAmount, totalAmount };
  }, [selectedLocation, taxRatePercent, discountAmount]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!locationId) {
      setError("Sélectionnez une location.");
      return;
    }

    const taxRatePoints = Math.round(Number(taxRatePercent.replace(",", ".")) * 100);
    const discount = Math.round(Number(discountAmount.replace(",", ".")) * 100);
    if (!Number.isInteger(taxRatePoints) || taxRatePoints < 0) {
      setError("Le taux de TVA doit être un nombre positif ou nul.");
      return;
    }
    if (!Number.isInteger(discount) || discount < 0) {
      setError("La remise doit être un nombre positif ou nul.");
      return;
    }

    setIsSubmitting(true);
    try {
      const { invoice } = await apiPost<{ invoice: { id: string } }>("/api/invoices", {
        locationId,
        taxRate: taxRatePoints,
        discountAmount: discount,
        dueDate: dueDate || undefined,
        notes: notes || undefined,
      });
      toast.success("Facture créée.");
      router.push(`/dashboard/invoices/${invoice.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold">Créer une facture</h1>

      <Card>
        <CardHeader>
          <CardTitle>Informations</CardTitle>
          <CardDescription>La facture reprend le montant total de la location sélectionnée.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="locationId" required>Location</Label>
              <select
                id="locationId"
                required
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="" disabled>
                  Sélectionner une location
                </option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.clientName} — {location.vehicleName} ({location.licensePlate}) —{" "}
                    {new Date(location.startDate).toLocaleDateString("fr-FR")} →{" "}
                    {new Date(location.endDate).toLocaleDateString("fr-FR")} —{" "}
                    {formatMoney(location.totalPrice, location.currency)}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="taxRate">TVA (%)</Label>
                <Input
                  id="taxRate"
                  inputMode="decimal"
                  value={taxRatePercent}
                  onChange={(e) => setTaxRatePercent(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="discountAmount">Remise (MAD)</Label>
                <Input
                  id="discountAmount"
                  inputMode="decimal"
                  value={discountAmount}
                  onChange={(e) => setDiscountAmount(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dueDate">
                Échéance <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="dueDate" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notes">
                Notes <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>

            {selectedLocation && preview && (
              <p className="text-sm text-muted-foreground">
                Sous-total {formatMoney(selectedLocation.totalPrice, selectedLocation.currency)} + TVA{" "}
                {formatMoney(preview.taxAmount, selectedLocation.currency)} ={" "}
                <span className="font-medium text-foreground">
                  {formatMoney(preview.totalAmount, selectedLocation.currency)}
                </span>
              </p>
            )}

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex gap-2">
              <Button type="submit" disabled={isSubmitting}>
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
