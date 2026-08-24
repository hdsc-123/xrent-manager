"use client";

import { useEffect, useMemo, useState } from "react";
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
  PhoneInput,
} from "@/components/ui";

// Sprint 15 : source est du texte libre (voir prisma/schema.prisma) — suggestions seulement,
// pas une liste fermée, pour accepter tout code broker réel (TJS/DCH/CT...).
const SOURCE_SUGGESTIONS = ["TJS", "DCH", "CT", "DIRECT", "BROKER"];

interface Agency {
  id: string;
  name: string;
  city: string | null;
}

function toCentimes(value: string): number | undefined {
  if (!value) return undefined;
  const num = Number(value.replace(",", "."));
  return Number.isFinite(num) ? Math.round(num * 100) : undefined;
}

export function NewReservationForm() {
  const router = useRouter();
  const [voucherNumber, setVoucherNumber] = useState("");
  const [confirmationNumber, setConfirmationNumber] = useState("");
  const [source, setSource] = useState("");
  const [clientFirstName, setClientFirstName] = useState("");
  const [clientLastName, setClientLastName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [flightNumber, setFlightNumber] = useState("");
  const [vehicleCategory, setVehicleCategory] = useState("");
  const [pickupAgency, setPickupAgency] = useState("");
  const [dropoffAgency, setDropoffAgency] = useState("");
  const [currency, setCurrency] = useState("MAD");
  const [totalPrice, setTotalPrice] = useState("");
  const [pricePerDay, setPricePerDay] = useState("");
  const [hasGps, setHasGps] = useState(false);
  const [gpsPrice, setGpsPrice] = useState("");
  const [hasBabySeat, setHasBabySeat] = useState(false);
  const [babySeatPrice, setBabySeatPrice] = useState("");
  const [hasExtraDriver, setHasExtraDriver] = useState(false);
  const [extraDriverPrice, setExtraDriverPrice] = useState("");
  const [optionsCurrency, setOptionsCurrency] = useState("MAD");
  const [mileage, setMileage] = useState("");
  const [includedKm, setIncludedKm] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [agencies, setAgencies] = useState<Agency[]>([]);

  useEffect(() => {
    apiGet<{ agencies: Agency[] }>("/api/agencies")
      .then((data) => setAgencies(data.agencies))
      .catch(() => setAgencies([]));
  }, []);

  // Villes/agences (Sprint 14A) : la ville de départ/retour doit désormais correspondre à une
  // agence déjà créée (voir DOMAINRULES.md section 21) — plus de saisie libre, remplacée par
  // ces listes déroulantes dérivées des agences du tenant (ville si renseignée, sinon nom).
  const agencyOptions = useMemo(() => {
    const values = new Set<string>();
    for (const agency of agencies) {
      values.add(agency.city?.trim() || agency.name);
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [agencies]);

  function handleStartTimeChange(value: string) {
    setStartTime(value);
    setEndTime(value);
  }

  // Modifier la ville de départ recopie automatiquement la valeur dans la ville de retour
  // (même pattern que handleStartTimeChange, Sprint 13C) — modifiable ensuite manuellement.
  function handlePickupAgencyChange(value: string) {
    setPickupAgency(value);
    setDropoffAgency(value);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if ((source !== "DIRECT" && !voucherNumber) || !clientFirstName || !clientLastName || !startDate || !endDate) {
      setError(
        source === "DIRECT"
          ? "Prénom, nom et dates de départ/retour sont requis."
          : "Voucher, prénom, nom et dates de départ/retour sont requis."
      );
      return;
    }

    setIsSubmitting(true);
    try {
      await apiPost("/api/reservations", {
        voucherNumber: voucherNumber || undefined,
        confirmationNumber: confirmationNumber || undefined,
        source: source || undefined,
        clientFirstName,
        clientLastName,
        clientPhone: clientPhone || undefined,
        startDate,
        startTime: startTime || undefined,
        endDate,
        endTime: endTime || undefined,
        flightNumber: flightNumber || undefined,
        vehicleCategory: vehicleCategory || undefined,
        pickupAgency: pickupAgency || undefined,
        dropoffAgency: dropoffAgency || undefined,
        currency,
        totalPrice: toCentimes(totalPrice),
        pricePerDay: toCentimes(pricePerDay),
        hasGps,
        gpsPrice: hasGps ? toCentimes(gpsPrice) : undefined,
        hasBabySeat,
        babySeatPrice: hasBabySeat ? toCentimes(babySeatPrice) : undefined,
        hasExtraDriver,
        extraDriverPrice: hasExtraDriver ? toCentimes(extraDriverPrice) : undefined,
        optionsCurrency,
        mileage: mileage ? Number(mileage) : undefined,
        includedKm: includedKm ? Number(includedKm) : undefined,
        notes: notes || undefined,
      });
      toast.success("Réservation créée.");
      router.push("/dashboard/reservations");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold">Créer une réservation</h1>

      <Card>
        <CardHeader>
          <CardTitle>Informations</CardTitle>
          <CardDescription>Réservation manuelle, en amont d&apos;un contrat de location.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="voucherNumber" required={source !== "DIRECT"}>N° voucher</Label>
                {source === "DIRECT" ? (
                  <p className="flex h-8 items-center text-sm text-muted-foreground">
                    Généré automatiquement (ex. Dir-0001)
                  </p>
                ) : (
                  <Input
                    id="voucherNumber"
                    required
                    value={voucherNumber}
                    onChange={(e) => setVoucherNumber(e.target.value)}
                  />
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="confirmationNumber">
                  N° confirmation <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input
                  id="confirmationNumber"
                  value={confirmationNumber}
                  onChange={(e) => setConfirmationNumber(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="source">Source</Label>
              <Input
                id="source"
                list="source-suggestions"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
              <datalist id="source-suggestions">
                {SOURCE_SUGGESTIONS.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="clientFirstName" required>Prénom du client</Label>
                <Input
                  id="clientFirstName"
                  required
                  value={clientFirstName}
                  onChange={(e) => setClientFirstName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="clientLastName" required>Nom du client</Label>
                <Input
                  id="clientLastName"
                  required
                  value={clientLastName}
                  onChange={(e) => setClientLastName(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="clientPhone">
                Téléphone client <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <PhoneInput id="clientPhone" value={clientPhone} onChange={setClientPhone} />
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startDate" required>Date de départ</Label>
                <Input id="startDate" type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startTime">Heure</Label>
                <Input id="startTime" type="time" value={startTime} onChange={(e) => handleStartTimeChange(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="endDate" required>Date de retour</Label>
                <Input id="endDate" type="date" required value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="endTime">Heure</Label>
                <Input id="endTime" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="flightNumber">
                N° de vol <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="flightNumber" value={flightNumber} onChange={(e) => setFlightNumber(e.target.value)} />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="vehicleCategory">Catégorie véhicule</Label>
                <Input id="vehicleCategory" value={vehicleCategory} onChange={(e) => setVehicleCategory(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pickupAgency">Ville de départ</Label>
                <select
                  id="pickupAgency"
                  value={pickupAgency}
                  onChange={(e) => handlePickupAgencyChange(e.target.value)}
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  <option value="">—</option>
                  {agencyOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dropoffAgency">Ville de retour</Label>
                <select
                  id="dropoffAgency"
                  value={dropoffAgency}
                  onChange={(e) => setDropoffAgency(e.target.value)}
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  <option value="">—</option>
                  {agencyOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="currency">Devise</Label>
                <Input id="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pricePerDay">Prix / jour</Label>
                <Input id="pricePerDay" inputMode="decimal" value={pricePerDay} onChange={(e) => setPricePerDay(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="totalPrice">Prix total</Label>
                <Input id="totalPrice" inputMode="decimal" value={totalPrice} onChange={(e) => setTotalPrice(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={hasGps} onChange={(e) => setHasGps(e.target.checked)} />
                  GPS
                </label>
                {hasGps && (
                  <Input
                    inputMode="decimal"
                    placeholder="Prix GPS"
                    value={gpsPrice}
                    onChange={(e) => setGpsPrice(e.target.value)}
                  />
                )}
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={hasBabySeat} onChange={(e) => setHasBabySeat(e.target.checked)} />
                  Siège bébé
                </label>
                {hasBabySeat && (
                  <Input
                    inputMode="decimal"
                    placeholder="Prix siège bébé"
                    value={babySeatPrice}
                    onChange={(e) => setBabySeatPrice(e.target.value)}
                  />
                )}
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={hasExtraDriver}
                    onChange={(e) => setHasExtraDriver(e.target.checked)}
                  />
                  Conducteur supp.
                </label>
                {hasExtraDriver && (
                  <Input
                    inputMode="decimal"
                    placeholder="Prix conducteur supp."
                    value={extraDriverPrice}
                    onChange={(e) => setExtraDriverPrice(e.target.value)}
                  />
                )}
              </div>
            </div>

            {(hasGps || hasBabySeat || hasExtraDriver) && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="optionsCurrency">
                  Devise des options
                  <span className="text-muted-foreground"> — GPS/siège bébé/conducteur suppl.</span>
                </Label>
                <Input
                  id="optionsCurrency"
                  value={optionsCurrency}
                  onChange={(e) => setOptionsCurrency(e.target.value)}
                  className="max-w-32"
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mileage">
                  Kilométrage <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input id="mileage" inputMode="numeric" value={mileage} onChange={(e) => setMileage(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="includedKm">
                  Km inclus <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input id="includedKm" inputMode="numeric" value={includedKm} onChange={(e) => setIncludedKm(e.target.value)} />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notes">
                Remarques <span className="text-muted-foreground">— optionnel</span>
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
