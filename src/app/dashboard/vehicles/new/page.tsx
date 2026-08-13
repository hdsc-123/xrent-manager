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

interface Agency {
  id: string;
  name: string;
}

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

export default function NewVehiclePage() {
  const router = useRouter();
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [agencyId, setAgencyId] = useState("");
  const [name, setName] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [ww, setWw] = useState("");
  const [chassisNumber, setChassisNumber] = useState("");
  const [licensePlate, setLicensePlate] = useState("");
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [category, setCategory] = useState("");
  const [color, setColor] = useState("");
  const [doors, setDoors] = useState("");
  const [seats, setSeats] = useState("");
  const [transmission, setTransmission] = useState("MANUELLE");
  const [fuel, setFuel] = useState("ESSENCE");
  const [horsepower, setHorsepower] = useState("");
  const [powerKW, setPowerKW] = useState("");
  const [engineSize, setEngineSize] = useState("");
  const [ac, setAc] = useState(false);
  const [gps, setGps] = useState(false);
  const [status, setStatus] = useState("AVAILABLE");
  const [pricePerDay, setPricePerDay] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    apiGet<{ agencies: Agency[] }>("/api/agencies")
      .then((data) => setAgencies(data.agencies))
      .catch(() => setAgencies([]));
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    // Prix/jour optionnel depuis le Sprint 14A — purement informatif, jamais la source de
    // vérité de la facturation (voir DOMAINRULES.md section 5/7). Validé uniquement s'il est
    // renseigné.
    let pricePerDayCentimes: number | undefined;
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
      await apiPost("/api/vehicles", {
        agencyId,
        name,
        licensePlate,
        make,
        model,
        year: Number(year),
        category,
        status,
        pricePerDay: pricePerDayCentimes,
        ww: ww || undefined,
        chassisNumber: chassisNumber || undefined,
        color: color || undefined,
        doors: doors ? Number(doors) : undefined,
        seats: seats ? Number(seats) : undefined,
        transmission,
        fuel,
        horsepower: horsepower ? Number(horsepower) : undefined,
        powerKW: powerKW ? Number(powerKW) : undefined,
        engineSize: engineSize ? Number(engineSize.replace(",", ".")) : undefined,
        ac,
        gps,
        imageUrl: imageUrl || undefined,
      });
      toast.success("Véhicule créé.");
      router.push("/dashboard/vehicles");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold">Créer un véhicule</h1>

      <Card>
        <CardHeader>
          <CardTitle>Informations</CardTitle>
          <CardDescription>Fiche technique complète du véhicule.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agencyId" required>Agence</Label>
              <select
                id="agencyId"
                required
                value={agencyId}
                onChange={(event) => setAgencyId(event.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="" disabled>
                  Sélectionner une agence
                </option>
                {agencies.map((agency) => (
                  <option key={agency.id} value={agency.id}>
                    {agency.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name" required>Nom</Label>
              <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="make" required>Marque</Label>
                <Input
                  id="make"
                  required
                  placeholder="Dacia, Renault, Toyota…"
                  value={make}
                  onChange={(e) => setMake(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="model" required>Modèle</Label>
                <Input
                  id="model"
                  required
                  placeholder="Sandero, Clio, Corolla…"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ww">
                  N° WW <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input id="ww" value={ww} onChange={(e) => setWw(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="chassisNumber" required>Numéro de châssis</Label>
                <Input
                  id="chassisNumber"
                  required
                  value={chassisNumber}
                  onChange={(e) => setChassisNumber(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="licensePlate" required>Immatriculation</Label>
                <Input
                  id="licensePlate"
                  required
                  value={licensePlate}
                  onChange={(e) => setLicensePlate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="year" required>Année</Label>
                <Input
                  id="year"
                  type="number"
                  required
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="category" required>Catégorie</Label>
              <Input
                id="category"
                required
                placeholder="ex. Citadine, SUV, Utilitaire"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="color" required>Couleur</Label>
                <Input id="color" required value={color} onChange={(e) => setColor(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="doors" required>Portes</Label>
                <Input
                  id="doors"
                  type="number"
                  required
                  value={doors}
                  onChange={(e) => setDoors(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="seats" required>Places</Label>
                <Input
                  id="seats"
                  type="number"
                  required
                  value={seats}
                  onChange={(e) => setSeats(e.target.value)}
                />
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
                <Label htmlFor="horsepower" required>Chevaux fiscaux</Label>
                <Input
                  id="horsepower"
                  type="number"
                  required
                  value={horsepower}
                  onChange={(e) => setHorsepower(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="powerKW" required>Puissance (kW)</Label>
                <Input
                  id="powerKW"
                  type="number"
                  required
                  value={powerKW}
                  onChange={(e) => setPowerKW(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="engineSize" required>Cylindrée (L)</Label>
                <Input
                  id="engineSize"
                  inputMode="decimal"
                  required
                  placeholder="1.5"
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
                  placeholder="450.00"
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
