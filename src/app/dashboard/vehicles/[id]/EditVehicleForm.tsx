"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
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

const STATUS_OPTIONS = [
  { value: "AVAILABLE", label: "Disponible" },
  { value: "RENTED", label: "Loué" },
  { value: "MAINTENANCE", label: "Maintenance" },
  { value: "INACTIVE", label: "Inactif" },
];

const TRANSMISSION_OPTIONS = [
  { value: "MANUELLE", label: "Manuelle" },
  { value: "AUTOMATIQUE", label: "Automatique" },
];

const FUEL_OPTIONS = [
  { value: "ESSENCE", label: "Essence" },
  { value: "DIESEL", label: "Diesel" },
  { value: "HYBRIDE", label: "Hybride" },
  { value: "ELECTRIQUE", label: "Électrique" },
];

interface EditVehicleFormProps {
  id: string;
  initialName: string;
  initialCategory: string;
  initialStatus: string;
  initialPricePerDay: number | null;
  licensePlate: string;
  initialWw: string | null;
  initialChassisNumber: string | null;
  initialColor: string | null;
  initialDoors: number | null;
  initialSeats: number | null;
  initialTransmission: string | null;
  initialFuel: string | null;
  initialHorsepower: number | null;
  initialPowerKW: number | null;
  initialEngineSize: number | null;
  initialAc: boolean;
  initialGps: boolean;
  initialImageUrl: string | null;
  /** Sprint 19 (DOMAINRULES.md section 37) — alertes proactives, tous optionnels. */
  initialInsuranceExpiryDate: string | null;
  initialVignetteExpiryDate: string | null;
  initialTechnicalInspectionExpiryDate: string | null;
  initialNextOilChangeDate: string | null;
  initialNextOilChangeKm: number | null;
}

