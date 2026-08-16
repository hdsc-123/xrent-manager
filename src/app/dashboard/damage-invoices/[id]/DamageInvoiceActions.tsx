"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@/components/ui";

type DamageInvoiceStatus = "DRAFT" | "SENT" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";
type PaymentMethod = "CASH" | "CARD" | "BANK_TRANSFER" | "CHECK" | "OTHER";

const METHOD_OPTIONS: { value: PaymentMethod; label: string }[] = [
  { value: "CASH", label: "Espèces" },
  { value: "CARD", label: "Carte" },
  { value: "BANK_TRANSFER", label: "Virement" },
  { value: "CHECK", label: "Chèque" },
  { value: "OTHER", label: "Autre" },
];

function formatMoneyLocal(amountInSmallestUnit: number, currency: string): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(amountInSmallestUnit / 100);
}

interface DamageInvoiceActionsProps {
  id: string;
  status: DamageInvoiceStatus;
  remainingBalance: number;
  currency: string;
  /** damage_invoices.payment.create — autorise l'enregistrement d'un paiement. */
  canPay?: boolean;
  /** damage_invoices.cancel — autorise l'annulation (avec réversibilité financière). */
  canCancel?: boolean;
}

/**
 * Sprint 33 (DOMAINRULES.md section 48) — mêmes patrons que InvoiceActions.tsx (paiement
 * mixte) et POST /api/locations/[id]/admin-cancel (annulation avec motif obligatoire) mais
 * appliqués à une DamageInvoice, jamais mêlés à la facture locative du contrat.
 */
