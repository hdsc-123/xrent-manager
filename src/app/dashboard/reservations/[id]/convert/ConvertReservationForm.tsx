"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { calculateDaysCount } from "@/lib/format";
import { formatMoney } from "@/lib/format";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  PhoneInput,
} from "@/components/ui";
import { DuplicateCheck, type DuplicateClientInfo } from "../../../clients/DuplicateCheck";

interface ReservationSummary {
  id: string;
  voucherNumber: string;
  clientFirstName: string;
  clientLastName: string;
  clientPhone: string | null;
  startDate: string;
  startTime: string | null;
  endDate: string;
  endTime: string | null;
  pricePerDay: number | null;
  totalPrice: number | null;
  currency: string;
  vehicleCategory: string | null;
  notes: string | null;
  /** Sprint 19 — options (voir Reservation.hasGps/gpsPrice etc.), reprises dans le total du
   * contrat au lieu d'être silencieusement perdues à la conversion. */
  hasGps: boolean;
  gpsPrice: number | null;
  hasBabySeat: boolean;
  babySeatPrice: number | null;
  hasExtraDriver: boolean;
  extraDriverPrice: number | null;
  optionsCurrency: string;
}

interface Agency {
  id: string;
  name: string;
}

interface Vehicle {
  id: string;
  name: string;
  licensePlate: string;
  agencyId: string;
  category: string;
  /** Optionnel (Sprint 14A) — informatif, jamais la source de vérité de la facturation. */
  pricePerDay: number | null;
  currency: string;
}

const ID_TYPE_OPTIONS = [
  { value: "CIN", label: "CIN" },
  { value: "PASSEPORT", label: "Passeport" },
  { value: "CARTE_SEJOUR", label: "Carte de séjour" },
];

const PAYMENT_METHOD_OPTIONS = [
  { value: "CASH", label: "Espèces" },
  { value: "CARD", label: "Carte" },
  { value: "BANK_TRANSFER", label: "Virement" },
  { value: "CHECK", label: "Chèque" },
  { value: "OTHER", label: "Autre" },
] as const;

type PaymentMethodValue = (typeof PAYMENT_METHOD_OPTIONS)[number]["value"];

function toDateInputValue(iso: string): string {
  return iso.slice(0, 10);
}

interface ConvertReservationFormProps {
  reservation: ReservationSummary;
  agencies: Agency[];
}

