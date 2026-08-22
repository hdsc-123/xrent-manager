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

type PaymentMethod = "CASH" | "CARD" | "BANK_TRANSFER" | "CHECK" | "OTHER";

const METHOD_OPTIONS: { value: PaymentMethod; label: string }[] = [
  { value: "CASH", label: "Espèces" },
  { value: "CARD", label: "Carte" },
  { value: "BANK_TRANSFER", label: "Virement" },
  { value: "CHECK", label: "Chèque" },
  { value: "OTHER", label: "Autre" },
];

interface RefundCreditNoteButtonProps {
  /** Id de l'AVOIR lui-même (jamais sa facture source) — POST .../[id]/refund est adressé par
   * l'id de l'avoir à rembourser, voir src/app/api/invoices/[id]/refund/route.ts. */
  creditNoteId: string;
  refundableAmount: number;
  currency: string;
}

/**
 * Bouton + dialogue "Rembourser" — sous-phase 2c2-C/2c2-D. N'est rendu par la page appelante que
 * si `isAdmin` (dérivé de `user.role`, jamais une permission granulaire) ET `refundableAmount >
 * 0` — mais la route reste de toute façon strictement ADMIN et revalide le plafond réel sous
 * verrou côté serveur (refundCreditNote, src/lib/invoices.ts) : ce composant ne mute jamais
 * localement un montant avant confirmation serveur, `router.refresh()` recharge toujours les
 * données réelles après succès.
 */
export function RefundCreditNoteButton({ creditNoteId, refundableAmount, currency }: RefundCreditNoteButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState((refundableAmount / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("CASH");
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
    // Feedback immédiat, non autoritaire — le serveur reverrouille la facture source et
    // recalcule le plafond réel (refundCreditNote) juste avant d'écrire quoi que ce soit.
    if (amountInSmallestUnit > refundableAmount) {
      setError(`Le montant dépasse le montant encore remboursable (${formatMoney(refundableAmount, currency)}).`);
      return;
    }

    setIsSubmitting(true);
    try {
      await apiPost(`/api/invoices/${creditNoteId}/refund`, {
        amount: amountInSmallestUnit,
        reason,
        paymentMethod: method,
      });
      toast.success("Remboursement enregistré.");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erreur lors du remboursement.");
      // Concurrence/plafond obsolète : on recharge quand même les données réelles (l'avoir n'a
      // structurellement pas pu être modifié par cet échec, mais le plafond affiché peut l'être
      // si un autre remboursement concurrent vient d'aboutir sur la même facture source).
      router.refresh();
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="default" className="w-fit" onClick={() => setOpen(true)}>
        Rembourser
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rembourser cet avoir</DialogTitle>
            <DialogDescription>
              Montant encore remboursable : {formatMoney(refundableAmount, currency)}. Cette action crée un mouvement
              de caisse réel et immédiat — elle est distincte et irréversible, indépendante de la création de
              l&apos;avoir.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refundAmount" required>
                  Montant ({currency})
                </Label>
                <Input
                  id="refundAmount"
                  inputMode="decimal"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refundMethod">Méthode</Label>
                <select
                  id="refundMethod"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  {METHOD_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="refundReason" required>
                Motif
              </Label>
              <Input id="refundReason" required value={reason} onChange={(e) => setReason(e.target.value)} />
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
                {isSubmitting ? "Enregistrement..." : "Confirmer le remboursement"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
