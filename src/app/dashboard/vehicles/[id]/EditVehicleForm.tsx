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
} from "@/components/ui";

const STATUS_OPTIONS = [
  { value: "AVAILABLE", label: "Disponible" },
  { value: "RENTED", label: "Loué" },
  { value: "MAINTENANCE", label: "Maintenance" },
  { value: "INACTIVE", label: "Inactif" },
];

interface EditVehicleFormProps {
  id: string;
  initialName: string;
  initialCategory: string;
  initialStatus: string;
  initialPricePerDay: number;
  licensePlate: string;
}

export function EditVehicleForm({
  id,
  initialName,
  initialCategory,
  initialStatus,
  initialPricePerDay,
  licensePlate,
}: EditVehicleFormProps) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState(initialCategory);
  const [status, setStatus] = useState(initialStatus);
  const [pricePerDay, setPricePerDay] = useState((initialPricePerDay / 100).toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const priceEuros = Number(pricePerDay.replace(",", "."));
    if (!Number.isFinite(priceEuros) || priceEuros <= 0) {
      setError("Le prix par jour doit être un nombre positif.");
      return;
    }

    setIsSubmitting(true);
    try {
      await apiPatch(`/api/vehicles/${id}`, {
        name,
        category,
        status,
        pricePerDay: Math.round(priceEuros * 100),
      });
      toast.success("Véhicule mis à jour.");
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
        <CardTitle>Modifier le véhicule</CardTitle>
        <CardDescription>
          L&apos;immatriculation (« {licensePlate} ») n&apos;est pas modifiable depuis cette page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Nom</Label>
            <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="category">Catégorie</Label>
            <Input
              id="category"
              required
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
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
                required
                value={pricePerDay}
                onChange={(e) => setPricePerDay(e.target.value)}
              />
            </div>
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
