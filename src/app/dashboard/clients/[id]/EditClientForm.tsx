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

const ID_TYPE_OPTIONS = [
  { value: "CIN", label: "CIN" },
  { value: "PASSEPORT", label: "Passeport" },
  { value: "CARTE_SEJOUR", label: "Carte de séjour" },
];

interface EditClientFormProps {
  id: string;
  initialFirstName: string | null;
  initialLastName: string | null;
  initialEmail: string | null;
  initialPhone: string | null;
  initialAltPhone: string | null;
  initialAddress: string | null;
  initialCity: string | null;
  initialCountry: string | null;
  initialIdNumber: string | null;
  initialIdType: string | null;
  initialLicenseNumber: string | null;
  initialLicenseIssueDate: string | null;
  initialLicenseExpiryDate: string | null;
  initialBirthDate: string | null;
  initialNotes: string | null;
}

export function EditClientForm({
  id,
  initialFirstName,
  initialLastName,
  initialEmail,
  initialPhone,
  initialAltPhone,
  initialAddress,
  initialCity,
  initialCountry,
  initialIdNumber,
  initialIdType,
  initialLicenseNumber,
  initialLicenseIssueDate,
  initialLicenseExpiryDate,
  initialBirthDate,
  initialNotes,
}: EditClientFormProps) {
  const router = useRouter();
  const [firstName, setFirstName] = useState(initialFirstName ?? "");
  const [lastName, setLastName] = useState(initialLastName ?? "");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [altPhone, setAltPhone] = useState(initialAltPhone ?? "");
  const [address, setAddress] = useState(initialAddress ?? "");
  const [city, setCity] = useState(initialCity ?? "");
  const [country, setCountry] = useState(initialCountry ?? "");
  const [idNumber, setIdNumber] = useState(initialIdNumber ?? "");
  const [idType, setIdType] = useState(initialIdType ?? "CIN");
  const [licenseNumber, setLicenseNumber] = useState(initialLicenseNumber ?? "");
  const [licenseIssueDate, setLicenseIssueDate] = useState(initialLicenseIssueDate ?? "");
  const [licenseExpiryDate, setLicenseExpiryDate] = useState(initialLicenseExpiryDate ?? "");
  const [birthDate, setBirthDate] = useState(initialBirthDate ?? "");
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!firstName.trim() || !lastName.trim()) {
      setError("Le prénom et le nom sont requis.");
      return;
    }
    if (!phone.trim()) {
      setError("Le téléphone est requis.");
      return;
    }
    if (!address.trim()) {
      setError("L'adresse est requise.");
      return;
    }
    if (!city.trim()) {
      setError("La ville est requise.");
      return;
    }
    if (!licenseNumber.trim()) {
      setError("Le numéro de permis est requis.");
      return;
    }
    if (!licenseIssueDate) {
      setError("La date d'obtention du permis est requise.");
      return;
    }
    if (!licenseExpiryDate) {
      setError("La date d'expiration du permis est requise.");
      return;
    }
    if (new Date(licenseExpiryDate) <= new Date(licenseIssueDate)) {
      setError("La date d'expiration du permis doit être postérieure à sa date d'obtention.");
      return;
    }

    setIsSubmitting(true);
    try {
      await apiPatch(`/api/clients/${id}`, {
        firstName,
        lastName,
        email: email || null,
        phone: phone || null,
        altPhone: altPhone || null,
        address: address || null,
        city: city || null,
        country: country || null,
        idNumber: idNumber || null,
        idType,
        licenseNumber: licenseNumber || null,
        licenseIssueDate: licenseIssueDate || null,
        licenseExpiryDate: licenseExpiryDate || null,
        birthDate: birthDate || null,
        notes: notes || null,
      });
      toast.success("Client mis à jour.");
      router.push("/dashboard/clients");
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
        <CardTitle>Modifier le client</CardTitle>
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
            <Label htmlFor="birthDate">
              Date de naissance <span className="text-muted-foreground">— optionnel</span>
            </Label>
            <Input
              id="birthDate"
              type="date"
              max={new Date().toISOString().slice(0, 10)}
              value={birthDate}
              onChange={(e) => setBirthDate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Nécessaire pour désigner ce client comme conducteur d&apos;un contrat (âge minimum requis : 21 ans).
              Un client sans date de naissance peut être enregistré, mais ne pourra pas être conducteur.
            </p>
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

          <Button type="submit" disabled={isSubmitting} className="w-fit">
            {isSubmitting ? "Enregistrement..." : "Enregistrer"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
