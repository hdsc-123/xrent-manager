"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@/components/ui";

const CATEGORY_OPTIONS = ["VERSEMENT", "COMMISSION", "VIREMENT"];
const METHOD_OPTIONS = [
  { value: "CASH", label: "Espèces" },
  { value: "CARD", label: "Carte" },
  { value: "BANK_TRANSFER", label: "Virement" },
  { value: "CHECK", label: "Chèque" },
  { value: "OTHER", label: "Autre" },
];

interface NewEntryFormProps {
  /** Sprint 22 — agences accessibles à l'appelant, pour attribuer l'écriture manuelle à une
   * agence (optionnel) et permettre le calcul d'un solde par agence, voir
   * src/lib/cash-register.ts (getCashBalanceByAgency). */
  agencies?: { id: string; name: string }[];
}

export function NewEntryForm({ agencies = [] }: NewEntryFormProps) {
  const router = useRouter();
  const [category, setCategory] = useState(CATEGORY_OPTIONS[0]);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [clientName, setClientName] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [agencyId, setAgencyId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const amountMad = Number(amount.replace(",", "."));
    if (!Number.isFinite(amountMad) || amountMad <= 0) {
      setError("Le montant doit être un nombre positif.");
      return;
    }

    if (!description.trim()) {
      setError("La description est obligatoire.");
      return;
    }

    setIsSubmitting(true);
    try {
      await apiPost("/api/cash-register", {
        type: "ENTRY",
        category,
        amount: Math.round(amountMad * 100),
        description: description.trim(),
        clientName: clientName || undefined,
        paymentMethod,
        agencyId: agencyId || undefined,
      });
      toast.success("Entrée enregistrée.");
      setAmount("");
      setDescription("");
      setClientName("");
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
        <CardTitle>Nouvelle entrée</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-category">Catégorie</Label>
            <select
              id="entry-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-amount" required>Montant (MAD)</Label>
            <Input
              id="entry-amount"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-32"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-method">Mode</Label>
            <select
              id="entry-method"
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {METHOD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {agencies.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="entry-agency">Agence (optionnel)</Label>
              <select
                id="entry-agency"
                value={agencyId}
                onChange={(e) => setAgencyId(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="">—</option>
                {agencies.map((agency) => (
                  <option key={agency.id} value={agency.id}>
                    {agency.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-client">Client (optionnel)</Label>
            <Input id="entry-client" value={clientName} onChange={(e) => setClientName(e.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-description" required>Description</Label>
            <Input
              id="entry-description"
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Enregistrement..." : "Ajouter"}
          </Button>
        </form>
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