export function DamageInvoiceActions({
  id,
  status,
  remainingBalance,
  currency,
  canPay = false,
  canCancel = false,
}: DamageInvoiceActionsProps) {
  const router = useRouter();
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [mixed, setMixed] = useState(false);
  const [amount, setAmount] = useState((remainingBalance / 100).toFixed(2));
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [amount1, setAmount1] = useState("");
  const [method1, setMethod1] = useState<PaymentMethod>("CASH");
  const [amount2, setAmount2] = useState("");
  const [method2, setMethod2] = useState<PaymentMethod>("CARD");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [isSubmittingPayment, setIsSubmittingPayment] = useState(false);

  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  async function handleRecordPayment(event: FormEvent) {
    event.preventDefault();
    setPaymentError(null);

    const lines = mixed
      ? [
          { method: method1, amount: amount1 ? Math.round(Number(amount1.replace(",", ".")) * 100) : 0 },
          { method: method2, amount: amount2 ? Math.round(Number(amount2.replace(",", ".")) * 100) : 0 },
        ].filter((line) => line.amount > 0)
      : [{ method, amount: Math.round(Number(amount.replace(",", ".")) * 100) }];

    if (lines.length === 0 || lines.some((line) => !Number.isInteger(line.amount) || line.amount <= 0)) {
      setPaymentError(
        mixed ? "Le paiement mixte nécessite au moins un montant positif." : "Le montant doit être un nombre positif."
      );
      return;
    }

    const linesTotal = lines.reduce((sum, line) => sum + line.amount, 0);
    if (linesTotal > remainingBalance) {
      setPaymentError(
        `Le total du paiement (${formatMoneyLocal(linesTotal, currency)}) dépasse le solde restant dû ` +
          `(${formatMoneyLocal(remainingBalance, currency)}).`
      );
      return;
    }

    setIsSubmittingPayment(true);
    try {
      await apiPost(`/api/damage-invoices/${id}/payments`, {
        ...(mixed ? { lines } : { amount: lines[0].amount, method: lines[0].method }),
        reference: reference || undefined,
        notes: notes || undefined,
      });
      toast.success(lines.length > 1 ? "Paiements enregistrés." : "Paiement enregistré.");
      setShowPaymentDialog(false);
      router.refresh();
    } catch (err) {
      setPaymentError(err instanceof ApiError ? err.message : "Erreur lors de l'enregistrement du paiement.");
      router.refresh();
    } finally {
      setIsSubmittingPayment(false);
    }
  }

  async function handleCancel(event: FormEvent) {
    event.preventDefault();
    setCancelError(null);
    if (!cancelReason.trim()) {
      setCancelError("Un motif est obligatoire.");
      return;
    }
    setIsCancelling(true);
    try {
      await apiPost(`/api/damage-invoices/${id}/cancel`, { reason: cancelReason });
      toast.success("Facture de dégâts annulée.");
      setShowCancelDialog(false);
      router.refresh();
    } catch (err) {
      setCancelError(err instanceof ApiError ? err.message : "Erreur lors de l'annulation.");
    } finally {
      setIsCancelling(false);
    }
  }

  const canRecordPayment = remainingBalance > 0 && status !== "CANCELLED" && canPay;
  const canCancelInvoice = status !== "CANCELLED" && canCancel;

  if (!canRecordPayment && !canCancelInvoice) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {canRecordPayment && (
          <Button type="button" size="sm" variant="outline" onClick={() => setShowPaymentDialog(true)}>
            Encaisser un paiement
          </Button>
        )}
        {canCancelInvoice && (
          <Button type="button" size="sm" variant="destructive" onClick={() => setShowCancelDialog(true)}>
            Annuler la facture
          </Button>
        )}
      </CardContent>

      <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Encaisser un paiement</DialogTitle>
            <DialogDescription>
              Solde restant dû : {formatMoney(remainingBalance, currency)}. Paiement de dégâts, strictement séparé du
              solde locatif du contrat.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRecordPayment} noValidate className="flex flex-col gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={mixed} onCheckedChange={(checked) => setMixed(checked === true)} />
              Paiement mixte (deux modes de règlement)
            </label>

            {mixed ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="damageInvoiceMethod1">Mode 1</Label>
                  <select
                    id="damageInvoiceMethod1"
                    value={method1}
                    onChange={(e) => setMethod1(e.target.value as PaymentMethod)}
                    className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  >
                    {METHOD_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <Input
                    inputMode="decimal"
                    placeholder={`Montant 1 (${currency})`}
                    value={amount1}
                    onChange={(e) => setAmount1(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="damageInvoiceMethod2">Mode 2</Label>
                  <select
                    id="damageInvoiceMethod2"
                    value={method2}
                    onChange={(e) => setMethod2(e.target.value as PaymentMethod)}
                    className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  >
                    {METHOD_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <Input
                    inputMode="decimal"
                    placeholder={`Montant 2 (${currency})`}
                    value={amount2}
                    onChange={(e) => setAmount2(e.target.value)}
                  />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="damageInvoiceAmount" required>
                    Montant ({currency})
                  </Label>
                  <Input
                    id="damageInvoiceAmount"
                    inputMode="decimal"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="damageInvoicePaymentMethod">Méthode</Label>
                  <select
                    id="damageInvoicePaymentMethod"
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
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="damageInvoiceReference">
                Référence <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="damageInvoiceReference" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="damageInvoiceNotes">
                Notes <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input id="damageInvoiceNotes" value={notes} onChange={(e) => setNotes(e.target.value)} />
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

      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Annuler la facture de dégâts</DialogTitle>
            <DialogDescription>
              Chaque paiement déjà encaissé sera marqué remboursé et compensé en caisse — jamais supprimé ni réécrit.
              Action tracée dans le journal d&apos;audit.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCancel} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cancelReason" required>
                Motif
              </Label>
              <Input id="cancelReason" required value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
            </div>

            {cancelError && (
              <p role="alert" className="text-sm text-destructive">
                {cancelError}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCancelDialog(false)}>
                Fermer
              </Button>
              <Button type="submit" variant="destructive" disabled={isCancelling}>
                {isCancelling ? "Annulation..." : "Confirmer l'annulation"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
