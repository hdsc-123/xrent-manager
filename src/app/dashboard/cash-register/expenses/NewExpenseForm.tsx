"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@/components/ui";

interface NewExpenseFormProps {
  categories: { id: string; name: string }[];
  /** cash_register.manage_categories (voir src/lib/permissions.ts) — sans cette permission,
   * la création d'une nouvelle catégorie depuis ce formulaire est masquée ; seule la sélection
   * d'une catégorie existante reste possible, calculé côté serveur par la page appelante. */
  canManageCategories?: boolean;
  /** Sprint 22 — voir le même prop sur NewEntryForm.tsx. */
  agencies?: { id: string; name: string }[];
}

export function NewExpenseForm({ categories, canManageCategories = false, agencies = [] }: NewExpenseFormProps) {
  const router = useRouter();
  const [category, setCategory] = useState(categories[0]?.name ?? "");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [showNewCategory, setShowNewCategory] = useState(canManageCategories && categories.length === 0);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [agencyId, setAgencyId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const effectiveCategory = showNewCategory ? newCategoryName.trim() : category;
    if (!effectiveCategory) {
      setError("Une catégorie est requise.");
      return;
    }

    const amountMad = Number(amount.replace(",", "."));
    if (!Number.isFinite(amountMad) || amountMad <= 0) {
      setError("Le montant doit être un nombre positif.");
      return;
    }

    setIsSubmitting(true);
    try {
      if (canManageCategories && showNewCategory && newCategoryName.trim()) {
        try {
          await apiPost("/api/cash-register/categories", { name: newCategoryName.trim() });
        } catch (err) {
          // 409 = catégorie déjà existante sous ce nom : on continue quand même, la dépense
          // référence la catégorie par son nom (texte libre), pas par un id.
          if (!(err instanceof ApiError && err.status === 409)) {
            throw err;
          }
        }
      }

      await apiPost("/api/cash-register", {
        type: "EXPENSE",
        category: effectiveCategory,
        amount: Math.round(amountMad * 100),
        description: description || undefined,
        agencyId: agencyId || undefined,
      });
      toast.success("Dépense enregistrée.");
      setAmount("");
      setDescription("");
      setNewCategoryName("");
      setShowNewCategory(false);
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
        <CardTitle>Nouvelle dépense</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="expense-category">Catégorie</Label>
              {canManageCategories && categories.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowNewCategory((v) => !v)}
                  className="text-xs text-primary hover:underline"
                >
                  {showNewCategory ? "Choisir une catégorie existante" : "Nouvelle catégorie"}
                </button>
              )}
            </div>
            {canManageCategories && showNewCategory ? (
              <Input
                id="expense-category"
                placeholder="Nom de la catégorie"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
              />
            ) : (
              <select
                id="expense-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {categories.map((option) => (
                  <option key={option.id} value={option.name}>
                    {option.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="expense-amount" required>Montant (MAD)</Label>
            <Input
              id="expense-amount"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-32"
            />
          </div>

          {agencies.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-agency">Agence (optionnel)</Label>
              <select
                id="expense-agency"
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
            <Label htmlFor="expense-description">Description (optionnel)</Label>
            <Input id="expense-description" value={description} onChange={(e) => setDescription(e.target.value)} />
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
