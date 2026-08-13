"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
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
import { DuplicateCheck, type DuplicateClientInfo } from "../DuplicateCheck";

const ID_TYPE_OPTIONS = [
  { value: "CIN", label: "CIN" },
  { value: "PASSEPORT", label: "Passeport" },
  { value: "CARTE_SEJOUR", label: "Carte de séjour" },
];

export default function NewClientPage() {
  const router = useRouter();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [altPhone, setAltPhone] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [idType, setIdType] = useState("CIN");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [licenseIssueDate, setLicenseIssueDate] = useState("");
  const [licenseExpiryDate, setLicenseExpiryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateClientInfo | null>(null);

  function buildPayload(overrides?: { useExistingClientId?: string; forceCreate?: boolean }) {
    return {
      firstName,
      lastName,
      email: email || undefined,
      phone: phone || undefined,
      altPhone: altPhone || undefined,
      address: address || undefined,
      city: city || undefined,
      country: country || undefined,
      idNumber: idNumber || undefined,
      idType,
      licenseNumber: licenseNumber || undefined,
      licenseIssueDate: licenseIssueDate || undefined,
      licenseExpiryDate: licenseExpiryDate || undefined,
      notes: notes || undefined,
      ...overrides,
    };
  }

  async function submit(overrides?: { useExistingClientId?: string; forceCreate?: boolean }) {
    setIsSubmitting(true);
    try {
      await apiPost("/api/clients", buildPayload(overrides));
      toast.success("Client créé.");
      router.push("/dashboard/clients");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body && typeof err.body === "object" && "duplicate" in err.body) {
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

    if (!firstName || !lastName) {
      setError("Le prénom et le nom sont requis.");
      return;
    }

    await submit();
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold">Créer un client</h1>

      <Card>
        <CardHeader>
          <CardTitle>Informations</CardTitle>
          <CardDescription>Coordonnées, pièce d&apos;identité et permis de conduire.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="firstName" required>Prénom</Label>
                <Input
                  id="firstName"
                  required
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lastName" required>Nom</Label>
                <Input
                  id="lastName"
                  required
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="phone" required>Téléphone</Label>
              <PhoneInput id="phone" required value={phone} onChange={setPhone} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="altPhone">
                Téléphone secondaire <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <PhoneInput id="altPhone" value={altPhone} onChange={setAltPhone} />
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
              <Label htmlFor="licenseNumber" required>Numéro de permis</Label>
              <Input
                id="licenseNumber"
                required
                value={licenseNumber}
                onChange={(e) => setLicenseNumber(e.target.value)}
              />
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
              <Label htmlFor="notes">
                Notes internes <span className="text-muted-foreground">— optionnel</span>
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
          void submit({ forceCreate: true });
        }}
        onCancel={() => setDuplicate(null)}
      />
    </div>
  );
}
