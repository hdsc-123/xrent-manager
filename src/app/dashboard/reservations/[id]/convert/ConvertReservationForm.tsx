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
  pricePerDay: number;
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
    if (reservation.vehicleCategory) query.set("category", reservation.vehicleCategory);
    apiGet<{ vehicles: Vehicle[] }>(`/api/vehicles?${query.toString()}`)
      .then((data) => setVehicles(data.vehicles))
      .catch(() => setVehicles([]));
  }, [agencyId, reservation.vehicleCategory]);

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

  const days =
    startDateTime && endDateTime && endDateTime > startDateTime
      ? calculateDaysCount(startDateTime, endDateTime)
      : 0;

  const estimatedTotal = selectedVehicle && days > 0 ? selectedVehicle.pricePerDay * days : 0;

  function buildPayload(overrides?: { useExistingClientId?: string; forceCreateClient?: boolean }) {
    const depositMad = deposit ? Number(deposit.replace(",", ".")) : undefined;

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
      notes: notes || undefined,
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
    if (!startDateTime || !endDateTime || endDateTime <= startDateTime) {
      setError("Dates/heures de départ et de retour invalides.");
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
                <Label htmlFor="firstName">Prénom</Label>
                <Input id="firstName" required value={firstName} onChange={(e) => setFirstName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lastName">Nom</Label>
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
              <Label htmlFor="address">
                Adresse <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="address" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="city">
                  Ville <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="country">
                  Pays <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input id="country" value={country} onChange={(e) => setCountry(e.target.value)} />
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
                <Label htmlFor="idNumber">
                  N° de pièce <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input id="idNumber" value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="licenseNumber">
                Numéro de permis <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="licenseNumber" value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="licenseIssueDate">
                  Date d&apos;obtention <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input
                  id="licenseIssueDate"
                  type="date"
                  value={licenseIssueDate}
                  onChange={(e) => setLicenseIssueDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="licenseExpiryDate">
                  Date d&apos;expiration <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input
                  id="licenseExpiryDate"
                  type="date"
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
              <Label htmlFor="vehicleId">
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
                    {vehicle.name} ({vehicle.licensePlate}) — {formatMoney(vehicle.pricePerDay, vehicle.currency)}/jour
                  </option>
                ))}
              </select>
              {vehicles.length === 0 && (
                <p className="text-xs text-muted-foreground">Aucun véhicule disponible pour ces critères.</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startDate">Date de départ</Label>
                <Input id="startDate" type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startTime">Heure de départ</Label>
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
                <Label htmlFor="endDate">Date de retour</Label>
                <Input id="endDate" type="date" required value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="endTime">Heure de retour</Label>
                <Input id="endTime" type="time" required value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </div>
            </div>

            {selectedVehicle && days > 0 && (
              <p className="text-sm text-muted-foreground">
                {days} jour(s) × {formatMoney(selectedVehicle.pricePerDay, selectedVehicle.currency)} ={" "}
                <span className="font-medium text-foreground">{formatMoney(estimatedTotal, selectedVehicle.currency)}</span>
              </p>
            )}
            {!selectedVehicle && reservation.totalPrice !== null && (
              <p className="text-xs text-muted-foreground">
                Prix informatif de la réservation : {formatMoney(reservation.totalPrice, reservation.currency)}{" "}
                — le prix réel du contrat sera calculé à partir du véhicule sélectionné.
              </p>
            )}

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
