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
  FuelLevelSelect,
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
  /** Campagne QA (2026-08-27) — reflète locations.upgrade.commercial_gesture côté serveur (voir
   * page.tsx) : n'affiche l'option COMMERCIAL_GESTURE que si l'utilisateur la possède réellement,
   * sans jamais remplacer le contrôle serveur (POST /api/reservations/[id]/convert le revérifie). */
  canCommercialGesture: boolean;
}

const UPGRADE_TYPE_OPTIONS = [
  { value: "CUSTOMER_REQUEST", label: "Demande du client (payant par défaut)" },
  { value: "UNAVAILABILITY", label: "Indisponibilité de la catégorie réservée (gratuit)" },
  { value: "COMMERCIAL_GESTURE", label: "Geste commercial (gratuit ou réduit)" },
] as const;

type UpgradeTypeValue = (typeof UPGRADE_TYPE_OPTIONS)[number]["value"] | "";

export function ConvertReservationForm({ reservation, agencies, canCommercialGesture }: ConvertReservationFormProps) {
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
  const [birthDate, setBirthDate] = useState("");

  // Location — pré-remplie depuis la réservation.
  const [startDate, setStartDate] = useState(toDateInputValue(reservation.startDate));
  const [startTime, setStartTime] = useState(reservation.startTime ?? "10:00");
  const [endDate, setEndDate] = useState(toDateInputValue(reservation.endDate));
  const [endTime, setEndTime] = useState(reservation.endTime ?? reservation.startTime ?? "10:00");
  const [deposit, setDeposit] = useState("");
  const [notes, setNotes] = useState(reservation.notes ?? "");

  // Kilométrage/carburant de départ (correctif finding F-3, validation manuelle 2026-08-25,
  // startOdometer rendu obligatoire au second passage) : jusqu'ici absents de ce formulaire,
  // contrairement à /dashboard/locations/new — un contrat issu d'une conversion n'avait donc
  // jamais de Location.startOdometer connu, désactivant silencieusement le contrôle du
  // kilométrage au retour. Préremplis depuis le dernier état connu du véhicule (même source que
  // la création directe, DOMAINRULES.md section 40 point 2) ; startOdometer est désormais
  // obligatoire ici spécifiquement (l'utilisateur doit le corriger manuellement si le véhicule
  // n'a aucun état connu), startFuelLevel reste optionnel. Modifiables ensuite librement une fois
  // le contrat créé (jamais verrouillés, DOMAINRULES.md section 41 point 4).
  const [startOdometer, setStartOdometer] = useState("");
  const [startFuelLevel, setStartFuelLevel] = useState("");

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
  // Surclassement (campagne QA, 2026-08-27, passe de correction obligatoire) : ces champs ne
  // sont plus qu'une DÉCLARATION envoyée au serveur (src/lib/location-upgrades.ts) — le serveur
  // revalide tout (type, motif, accord/justification, supplément) et recalcule intégralement le
  // montant, jamais accepté tel quel depuis ces champs (voir buildPayload plus bas).
  const [upgradeType, setUpgradeType] = useState<UpgradeTypeValue>("");
  const [upgradeReason, setUpgradeReason] = useState("");
  const [upgradeCustomerConsent, setUpgradeCustomerConsent] = useState(false);
  const [upgradeDailySupplement, setUpgradeDailySupplement] = useState("");

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
  const [secondDriverBirthDate, setSecondDriverBirthDate] = useState("");

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

  // Correctif (finding F-3) : même source/pattern que NewLocationForm.tsx — le kilométrage/
  // carburant de départ du contrat prennent comme point de départ le dernier état connu du
  // véhicule (getVehicleLastKnownState, src/lib/vehicles.ts), rechargé à chaque changement de
  // véhicule. Les champs restent modifiables ensuite (jamais verrouillés) : un contrat capture
  // un état réel constaté au comptoir, qui peut légitimement différer de la dernière valeur
  // enregistrée en base.
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
  const upgradeDailySupplementCentimes = upgradeDailySupplement
    ? Math.round(Number(upgradeDailySupplement.replace(",", ".")) * 100)
    : 0;
  // Estimation indicative uniquement (même formule que le serveur, mais affichée avant
  // soumission pour aider l'utilisateur) — le serveur recalcule et vérifie ce montant
  // indépendamment ; ne jamais afficher ceci comme le montant final du contrat (Partie F).
  const estimatedUpgradeSupplement =
    isUpgrade && days > 0 && upgradeDailySupplementCentimes > 0 ? upgradeDailySupplementCentimes * days : 0;

  // Remet à zéro la déclaration de surclassement si elle ne s'applique plus (véhicule remis à
  // la catégorie réservée) — évite d'envoyer une déclaration obsolète au serveur.
  const [upgradeResetKey, setUpgradeResetKey] = useState(isUpgrade);
  if (isUpgrade !== upgradeResetKey && !isUpgrade) {
    setUpgradeResetKey(isUpgrade);
    setUpgradeType("");
    setUpgradeReason("");
    setUpgradeCustomerConsent(false);
    setUpgradeDailySupplement("");
  } else if (isUpgrade !== upgradeResetKey) {
    setUpgradeResetKey(isUpgrade);
  }

  function buildPayload(overrides?: { useExistingClientId?: string; forceCreateClient?: boolean }) {
    const depositMad = deposit ? Number(deposit.replace(",", ".")) : undefined;

    // Correctif (campagne QA, 2026-08-27, passe de correction obligatoire) : le montant du
    // surclassement n'est plus jamais plié dans totalPrice côté client — le serveur
    // (resolveLocationUpgrade) recalcule et ajoute lui-même le supplément au total du contrat
    // à partir de la déclaration `upgrade` ci-dessous, jamais depuis une valeur envoyée ici.
    const totalPriceCentimes = totalPriceOverride
      ? Math.round(Number(totalPriceOverride.replace(",", ".")) * 100)
      : undefined;
    const finalTotalPrice =
      totalPriceCentimes !== undefined && Number.isFinite(totalPriceCentimes) ? totalPriceCentimes : undefined;
    const finalNotes = notes || undefined;

    const upgrade =
      isUpgrade && upgradeType
        ? {
            type: upgradeType,
            reason: upgradeReason,
            ...(upgradeType === "CUSTOMER_REQUEST"
              ? { customerConsent: upgradeCustomerConsent, dailySupplement: upgradeDailySupplementCentimes }
              : {}),
            ...(upgradeType === "COMMERCIAL_GESTURE" ? { dailySupplement: upgradeDailySupplementCentimes } : {}),
          }
        : undefined;

    const secondDriver =
      hasSecondDriver && secondDriverFirstName && secondDriverLastName
        ? {
            firstName: secondDriverFirstName,
            lastName: secondDriverLastName,
            phone: secondDriverPhone || undefined,
            idNumber: secondDriverIdNumber || undefined,
            licenseNumber: secondDriverLicenseNumber || undefined,
            birthDate: secondDriverBirthDate || undefined,
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
      startOdometer: startOdometer ? Number(startOdometer) : undefined,
      startFuelLevel: startFuelLevel ? Number(startFuelLevel) : undefined,
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
        birthDate: birthDate || undefined,
      },
      secondDriver,
      payment,
      upgrade,
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
    if (!firstName.trim() || !lastName.trim()) {
      setError("Le prénom et le nom du client sont requis.");
      return;
    }
    // Sprint 19 (DOMAINRULES.md section 37) : obligatoires à la conversion (contrat) — ces
    // champs restent optionnels sur la réservation elle-même (import broker sans ces
    // informations, voir CLAUDE.md/DOMAINRULES.md), mais un contrat ne doit jamais être généré
    // sans identité complète du client.
    if (
      !address.trim() ||
      !city.trim() ||
      !country.trim() ||
      !idNumber.trim() ||
      !licenseNumber.trim() ||
      !licenseIssueDate ||
      !licenseExpiryDate ||
      !birthDate
    ) {
      setError(
        "Adresse, ville, pays, n° de pièce, n° de permis, dates d'obtention/expiration du permis et date de naissance sont requis pour générer le contrat."
      );
      return;
    }
    if (new Date(licenseExpiryDate) <= new Date(licenseIssueDate)) {
      setError("La date d'expiration du permis doit être postérieure à sa date d'obtention.");
      return;
    }
    if (!startDateTime || !endDateTime || endDateTime <= startDateTime) {
      setError("Dates/heures de départ et de retour invalides.");
      return;
    }
    if (hasSecondDriver && (!secondDriverFirstName.trim() || !secondDriverLastName.trim())) {
      setError("Le prénom et le nom du second conducteur sont requis.");
      return;
    }
    if (hasSecondDriver && !secondDriverBirthDate) {
      setError("La date de naissance du second conducteur est requise.");
      return;
    }
    if (!pricePerDayCentimes) {
      setError("Le prix / jour doit être renseigné (un nombre positif).");
      return;
    }
    // Surclassement (campagne QA, 2026-08-27) : contrôle local non authoritative — juste pour
    // éviter un aller-retour serveur évitable, le serveur revalide tout de façon indépendante
    // (src/lib/location-upgrades.ts).
    if (isUpgrade) {
      if (!upgradeType) {
        setError("Sélectionnez un type de surclassement pour ce changement de catégorie.");
        return;
      }
      if (!upgradeReason.trim()) {
        setError("Le motif du surclassement est requis.");
        return;
      }
      if (upgradeType === "CUSTOMER_REQUEST") {
        if (!upgradeCustomerConsent) {
          setError("L'accord explicite du client est requis pour une demande client.");
          return;
        }
        if (upgradeDailySupplementCentimes < 1) {
          setError("Le supplément par jour doit être strictement positif pour une demande client.");
          return;
        }
      }
      if (upgradeType === "COMMERCIAL_GESTURE" && upgradeDailySupplementCentimes < 0) {
        setError("Le supplément du geste commercial ne peut pas être négatif.");
        return;
      }
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

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="birthDate" required>Date de naissance</Label>
              <Input
                id="birthDate"
                type="date"
                required
                max={new Date().toISOString().slice(0, 10)}
                value={birthDate}
                onChange={(e) => setBirthDate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Le conducteur doit avoir au moins 21 ans à la date de départ du contrat.
              </p>
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
              <div className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                <p className="font-medium">
                  Surclassement : catégorie réservée <strong>{reservation.vehicleCategory}</strong> → véhicule
                  proposé <strong>{selectedVehicle?.category}</strong>.
                </p>
                <p className="text-xs text-muted-foreground">
                  Ce changement de catégorie doit être déclaré. Le serveur vérifie systématiquement cette
                  déclaration (type, motif, accord/justification, supplément) et recalcule seul le montant
                  définitif ajouté au contrat — les valeurs saisies ci-dessous ne sont qu&apos;indicatives.
                </p>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="upgradeType" required>Type de surclassement</Label>
                  <select
                    id="upgradeType"
                    required
                    value={upgradeType}
                    onChange={(e) => setUpgradeType(e.target.value as UpgradeTypeValue)}
                    className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  >
                    <option value="" disabled>
                      Sélectionner…
                    </option>
                    {UPGRADE_TYPE_OPTIONS.filter(
                      (option) => option.value !== "COMMERCIAL_GESTURE" || canCommercialGesture
                    ).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {!canCommercialGesture && (
                    <p className="text-xs text-muted-foreground">
                      Le geste commercial nécessite une permission dédiée que vous ne possédez pas.
                    </p>
                  )}
                </div>

                {upgradeType && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="upgradeReason" required>
                      {upgradeType === "UNAVAILABILITY" ? "Justification opérationnelle" : "Motif"}
                    </Label>
                    <Input
                      id="upgradeReason"
                      required
                      value={upgradeReason}
                      onChange={(e) => setUpgradeReason(e.target.value)}
                    />
                  </div>
                )}

                {upgradeType === "CUSTOMER_REQUEST" && (
                  <>
                    <label className="flex items-center gap-2">
                      <Checkbox
                        checked={upgradeCustomerConsent}
                        onCheckedChange={(checked) => setUpgradeCustomerConsent(checked === true)}
                      />
                      <span>
                        Le client a explicitement accepté le supplément <span className="text-destructive">*</span>
                      </span>
                    </label>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="upgradeDailySupplement" required>
                        Supplément / jour (MAD)
                      </Label>
                      <Input
                        id="upgradeDailySupplement"
                        inputMode="decimal"
                        required
                        className="w-32"
                        value={upgradeDailySupplement}
                        onChange={(e) => setUpgradeDailySupplement(e.target.value)}
                      />
                    </div>
                  </>
                )}

                {upgradeType === "UNAVAILABILITY" && (
                  <p className="text-xs text-muted-foreground">
                    Surclassement gratuit par défaut (aucun supplément) : le serveur vérifie qu&apos;aucun véhicule
                    de la catégorie réservée n&apos;est réellement disponible sur cette période avant d&apos;accepter
                    ce motif.
                  </p>
                )}

                {upgradeType === "COMMERCIAL_GESTURE" && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="upgradeDailySupplement">
                      Supplément / jour (MAD) <span className="text-muted-foreground">— optionnel, 0 = gratuit</span>
                    </Label>
                    <Input
                      id="upgradeDailySupplement"
                      inputMode="decimal"
                      className="w-32"
                      value={upgradeDailySupplement}
                      onChange={(e) => setUpgradeDailySupplement(e.target.value)}
                    />
                  </div>
                )}

                {upgradeType && estimatedUpgradeSupplement > 0 && selectedVehicle && (
                  <p className="text-xs text-muted-foreground">
                    Estimation indicative : {days} jour(s) × {formatMoney(upgradeDailySupplementCentimes, selectedVehicle.currency)}{" "}
                    = <span className="font-medium text-foreground">{formatMoney(estimatedUpgradeSupplement, selectedVehicle.currency)}</span>{" "}
                    — montant définitif recalculé et vérifié par le serveur.
                  </p>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startOdometer" required>
                  Kilométrage départ
                </Label>
                <Input
                  id="startOdometer"
                  type="number"
                  min={0}
                  step={1}
                  required
                  value={startOdometer}
                  onChange={(e) => setStartOdometer(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Prérempli depuis le dernier état connu du véhicule, à corriger si nécessaire.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startFuelLevel">
                  Carburant départ <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <FuelLevelSelect id="startFuelLevel" value={startFuelLevel} onChange={setStartFuelLevel} />
              </div>
            </div>

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
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="secondDriverBirthDate" required>Date de naissance</Label>
                  <Input
                    id="secondDriverBirthDate"
                    type="date"
                    required
                    max={new Date().toISOString().slice(0, 10)}
                    value={secondDriverBirthDate}
                    onChange={(e) => setSecondDriverBirthDate(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Le second conducteur doit aussi avoir au moins 21 ans à la date de départ du contrat.
                  </p>
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
