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
}: EditAgencyFormProps) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [city, setCity] = useState(initialCity ?? "");
  const [address, setAddress] = useState(initialAddress ?? "");
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [managerName, setManagerName] = useState(initialManagerName ?? "");
  const [managerPhone, setManagerPhone] = useState(initialManagerPhone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
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
            <Label htmlFor="name">Nom</Label>
            <Input
              id="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="city">Ville</Label>
            <Input id="city" required value={city} onChange={(e) => setCity(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="address">Adresse</Label>
            <Input
              id="address"
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="phone">Téléphone</Label>
            <PhoneInput id="phone" required value={phone} onChange={setPhone} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="managerName">Nom du responsable</Label>
            <Input
              id="managerName"
              required
              value={managerName}
              onChange={(e) => setManagerName(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="managerPhone">Téléphone du responsable</Label>
            <PhoneInput
              id="managerPhone"
              required
              value={managerPhone}
              onChange={setManagerPhone}
            />
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