export function ConvertReservationForm({ reservation, agencies }: ConvertReservationFormProps) {
  const router = useRouter();

  // Client — pré-rempli depuis la réservation, vérifié/complété par l'utilisateur.
  const [firstName, setFirstName] = useState(reservation.clientFirstName);
  const [lastName, setLastName] = useState(reservation.clientLastName);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState(reservation.clientPhone ?? "");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [idType, setIdType] = useState("CIN");
  const [idNumber, setIdNumber] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [licenseIssueDate, setLicenseIssueDate] = useState("");
  const [licenseExpiryDate, setLicenseExpiryDate] = useState("");

  // Location — pré-remplie depuis la réservation.
  const [startDate, setStartDate] = useState(toDateInputValue(reservation.startDate));
  const [startTime, setStartTime] = useState(reservation.startTime ?? "10:00");
  const [endDate, setEndDate] = useState(toDateInputValue(reservation.endDate));
  const [endTime, setEndTime] = useState(reservation.endTime ?? reservation.startTime ?? "10:00");
  const [deposit, setDeposit] = useState("");
  const [notes, setNotes] = useState(reservation.notes ?? "");

  function handleStartTimeChange(value: string) {
    setStartTime(value);
    setEndTime(value);
  }

  // Véhicule / agence réels.
  const [agencyId, setAgencyId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [pricePerDay, setPricePerDay] = useState(
    reservation.pricePerDay != null ? (reservation.pricePerDay / 100).toFixed(2) : ""
  );
  // Surclassement (Sprint 19, DOMAINRULES.md section 37) : le filtre catégorie reste actif
  // par défaut (comportement antérieur), "allCategories" le désactive pour permettre de
  // choisir une catégorie supérieure.
  const [allCategories, setAllCategories] = useState(false);
  const [upgradeSupplement, setUpgradeSupplement] = useState("");
  const [upgradeFree, setUpgradeFree] = useState(false);

  // Prix total du contrat (Sprint 19) : reprend le vrai montant réservation + options plutôt
  // que de laisser le serveur recalculer silencieusement pricePerDay × jours (bug corrigé ce
  // sprint) — vide si la réservation n'a pas de totalPrice connu, retombe alors sur l'ancien
  // comportement calculé côté serveur.
  const optionsSum =
    (reservation.hasGps ? (reservation.gpsPrice ?? 0) : 0) +
    (reservation.hasBabySeat ? (reservation.babySeatPrice ?? 0) : 0) +
    (reservation.hasExtraDriver ? (reservation.extraDriverPrice ?? 0) : 0);
  const optionsSameCurrency = reservation.optionsCurrency === reservation.currency;
  const [totalPriceOverride, setTotalPriceOverride] = useState(
    reservation.totalPrice != null
      ? ((reservation.totalPrice + (optionsSameCurrency ? optionsSum : 0)) / 100).toFixed(2)
      : ""
  );

  // Second conducteur (Sprint 19) : optionnel, réutilise Client (Location.secondDriverId) —
  // section repliée par défaut, mêmes champs d'identité que le client principal (allégés).
  const [hasSecondDriver, setHasSecondDriver] = useState(false);
  const [secondDriverFirstName, setSecondDriverFirstName] = useState("");
  const [secondDriverLastName, setSecondDriverLastName] = useState("");
  const [secondDriverPhone, setSecondDriverPhone] = useState("");
  const [secondDriverIdNumber, setSecondDriverIdNumber] = useState("");
  const [secondDriverLicenseNumber, setSecondDriverLicenseNumber] = useState("");

  // Paiement — même formulaire que /dashboard/locations/new (Sprint 13A).
  const [paymentDeferred, setPaymentDeferred] = useState(false);
  const [paymentMixed, setPaymentMixed] = useState(false);
  const [paymentPartial, setPaymentPartial] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodValue>("CASH");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod1, setPaymentMethod1] = useState<PaymentMethodValue>("CASH");
  const [paymentAmount1, setPaymentAmount1] = useState("");
  const [paymentMethod2, setPaymentMethod2] = useState<PaymentMethodValue>("CARD");
  const [paymentAmount2, setPaymentAmount2] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateClientInfo | null>(null);

  // Véhicules de la catégorie de la réservation (texte libre, voir DOMAINRULES.md section
  // 21), disponibles, filtrés par l'agence sélectionnée si renseignée — recalculé à chaque
  // changement d'agence, le champ véhicule est réinitialisé pour ne jamais laisser
  // sélectionné un véhicule qui ne serait plus dans la liste affichée.
  useEffect(() => {
    const query = new URLSearchParams({ status: "AVAILABLE" });
    if (agencyId) query.set("agencyId", agencyId);
    // Sprint 19 : filtre catégorie désactivable ("allCategories") pour permettre un
    // surclassement — voir DOMAINRULES.md section 37.
    if (reservation.vehicleCategory && !allCategories) query.set("category", reservation.vehicleCategory);
    apiGet<{ vehicles: Vehicle[] }>(`/api/vehicles?${query.toString()}`)
      .then((data) => setVehicles(data.vehicles))
      .catch(() => setVehicles([]));
  }, [agencyId, reservation.vehicleCategory, allCategories]);

  const selectedVehicle = useMemo(
    () => vehicles.find((vehicle) => vehicle.id === vehicleId) ?? null,
    [vehicles, vehicleId]
  );

  // Le prix véhicule (s'il existe), sinon le prix informatif de la réservation importée, ne
  // sert que de valeur par défaut — jamais la source de vérité de la facturation
  // (DOMAINRULES.md section 5/7). Pré-rempli à chaque changement de véhicule (setState pendant
  // le rendu, pas dans un effet — "Adjusting state when a prop changes" de la doc React),
  // modifiable ensuite librement par l'utilisateur.
  const [pricePerDayVehicleId, setPricePerDayVehicleId] = useState(vehicleId);
  if (vehicleId !== pricePerDayVehicleId) {
    setPricePerDayVehicleId(vehicleId);
    const fallbackCentimes = selectedVehicle?.pricePerDay ?? reservation.pricePerDay;
    setPricePerDay(fallbackCentimes != null ? (fallbackCentimes / 100).toFixed(2) : "");
  }

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

  const days =
    startDateTime && endDateTime && endDateTime > startDateTime
      ? calculateDaysCount(startDateTime, endDateTime)
      : 0;

  const estimatedTotal = pricePerDayCentimes && days > 0 ? pricePerDayCentimes * days : 0;

  // Sprint 19 : surclassement détecté quand la catégorie du véhicule choisi diffère de celle
  // de la réservation — voir DOMAINRULES.md section 37.
  const isUpgrade = Boolean(
    selectedVehicle && reservation.vehicleCategory && selectedVehicle.category !== reservation.vehicleCategory
  );
  const upgradeSupplementCentimes = upgradeSupplement
    ? Math.round(Number(upgradeSupplement.replace(",", ".")) * 100)
    : 0;

  function buildPayload(overrides?: { useExistingClientId?: string; forceCreateClient?: boolean }) {
    const depositMad = deposit ? Number(deposit.replace(",", ".")) : undefined;

    const totalPriceCentimes = totalPriceOverride
      ? Math.round(Number(totalPriceOverride.replace(",", ".")) * 100)
      : undefined;
    const finalTotalPrice =
      totalPriceCentimes !== undefined && Number.isFinite(totalPriceCentimes)
        ? totalPriceCentimes + (isUpgrade && !upgradeFree ? upgradeSupplementCentimes : 0)
        : undefined;

    const upgradeNote = isUpgrade
      ? `Surclassement : ${reservation.vehicleCategory} → ${selectedVehicle?.category} (${
          upgradeFree ? "gratuit" : `supplément ${upgradeSupplement || "0"} MAD`
        }).`
      : null;
    const finalNotes = [notes || null, upgradeNote].filter(Boolean).join(" ") || undefined;

    const secondDriver =
      hasSecondDriver && secondDriverFirstName && secondDriverLastName
        ? {
            firstName: secondDriverFirstName,
            lastName: secondDriverLastName,
            phone: secondDriverPhone || undefined,
            idNumber: secondDriverIdNumber || undefined,
            licenseNumber: secondDriverLicenseNumber || undefined,
          }
        : undefined;

    let payment: Record<string, unknown> | undefined;
    if (paymentDeferred) {
      payment = { deferred: true };
    } else if (paymentMixed) {
      const amount1Centimes = paymentAmount1 ? Math.round(Number(paymentAmount1.replace(",", ".")) * 100) : 0;
      const amount2Centimes = paymentAmount2 ? Math.round(Number(paymentAmount2.replace(",", ".")) * 100) : 0;
      payment = {
        mixed: true,
        method1: paymentMethod1,
        amount1: amount1Centimes > 0 ? amount1Centimes : undefined,
        method2: paymentMethod2,
        amount2: amount2Centimes > 0 ? amount2Centimes : undefined,
      };
    } else {
      const amountCentimes = paymentAmount ? Math.round(Number(paymentAmount.replace(",", ".")) * 100) : undefined;
      payment = { method: paymentMethod, partial: paymentPartial, amount: paymentPartial ? amountCentimes : undefined };
    }

    return {
      vehicleId,
      startDate: startDateTime?.toISOString(),
      endDate: endDateTime?.toISOString(),
      deposit: depositMad !== undefined && Number.isFinite(depositMad) ? Math.round(depositMad * 100) : undefined,
      pricePerDay: pricePerDayCentimes ?? undefined,
      totalPrice: finalTotalPrice,
      notes: finalNotes,
      client: {
        firstName,
        lastName,
        email: email || undefined,
        phone: phone || undefined,
        address: address || undefined,
        city: city || undefined,
        country: country || undefined,
        idType,
        idNumber: idNumber || undefined,
        licenseNumber: licenseNumber || undefined,
        licenseIssueDate: licenseIssueDate || undefined,
        licenseExpiryDate: licenseExpiryDate || undefined,
      },
      secondDriver,
      payment,
      ...overrides,
    };
  }

  async function submit(overrides?: { useExistingClientId?: string; forceCreateClient?: boolean }) {
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await apiPost<{
        reservation: { id: string };
        paymentError: string | null;
      }>(`/api/reservations/${reservation.id}/convert`, buildPayload(overrides));
      if (result.paymentError) {
        toast.warning(`Contrat généré, mais le paiement n'a pas pu être enregistré : ${result.paymentError}`);
      } else {
        toast.success("Contrat généré.");
      }
      router.push(`/dashboard/reservations/${result.reservation.id}`);
      router.refresh();
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.body &&
        typeof err.body === "object" &&
        "duplicate" in err.body
      ) {
        setDuplicate((err.body as { duplicate: DuplicateClientInfo }).duplicate);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!vehicleId) {
      setError("Sélectionnez un véhicule.");
      return;
    }
    if (!firstName || !lastName) {
      setError("Le prénom et le nom du client sont requis.");
      return;
    }
    // Sprint 19 (DOMAINRULES.md section 37) : obligatoires à la conversion (contrat) — ces
    // champs restent optionnels sur la réservation elle-même (import broker sans ces
    // informations, voir CLAUDE.md/DOMAINRULES.md), mais un contrat ne doit jamais être généré
    // sans identité complète du client.
    if (!address || !city || !country || !idNumber || !licenseNumber || !licenseIssueDate || !licenseExpiryDate) {
      setError(
        "Adresse, ville, pays, n° de pièce, n° de permis et dates d'obtention/expiration du permis sont requis pour générer le contrat."
      );
      return;
    }
    if (!startDateTime || !endDateTime || endDateTime <= startDateTime) {
      setError("Dates/heures de départ et de retour invalides.");
      return;
    }
    if (hasSecondDriver && (!secondDriverFirstName || !secondDriverLastName)) {
      setError("Le prénom et le nom du second conducteur sont requis.");
      return;
    }
    if (!pricePerDayCentimes) {
      setError("Le prix / jour doit être renseigné (un nombre positif).");
      return;
    }
    if (paymentMixed) {
      const amount1Centimes = paymentAmount1 ? Math.round(Number(paymentAmount1.replace(",", ".")) * 100) : 0;
      const amount2Centimes = paymentAmount2 ? Math.round(Number(paymentAmount2.replace(",", ".")) * 100) : 0;
      if (!paymentDeferred && amount1Centimes <= 0 && amount2Centimes <= 0) {
        setError("Le paiement mixte nécessite au moins un montant.");
        return;
      }
    }
    if (!paymentDeferred && !paymentMixed && paymentPartial) {
      const amountCentimes = paymentAmount ? Math.round(Number(paymentAmount.replace(",", ".")) * 100) : 0;
      if (amountCentimes <= 0) {
        setError("Le montant payé doit être renseigné pour un paiement partiel.");
        return;
      }
    }

    await submit();
  }

  return (
    <>
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Client</CardTitle>
            <CardDescription>Vérifiez et complétez les informations du client.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="firstName" required>Prénom</Label>
                <Input id="firstName" required value={firstName} onChange={(e) => setFirstName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lastName" required>Nom</Label>
                <Input id="lastName" required value={lastName} onChange={(e) => setLastName(e.target.value)} />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">
                Email <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="phone">Téléphone</Label>
              <PhoneInput id="phone" value={phone} onChange={setPhone} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="address" required>Adresse</Label>
              <Input id="address" required value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="city" required>Ville</Label>
                <Input id="city" required value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="country" required>Pays</Label>
                <Input id="country" required value={country} onChange={(e) => setCountry(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="idType">Type de pièce</Label>
                <select
                  id="idType"
                  value={idType}
                  onChange={(e) => setIdType(e.target.value)}
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  {ID_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="idNumber" required>N° de pièce</Label>
                <Input id="idNumber" required value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="licenseNumber" required>Numéro de permis</Label>
              <Input id="licenseNumber" required value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="licenseIssueDate" required>Date d&apos;obtention</Label>
                <Input
                  id="licenseIssueDate"
                  type="date"
                  required
                  value={licenseIssueDate}
                  onChange={(e) => setLicenseIssueDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="licenseExpiryDate" required>Date d&apos;expiration</Label>
                <Input
                  id="licenseExpiryDate"
                  type="date"
                  required
                  value={licenseExpiryDate}
                  onChange={(e) => setLicenseExpiryDate(e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Contrat</CardTitle>
            <CardDescription>Véhicule, agence, période et caution.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agencyId">
                Agence <span className="text-muted-foreground">— filtre la liste de véhicules</span>
              </Label>
              <select
                id="agencyId"
                value={agencyId}
                onChange={(e) => {
                  setAgencyId(e.target.value);
                  setVehicleId("");
                }}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="">Toutes les agences</option>
                {agencies.map((agency) => (
                  <option key={agency.id} value={agency.id}>
                    {agency.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="vehicleId" required>
                Véhicule{reservation.vehicleCategory ? ` (catégorie : ${reservation.vehicleCategory})` : ""}
              </Label>
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
                    {vehicle.name} ({vehicle.licensePlate}) — {vehicle.category}
                    {vehicle.pricePerDay !== null
                      ? ` — ${formatMoney(vehicle.pricePerDay, vehicle.currency)}/jour (indicatif)`
                      : ""}
                  </option>
                ))}
              </select>
              {vehicles.length === 0 && (
                <p className="text-xs text-muted-foreground">Aucun véhicule disponible pour ces critères.</p>
              )}
              {reservation.vehicleCategory && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={allCategories}
                    onCheckedChange={(checked) => setAllCategories(checked === true)}
                  />
                  Autoriser un surclassement (toutes catégories, pas seulement {reservation.vehicleCategory})
                </label>
              )}
            </div>

            {isUpgrade && (
              <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                <p>
                  Surclassement : {reservation.vehicleCategory} → {selectedVehicle?.category}.
                </p>
                <label className="flex items-center gap-2">
                  <Checkbox checked={upgradeFree} onCheckedChange={(checked) => setUpgradeFree(checked === true)} />
                  Surclassement gratuit
                </label>
                {!upgradeFree && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="upgradeSupplement">Supplément (MAD)</Label>
                    <Input
                      id="upgradeSupplement"
                      inputMode="decimal"
                      className="w-32"
                      value={upgradeSupplement}
                      onChange={(e) => setUpgradeSupplement(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startDate" required>Date de départ</Label>
                <Input id="startDate" type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startTime" required>Heure de départ</Label>
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
                <Label htmlFor="endDate" required>Date de retour</Label>
                <Input id="endDate" type="date" required value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="endTime" required>Heure de retour</Label>
                <Input id="endTime" type="time" required value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </div>
            </div>

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
                Prix réel de ce contrat — le prix véhicule/réservation (s&apos;il existe) n&apos;est
                qu&apos;une valeur par défaut.
              </p>
            </div>

            {days > 0 && pricePerDayCentimes && selectedVehicle && (
              <p className="text-sm text-muted-foreground">
                {days} jour(s) × {formatMoney(pricePerDayCentimes, selectedVehicle.currency)} ={" "}
                <span className="font-medium text-foreground">{formatMoney(estimatedTotal, selectedVehicle.currency)}</span>
              </p>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="totalPriceOverride">
                Prix total du contrat <span className="text-muted-foreground">— optionnel, sinon calculé (prix/jour × jours)</span>
              </Label>
              <Input
                id="totalPriceOverride"
                inputMode="decimal"
                value={totalPriceOverride}
                onChange={(e) => setTotalPriceOverride(e.target.value)}
              />
              {reservation.totalPrice !== null && (
                <p className="text-xs text-muted-foreground">
                  Pré-rempli depuis la réservation
                  {optionsSum > 0 && optionsSameCurrency ? " (options incluses)" : ""}.
                  {optionsSum > 0 && !optionsSameCurrency
                    ? ` Options non incluses (devise différente : ${formatMoney(optionsSum, reservation.optionsCurrency)}).`
                    : ""}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="deposit">
                Caution (MAD) <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="deposit" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notes">
                Notes <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Second conducteur</CardTitle>
            <CardDescription>Optionnel — informations d&apos;identité minimales.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={hasSecondDriver} onCheckedChange={(checked) => setHasSecondDriver(checked === true)} />
              Ajouter un second conducteur
            </label>
            {hasSecondDriver && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="secondDriverFirstName" required>Prénom</Label>
                    <Input
                      id="secondDriverFirstName"
                      required
                      value={secondDriverFirstName}
                      onChange={(e) => setSecondDriverFirstName(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="secondDriverLastName" required>Nom</Label>
                    <Input
                      id="secondDriverLastName"
                      required
                      value={secondDriverLastName}
                      onChange={(e) => setSecondDriverLastName(e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="secondDriverPhone">
                    Téléphone <span className="text-muted-foreground">— optionnel</span>
                  </Label>
                  <PhoneInput id="secondDriverPhone" value={secondDriverPhone} onChange={setSecondDriverPhone} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="secondDriverIdNumber">
                      N° de pièce <span className="text-muted-foreground">— optionnel</span>
                    </Label>
                    <Input
                      id="secondDriverIdNumber"
                      value={secondDriverIdNumber}
                      onChange={(e) => setSecondDriverIdNumber(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="secondDriverLicenseNumber">
                      N° de permis <span className="text-muted-foreground">— optionnel</span>
                    </Label>
                    <Input
                      id="secondDriverLicenseNumber"
                      value={secondDriverLicenseNumber}
                      onChange={(e) => setSecondDriverLicenseNumber(e.target.value)}
                    />
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Paiement</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={paymentDeferred} onCheckedChange={(checked) => setPaymentDeferred(checked === true)} />
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
                      <Checkbox checked={paymentPartial} onCheckedChange={(checked) => setPaymentPartial(checked === true)} />
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
          </CardContent>
        </Card>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Génération..." : "Valider et générer le contrat"}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Annuler
          </Button>
        </div>
      </form>

      <DuplicateCheck
        duplicate={duplicate}
        isSubmitting={isSubmitting}
        onUseExisting={() => {
          const useExistingClientId = duplicate?.client.id;
          setDuplicate(null);
          if (useExistingClientId) {
            void submit({ useExistingClientId });
          }
        }}
        onCreateAnyway={() => {
          setDuplicate(null);
          void submit({ forceCreateClient: true });
        }}
        onCancel={() => setDuplicate(null)}
      />
    </>
  );
}
