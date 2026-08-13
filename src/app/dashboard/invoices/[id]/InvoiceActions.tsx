"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPatch, apiPost, ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@/components/ui";

type InvoiceStatus = "DRAFT" | "SENT" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";
type PaymentMethod = "CASH" | "CARD" | "BANK_TRANSFER" | "CHECK" | "OTHER";

/** Miroir client des transitions manuelles de src/lib/invoices.ts (ALLOWED_TRANSITIONS). */
const ALLOWED_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  DRAFT: ["SENT", "CANCELLED"],
  SENT: ["CANCELLED"],
  PARTIALLY_PAID: ["CANCELLED"],
  PAID: [],
  CANCELLED: [],
};

const STATUS_LABELS: Record<InvoiceStatus, string> = {
  DRAFT: "Brouillon",
  SENT: "Envoyée",
  PARTIALLY_PAID: "Partiellement payée",
  PAID: "Payée",
  CANCELLED: "Annulée",
};

const METHOD_OPTIONS: { value: PaymentMethod; label: string }[] = [
  { value: "CASH", label: "Espèces" },
  { value: "CARD", label: "Carte" },
  { value: "BANK_TRANSFER", label: "Virement" },
  { value: "CHECK", label: "Chèque" },
  { value: "OTHER", label: "Autre" },
];

interface InvoiceActionsProps {
  id: string;
  status: InvoiceStatus;
  remainingBalance: number;
  currency: string;
}

export function InvoiceActions({ id, status, remainingBalance, currency }: InvoiceActionsProps) {
  const router = useRouter();
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [amount, setAmount] = useState((remainingBalance / 100).toFixed(2));
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [isSubmittingPayment, setIsSubmittingPayment] = useState(false);

  async function handleTransition(next: InvoiceStatus) {
    setIsChangingStatus(true);
    try {
      await apiPatch(`/api/invoices/${id}`, { status: next });
      toast.success(`Statut mis à jour : ${STATUS_LABELS[next]}.`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors du changement de statut.");
    } finally {
      setIsChangingStatus(false);
    }
  }

  async function handleRecordPayment(event: React.FormEvent) {
    event.preventDefault();
    setPaymentError(null);

    const amountValue = Math.round(Number(amount.replace(",", ".")) * 100);
    if (!Number.isInteger(amountValue) || amountValue <= 0) {
      setPaymentError("Le montant doit être un nombre positif.");
      return;
    }

    setIsSubmittingPayment(true);
    try {
      await apiPost("/api/payments", {
        invoiceId: id,
        amount: amountValue,
        method,
        reference: reference || undefined,
        notes: notes || undefined,
      });
      toast.success("Paiement enregistré.");
      setShowPaymentDialog(false);
      router.refresh();
    } catch (err) {
      setPaymentError(err instanceof ApiError ? err.message : "Erreur lors de l'enregistrement du paiement.");
    } finally {
      setIsSubmittingPayment(false);
    }
  }

  const nextStatuses = ALLOWED_TRANSITIONS[status];
  const canRecordPayment = remainingBalance > 0 && status !== "CANCELLED";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Changer le statut</span>
          {nextStatuses.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Statut terminal ({STATUS_LABELS[status]}) — aucune transition manuelle possible.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {nextStatuses.map((next) => (
                <Button
                  key={next}
                  type="button"
                  size="sm"
                  variant={next === "CANCELLED" ? "destructive" : "default"}
                  disabled={isChangingStatus}
                  onClick={() => handleTransition(next)}
                >
                  {STATUS_LABELS[next]}
                </Button>
              ))}
            </div>
          )}
        </div>

        {canRecordPayment && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Paiement</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => setShowPaymentDialog(true)}
            >
              Enregistrer un paiement
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enregistrer un paiement</DialogTitle>
            <DialogDescription>
              Solde restant dû : {formatMoney(remainingBalance, currency)}. Paiement enregistré manuellement (pas
              d&apos;intégration Stripe/PayPal).
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRecordPayment} noValidate className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="amount" required>Montant ({currency})</Label>
                <Input
                  id="amount"
                  inputMode="decimal"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="method">Méthode</Label>
                <select
                  id="method"
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
              <Label htmlFor="reference">
                Référence <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="paymentNotes">
                Notes <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="paymentNotes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>

            {paymentError && (
              <p role="alert" className="text-sm text-destructive">
                {paymentError}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowPaymentDialog(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={isSubmittingPayment}>
                {isSubmittingPayment ? "Enregistrement..." : "Enregistrer"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