export function EditVehicleForm({
  id,
  initialName,
  initialCategory,
  initialStatus,
  initialPricePerDay,
  licensePlate,
  initialWw,
  initialChassisNumber,
  initialColor,
  initialDoors,
  initialSeats,
  initialTransmission,
  initialFuel,
  initialHorsepower,
  initialPowerKW,
  initialEngineSize,
  initialAc,
  initialGps,
  initialImageUrl,
  initialInsuranceExpiryDate,
  initialVignetteExpiryDate,
  initialTechnicalInspectionExpiryDate,
  initialNextOilChangeDate,
  initialNextOilChangeKm,
}: EditVehicleFormProps) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState(initialCategory);
  const [status, setStatus] = useState(initialStatus);
  const [pricePerDay, setPricePerDay] = useState(
    initialPricePerDay !== null ? (initialPricePerDay / 100).toFixed(2) : ""
  );
  const [ww, setWw] = useState(initialWw ?? "");
  const [chassisNumber, setChassisNumber] = useState(initialChassisNumber ?? "");
  const [color, setColor] = useState(initialColor ?? "");
  const [doors, setDoors] = useState(initialDoors !== null ? String(initialDoors) : "");
  const [seats, setSeats] = useState(initialSeats !== null ? String(initialSeats) : "");
  const [transmission, setTransmission] = useState(initialTransmission ?? "MANUELLE");
  const [fuel, setFuel] = useState(initialFuel ?? "ESSENCE");
  const [horsepower, setHorsepower] = useState(
    initialHorsepower !== null ? String(initialHorsepower) : ""
  );
  const [powerKW, setPowerKW] = useState(initialPowerKW !== null ? String(initialPowerKW) : "");
  const [engineSize, setEngineSize] = useState(
    initialEngineSize !== null ? String(initialEngineSize) : ""
  );
  const [ac, setAc] = useState(initialAc);
  const [gps, setGps] = useState(initialGps);
  const [imageUrl, setImageUrl] = useState(initialImageUrl ?? "");
  const [insuranceExpiryDate, setInsuranceExpiryDate] = useState(initialInsuranceExpiryDate ?? "");
  const [vignetteExpiryDate, setVignetteExpiryDate] = useState(initialVignetteExpiryDate ?? "");
  const [technicalInspectionExpiryDate, setTechnicalInspectionExpiryDate] = useState(
    initialTechnicalInspectionExpiryDate ?? ""
  );
  const [nextOilChangeDate, setNextOilChangeDate] = useState(initialNextOilChangeDate ?? "");
  const [nextOilChangeKm, setNextOilChangeKm] = useState(
    initialNextOilChangeKm !== null ? String(initialNextOilChangeKm) : ""
  );
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    let pricePerDayCentimes: number | null = null;
    if (pricePerDay.trim()) {
      const priceMad = Number(pricePerDay.replace(",", "."));
      if (!Number.isFinite(priceMad) || priceMad <= 0) {
        setError("Le prix par jour doit être un nombre positif.");
        return;
      }
      pricePerDayCentimes = Math.round(priceMad * 100);
    }

    setIsSubmitting(true);
    try {
      await apiPatch(`/api/vehicles/${id}`, {
        name,
        category,
        status,
        pricePerDay: pricePerDayCentimes,
        ww: ww || null,
        chassisNumber: chassisNumber || null,
        color: color || null,
        doors: doors ? Number(doors) : null,
        seats: seats ? Number(seats) : null,
        transmission,
        fuel,
        horsepower: horsepower ? Number(horsepower) : null,
        powerKW: powerKW ? Number(powerKW) : null,
        engineSize: engineSize ? Number(engineSize.replace(",", ".")) : null,
        ac,
        gps,
        imageUrl: imageUrl || null,
        insuranceExpiryDate: insuranceExpiryDate || null,
        vignetteExpiryDate: vignetteExpiryDate || null,
        technicalInspectionExpiryDate: technicalInspectionExpiryDate || null,
        nextOilChangeDate: nextOilChangeDate || null,
        nextOilChangeKm: nextOilChangeKm ? Number(nextOilChangeKm) : null,
      });
      toast.success("Véhicule mis à jour.");
      router.push("/dashboard/vehicles");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Modifier le véhicule</CardTitle>
        <CardDescription>
          L&apos;immatriculation (« {licensePlate} ») n&apos;est pas modifiable depuis cette page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name" required>Nom</Label>
            <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="category" required>Catégorie</Label>
            <Input
              id="category"
              required
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ww">
                N° WW <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="ww" value={ww} onChange={(e) => setWw(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="chassisNumber">Numéro de châssis</Label>
              <Input
                id="chassisNumber"
                value={chassisNumber}
                onChange={(e) => setChassisNumber(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="color">Couleur</Label>
              <Input id="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="doors">Portes</Label>
              <Input id="doors" type="number" value={doors} onChange={(e) => setDoors(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="seats">Places</Label>
              <Input id="seats" type="number" value={seats} onChange={(e) => setSeats(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="transmission">Boîte</Label>
              <select
                id="transmission"
                value={transmission}
                onChange={(e) => setTransmission(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {TRANSMISSION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fuel">Carburant</Label>
              <select
                id="fuel"
                value={fuel}
                onChange={(e) => setFuel(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {FUEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="horsepower">Chevaux fiscaux</Label>
              <Input
                id="horsepower"
                type="number"
                value={horsepower}
                onChange={(e) => setHorsepower(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="powerKW">Puissance (kW)</Label>
              <Input
                id="powerKW"
                type="number"
                value={powerKW}
                onChange={(e) => setPowerKW(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="engineSize">Cylindrée (L)</Label>
              <Input
                id="engineSize"
                inputMode="decimal"
                value={engineSize}
                onChange={(e) => setEngineSize(e.target.value)}
              />
            </div>
          </div>

          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={ac} onChange={(e) => setAc(e.target.checked)} />
              Climatisé
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={gps} onChange={(e) => setGps(e.target.checked)} />
              GPS intégré
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="status">Statut</Label>
              <select
                id="status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pricePerDay">Prix / jour (MAD)</Label>
              <Input
                id="pricePerDay"
                inputMode="decimal"
                value={pricePerDay}
                onChange={(e) => setPricePerDay(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Indicatif — le prix réel se définit à la réservation ou au contrat.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="imageUrl">
              URL de la photo <span className="text-muted-foreground">— optionnel</span>
            </Label>
            <Input
              id="imageUrl"
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            <span className="text-sm font-medium">Alertes proactives</span>
            <p className="text-xs text-muted-foreground">
              Toutes optionnelles — génèrent une alerte à l&apos;approche de l&apos;échéance
              (voir /dashboard/alerts). Laissez vide si non suivi.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="insuranceExpiryDate">Expiration assurance</Label>
                <Input
                  id="insuranceExpiryDate"
                  type="date"
                  value={insuranceExpiryDate}
                  onChange={(e) => setInsuranceExpiryDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="vignetteExpiryDate">Expiration vignette</Label>
                <Input
                  id="vignetteExpiryDate"
                  type="date"
                  value={vignetteExpiryDate}
                  onChange={(e) => setVignetteExpiryDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="technicalInspectionExpiryDate">Expiration contrôle technique</Label>
                <Input
                  id="technicalInspectionExpiryDate"
                  type="date"
                  value={technicalInspectionExpiryDate}
                  onChange={(e) => setTechnicalInspectionExpiryDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nextOilChangeDate">Prochaine vidange (date)</Label>
                <Input
                  id="nextOilChangeDate"
                  type="date"
                  value={nextOilChangeDate}
                  onChange={(e) => setNextOilChangeDate(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nextOilChangeKm">Prochaine vidange (km)</Label>
              <Input
                id="nextOilChangeKm"
                type="number"
                className="max-w-40"
                value={nextOilChangeKm}
                onChange={(e) => setNextOilChangeKm(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={isSubmitting} className="w-fit">
            {isSubmitting ? "Enregistrement..." : "Enregistrer"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
