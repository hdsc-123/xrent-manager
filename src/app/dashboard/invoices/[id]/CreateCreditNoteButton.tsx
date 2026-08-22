"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@/components/ui";

interface CreateCreditNoteButtonProps {
  /** Id de la facture SOURCE (jamais celui d'un avoir) — POST .../[id]/credit-notes est adressé
   * par l'id de la facture à créditer, voir src/app/api/invoices/[id]/credit-notes/route.ts. */
  sourceInvoiceId: string;
  /** netAmount de la source (totalAmount - déjà crédité) — plafond indicatif affiché à
   * l'utilisateur, jamais autoritaire : le serveur revalide le même plafond sous verrou
   * (createCreditNote, src/lib/invoices.ts) au moment de l'écriture. */
  remainingCredit: number;
  currency: string;
}

/**
 * Bouton + dialogue "Créer un avoir" — sous-phase 2c2-D. Réservé ADMIN (gating côté page
 * appelante, `isAdmin`, lui-même dérivé de `user.role` — jamais une permission granulaire, même
 * principe que POST .../credit-notes) : ce composant n'est rendu par la page que si l'appelant
 * a déjà vérifié `isAdmin`, mais la route reste de toute façon strictement ADMIN côté serveur
 * (défense en profondeur, jamais un contrôle uniquement côté UI).
 */
export function CreateCreditNoteButton({ sourceInvoiceId, remainingCredit, currency }: CreateCreditNoteButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!reason.trim()) {
      setError("Un motif est obligatoire.");
      return;
    }
    const amountInSmallestUnit = Math.round(Number(amount.replace(",", ".")) * 100);
    if (!Number.isInteger(amountInSmallestUnit) || amountInSmallestUnit <= 0) {
      setError("Le montant doit être un nombre positif.");
      return;
    }
    // Feedback immédiat, non autoritaire — le serveur revalide le plafond réel sous verrou
    // (createCreditNote) au moment de l'écriture, contre un état qui peut avoir changé pendant
    // que ce dialogue était ouvert (un autre avoir créé entretemps, par exemple).
    if (amountInSmallestUnit > remainingCredit) {
      setError(
        `Le montant dépasse le solde encore créditable (${formatMoney(remainingCredit, currency)}).`
      );
      return;
    }

    setIsSubmitting(true);
    try {
      await apiPost(`/api/invoices/${sourceInvoiceId}/credit-notes`, {
        amount: amountInSmallestUnit,
        reason,
      });
      toast.success("Avoir créé.");
      setOpen(false);
      setAmount("");
      setReason("");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erreur lors de la création de l'avoir.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => setOpen(true)}>
        Créer un avoir
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Créer un avoir</DialogTitle>
            <DialogDescription>
              Solde encore créditable sur cette facture : {formatMoney(remainingCredit, currency)}. La création d&apos;un
              avoir ne déclenche jamais de remboursement automatique — un remboursement reste une action distincte,
              disponible séparément sur la page de l&apos;avoir une fois créé.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="creditNoteAmount" required>
                Montant ({currency})
              </Label>
              <Input
                id="creditNoteAmount"
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="creditNoteReason" required>
                Motif
              </Label>
              <Input id="creditNoteReason" required value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Création..." : "Créer l'avoir"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
