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
  /** invoices.edit (voir src/lib/permissions.ts) — autorise les transitions de statut non
   * destructrices (ex. DRAFT → SENT), calculé côté serveur par la page appelante. */
  canEdit?: boolean;
  /** invoices.delete — autorise la transition vers CANCELLED. */
  canDelete?: boolean;
  /** payments.create — autorise l'enregistrement d'un paiement depuis cette facture. */
  canCreatePayment?: boolean;
  /** Sprint 26E : invoices.version — autorise la création d'une nouvelle version. Calculé côté
   * serveur ; le bouton n'est de toute façon visible que si status === "SENT" (l'éligibilité
   * réelle — pas de Payment — est revalidée côté serveur par versionInvoice). */
  canVersion?: boolean;
}

function formatMoneyLocal(amountInSmallestUnit: number, currency: string): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(amountInSmallestUnit / 100);
}

export function InvoiceActions({
  id,
  status,
  remainingBalance,
  currency,
  canEdit = false,
  canDelete = false,
  canCreatePayment = false,
  canVersion = false,
}: InvoiceActionsProps) {
  const router = useRouter();
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [showVersionDialog, setShowVersionDialog] = useState(false);
  const [versionReason, setVersionReason] = useState("");
  const [versionError, setVersionError] = useState<string | null>(null);
  const [isVersioning, setIsVersioning] = useState(false);
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

    // Paiement mixte (Sprint 14B) : plusieurs lignes méthode+montant dans la même opération.
    const lines = mixed
      ? [
          { method: method1, amount: amount1 ? Math.round(Number(amount1.replace(",", ".")) * 100) : 0 },
          { method: method2, amount: amount2 ? Math.round(Number(amount2.replace(",", ".")) * 100) : 0 },
        ].filter((line) => line.amount > 0)
      : [{ method, amount: Math.round(Number(amount.replace(",", ".")) * 100) }];

    if (lines.length === 0 || lines.some((line) => !Number.isInteger(line.amount) || line.amount <= 0)) {
      setPaymentError(
        mixed
          ? "Le paiement mixte nécessite au moins un montant positif."
          : "Le montant doit être un nombre positif."
      );
      return;
    }

    // Pré-vérification rapide côté client (feedback immédiat) contre le solde connu au
    // chargement de la page — non autoritaire : le serveur revalide contre le solde réel juste
    // avant d'écrire quoi que ce soit (createMixedPayments/createPayment), donc un solde
    // devenu obsolète pendant que ce dialogue était ouvert est rattrapé sans écriture partielle.
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
      // Une seule requête, même en paiement mixte (Sprint 17) : le solde restant est revalidé
      // côté serveur juste avant l'écriture (createMixedPayments, src/lib/payments.ts), pas
      // contre `remainingBalance` figé au chargement de la page ci-dessus — évite qu'une ligne
      // soit écrite avant qu'une seconde échoue si le solde réel a changé entretemps.
      await apiPost("/api/payments", {
        invoiceId: id,
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

  async function handleCreateVersion(event: React.FormEvent) {
    event.preventDefault();
    setVersionError(null);

    if (!versionReason.trim()) {
      setVersionError("Un motif est obligatoire.");
      return;
    }

    setIsVersioning(true);
    try {
      const response = await apiPost<{ invoice: { id: string } }>(`/api/invoices/${id}/versions`, {
        reason: versionReason,
      });
      toast.success("Nouvelle version créée.");
      setShowVersionDialog(false);
      router.push(`/dashboard/invoices/${response.invoice.id}`);
    } catch (err) {
      setVersionError(err instanceof ApiError ? err.message : "Erreur lors du versionnement.");
    } finally {
      setIsVersioning(false);
    }
  }

  const nextStatuses = ALLOWED_TRANSITIONS[status];
  // Sprint 26E : visible seulement pour une facture SENT — l'éligibilité réelle (aucun Payment)
  // est revalidée côté serveur (InvoiceNotVersionableError sinon).
  const canCreateVersion = status === "SENT" && canVersion;
  // Filtrage par permission : CANCELLED s'apparente à une suppression (invoices.delete), les
  // autres transitions (ex. DRAFT → SENT) à une modification (invoices.edit).
  const visibleNextStatuses = nextStatuses.filter((next) => (next === "CANCELLED" ? canDelete : canEdit));
  // Finding F : un paiement ne peut être enregistré que sur une facture finalisée (SENT ou
  // au-delà) — DRAFT exclu, sinon le clic aboutirait systématiquement à un 409
  // (InvoiceNotFinalizedError, src/lib/payments.ts).
  const canRecordPayment =
    remainingBalance > 0 && status !== "CANCELLED" && status !== "DRAFT" && canCreatePayment;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {(nextStatuses.length === 0 || visibleNextStatuses.length > 0) && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Changer le statut</span>
            {nextStatuses.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Statut terminal ({STATUS_LABELS[status]}) — aucune transition manuelle possible.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {visibleNextStatuses.map((next) => (
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
        )}

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

        {canCreateVersion && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Versionnement</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => setShowVersionDialog(true)}
            >
              Créer une nouvelle version
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
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={mixed} onCheckedChange={(checked) => setMixed(checked === true)} />
              Paiement mixte (deux modes de règlement)
            </label>

            {mixed ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="method1">Mode 1</Label>
                  <select
                    id="method1"
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
                  <Label htmlFor="method2">Mode 2</Label>
                  <select
                    id="method2"
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
            )}

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

      <Dialog open={showVersionDialog} onOpenChange={setShowVersionDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Créer une nouvelle version</DialogTitle>
            <DialogDescription>
              Versionnement documentaire : cette facture ({STATUS_LABELS[status]}) sera annulée et remplacée par une
              nouvelle facture brouillon, reprenant le même contrat, client, agence et devise. Aucun montant n&apos;est
              modifié par cette action elle-même.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateVersion} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="versionReason" required>
                Motif
              </Label>
              <Input
                id="versionReason"
                required
                value={versionReason}
                onChange={(e) => setVersionReason(e.target.value)}
              />
            </div>

            {versionError && (
              <p role="alert" className="text-sm text-destructive">
                {versionError}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowVersionDialog(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={isVersioning}>
                {isVersioning ? "Création..." : "Créer la nouvelle version"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
