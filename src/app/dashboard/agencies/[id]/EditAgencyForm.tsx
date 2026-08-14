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

interface EditAgencyFormProps {
  id: string;
  initialName: string;
  slug: string;
  initialCity: string | null;
  initialAddress: string | null;
  initialPhone: string | null;
  initialEmail: string | null;
  initialManagerName: string | null;
  initialManagerPhone: string | null;
  /** Numérotation des contrats (Sprint 15 — déplacée depuis Tenant, DOMAINRULES.md section 29 :
   * chaque agence a désormais son propre préfixe et sa propre séquence indépendante). */
  initialContractNumberPrefix: string;
  initialLastContractNumber: number;
}

export function EditAgencyForm({
  id,
  initialName,
  slug,
  initialCity,
  initialAddress,
  initialPhone,
  initialEmail,
  initialManagerName,
  initialManagerPhone,
  initialContractNumberPrefix,
  initialLastContractNumber,
}: EditAgencyFormProps) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [city, setCity] = useState(initialCity ?? "");
  const [address, setAddress] = useState(initialAddress ?? "");
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [managerName, setManagerName] = useState(initialManagerName ?? "");
  const [managerPhone, setManagerPhone] = useState(initialManagerPhone ?? "");
  const [contractNumberPrefix, setContractNumberPrefix] = useState(initialContractNumberPrefix);
  const [lastContractNumber, setLastContractNumber] = useState(String(initialLastContractNumber));
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const lastContractNumberValue = Number(lastContractNumber);
    if (!Number.isInteger(lastContractNumberValue) || lastContractNumberValue < 0) {
      setError("Le dernier numéro de contrat utilisé doit être un entier positif ou nul.");
      return;
    }

    setIsSubmitting(true);

    try {
      await apiPatch(`/api/agencies/${id}`, {
        name,
        city,
        address,
        phone,
        email,
        managerName,
        managerPhone,
        contractNumberPrefix: contractNumberPrefix.trim(),
        lastContractNumber: lastContractNumberValue,
      });
      toast.success("Agence mise à jour.");
      router.push("/dashboard/agencies");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const previewNumber = contractNumberPrefix.trim()
    ? `${contractNumberPrefix.trim()}-${String(Math.max(0, (Number.isInteger(Number(lastContractNumber)) ? Number(lastContractNumber) : 0) + 1)).padStart(5, "0")}`
    : String(Math.max(0, (Number.isInteger(Number(lastContractNumber)) ? Number(lastContractNumber) : 0) + 1)).padStart(5, "0");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Modifier l&apos;agence</CardTitle>
        <CardDescription>
          Le slug (« {slug} ») n&apos;est pas modifiable depuis cette page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name" required>Nom</Label>
            <Input
              id="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="city" required>Ville</Label>
            <Input id="city" required value={city} onChange={(e) => setCity(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="address" required>Adresse</Label>
            <Input
              id="address"
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="phone" required>Téléphone</Label>
            <PhoneInput id="phone" required value={phone} onChange={setPhone} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email" required>Email</Label>
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="managerName" required>Nom du responsable</Label>
            <Input
              id="managerName"
              required
              value={managerName}
              onChange={(e) => setManagerName(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="managerPhone" required>Téléphone du responsable</Label>
            <PhoneInput
              id="managerPhone"
              required
              value={managerPhone}
              onChange={setManagerPhone}
            />
          </div>

          <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            <span className="text-sm font-medium">Numérotation des contrats</span>
            <p className="text-xs text-muted-foreground">
              Propre à cette agence — chaque agence a son propre préfixe et sa propre séquence,
              indépendante des autres agences du tenant.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="contractNumberPrefix">
                  Préfixe <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input
                  id="contractNumberPrefix"
                  placeholder="RAK"
                  value={contractNumberPrefix}
                  onChange={(event) => setContractNumberPrefix(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lastContractNumber" required>Dernier numéro utilisé</Label>
                <Input
                  id="lastContractNumber"
                  type="number"
                  min={0}
                  required
                  value={lastContractNumber}
                  onChange={(event) => setLastContractNumber(event.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Le prochain contrat créé pour cette agence portera le numéro{" "}
              <span className="font-medium">{previewNumber}</span>. Ne modifiez le dernier numéro
              utilisé que pour reprendre une numérotation existante (ex. migration depuis un autre
              système).
            </p>
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
