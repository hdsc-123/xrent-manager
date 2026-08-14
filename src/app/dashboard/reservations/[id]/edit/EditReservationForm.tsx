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
  PhoneInput,
} from "@/components/ui";

// Sprint 15 : source est du texte libre (voir prisma/schema.prisma) — suggestions seulement,
// pas une liste fermée, pour accepter tout code broker réel (TJS/DCH/CT...).
const SOURCE_SUGGESTIONS = ["TJS", "DCH", "CT", "DIRECT", "BROKER"];

interface ReservationDetail {
  id: string;
  voucherNumber: string;
  confirmationNumber: string | null;
  source: string | null;
  clientFirstName: string;
  clientLastName: string;
  clientPhone: string | null;
  startDate: string;
  startTime: string | null;
  endDate: string;
  endTime: string | null;
  flightNumber: string | null;
  vehicleCategory: string | null;
  pickupAgency: string | null;
  dropoffAgency: string | null;
  currency: string;
  totalPrice: number | null;
  pricePerDay: number | null;
  hasGps: boolean;
  gpsPrice: number | null;
  hasBabySeat: boolean;
  babySeatPrice: number | null;
  hasExtraDriver: boolean;
  extraDriverPrice: number | null;
  optionsCurrency: string;
  mileage: number | null;
  includedKm: number | null;
  notes: string | null;
}

function centimesToInput(value: number | null): string {
  return value === null ? "" : String(value / 100);
}

function toCentimes(value: string): number | undefined {
  if (!value) return undefined;
  const num = Number(value.replace(",", "."));
  return Number.isFinite(num) ? Math.round(num * 100) : undefined;
}

export function EditReservationForm({
  reservation,
  agencyOptions,
}: {
  reservation: ReservationDetail;
  agencyOptions: string[];
}) {
  const router = useRouter();
  const [voucherNumber, setVoucherNumber] = useState(reservation.voucherNumber);
  const [confirmationNumber, setConfirmationNumber] = useState(reservation.confirmationNumber ?? "");
  const [source, setSource] = useState(reservation.source ?? "");
  const [clientFirstName, setClientFirstName] = useState(reservation.clientFirstName);
  const [clientLastName, setClientLastName] = useState(reservation.clientLastName);
  const [clientPhone, setClientPhone] = useState(reservation.clientPhone ?? "");
  const [startDate, setStartDate] = useState(reservation.startDate);
  const [startTime, setStartTime] = useState(reservation.startTime ?? "");
  const [endDate, setEndDate] = useState(reservation.endDate);
  const [endTime, setEndTime] = useState(reservation.endTime ?? "");
  const [flightNumber, setFlightNumber] = useState(reservation.flightNumber ?? "");
  const [vehicleCategory, setVehicleCategory] = useState(reservation.vehicleCategory ?? "");
  const [pickupAgency, setPickupAgency] = useState(reservation.pickupAgency ?? "");
  const [dropoffAgency, setDropoffAgency] = useState(reservation.dropoffAgency ?? "");
  const [currency, setCurrency] = useState(reservation.currency);
  const [totalPrice, setTotalPrice] = useState(centimesToInput(reservation.totalPrice));
  const [pricePerDay, setPricePerDay] = useState(centimesToInput(reservation.pricePerDay));
  const [hasGps, setHasGps] = useState(reservation.hasGps);
  const [gpsPrice, setGpsPrice] = useState(centimesToInput(reservation.gpsPrice));
  const [hasBabySeat, setHasBabySeat] = useState(reservation.hasBabySeat);
  const [babySeatPrice, setBabySeatPrice] = useState(centimesToInput(reservation.babySeatPrice));
  const [hasExtraDriver, setHasExtraDriver] = useState(reservation.hasExtraDriver);
  const [extraDriverPrice, setExtraDriverPrice] = useState(centimesToInput(reservation.extraDriverPrice));
  const [optionsCurrency, setOptionsCurrency] = useState(reservation.optionsCurrency);
  const [mileage, setMileage] = useState(reservation.mileage !== null ? String(reservation.mileage) : "");
  const [includedKm, setIncludedKm] = useState(reservation.includedKm !== null ? String(reservation.includedKm) : "");
  const [notes, setNotes] = useState(reservation.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function handlePickupAgencyChange(value: string) {
    setPickupAgency(value);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!voucherNumber || !clientFirstName || !clientLastName || !startDate || !endDate) {
      setError("Voucher, prénom, nom et dates de départ/retour sont requis.");
      return;
    }

    setIsSubmitting(true);
    try {
      await apiPatch(`/api/reservations/${reservation.id}`, {
        voucherNumber,
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
      toast.success("Réservation mise à jour.");
      router.push(`/dashboard/reservations/${reservation.id}`);
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
        <CardTitle>Informations</CardTitle>
        <CardDescription>Modifiez les champs nécessaires puis enregistrez.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="voucherNumber" required>N° voucher</Label>
              <Input id="voucherNumber" required value={voucherNumber} onChange={(e) => setVoucherNumber(e.target.value)} />
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
            <Input id="source" list="source-suggestions" value={source} onChange={(e) => setSource(e.target.value)} />
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
              <Input id="startTime" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
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
              {agencyOptions.length > 0 ? (
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
              ) : (
                <Input id="pickupAgency" value={pickupAgency} onChange={(e) => setPickupAgency(e.target.value)} />
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dropoffAgency">Ville de retour</Label>
              {agencyOptions.length > 0 ? (
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
              ) : (
                <Input id="dropoffAgency" value={dropoffAgency} onChange={(e) => setDropoffAgency(e.target.value)} />
              )}
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
                <Input inputMode="decimal" placeholder="Prix GPS" value={gpsPrice} onChange={(e) => setGpsPrice(e.target.value)} />
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
                <input type="checkbox" checked={hasExtraDriver} onChange={(e) => setHasExtraDriver(e.target.checked)} />
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
              {isSubmitting ? "Enregistrement..." : "Enregistrer"}
            </Button>
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Annuler
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
