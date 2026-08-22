"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
import { formatMoney, calculateDaysCount } from "@/lib/format";
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

/**
 * Sprint 13E tâche 2 (DOMAINRULES.md section 52) — « Prolonger la location » depuis la fiche
 * d'un contrat ACTIVE. Réutilise entièrement PATCH /api/locations/[id] (aucune nouvelle route) :
 * `extendReturnDate: true` déclenche côté serveur (updateLocation, src/lib/locations.ts) la
 * validation stricte (nouvelle date de retour strictement postérieure), le recalcul du prix, la
 * resynchronisation de la facture DRAFT et le parcours maintenance existant (Sprint 34 étape 3,
 * DOMAINRULES.md section 50) — ce composant ne fait que construire les requêtes et afficher les
 * réponses/erreurs, jamais de logique métier dupliquée ici (même principe que
 * ReturnLocationPanel.tsx). Les montants prévisualisés ci-dessous sont purement indicatifs
 * (même formule que calculateTotalPrice, src/lib/locations.ts, via calculateDaysCount,
 * src/lib/format.ts) — la confirmation utilise toujours le total renvoyé par le serveur.
 */

interface ConflictingMaintenance {
  id: string;
  scheduledDate: string;
  scheduledEndDate: string | null;
  status: string;
  type: string;
}

const MAINTENANCE_TYPE_LABELS: Record<string, string> = {
  OIL_CHANGE: "Vidange",
  TIRE_CHANGE: "Changement de pneus",
  INSPECTION: "Contrôle technique",
  REPAIR: "Réparation",
  OTHER: "Autre",
};

/** Même conversion que ReturnLocationPanel.tsx (toDatetimeLocalValue) — dupliquée localement,
 * ce composant ne dépend d'aucun autre composant de page. */
function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function safeErrorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function isConflictBody(body: unknown): body is { conflictingMaintenances: ConflictingMaintenance[] } {
  return (
    typeof body === "object" &&
    body !== null &&
    "conflictingMaintenances" in body &&
    Array.isArray((body as { conflictingMaintenances: unknown }).conflictingMaintenances)
  );
}

interface ExtendLocationDialogProps {
  id: string;
  startDate: string;
  endDate: string;
  pricePerDay: number;
  currency: string;
  totalPrice: number;
  invoice: { totalAmount: number; amountPaid: number } | null;
  /** isAdmin || locations.maintenance_conflict.override — seule cette confirmation peut
   * pousser une prolongation au-delà d'un conflit de maintenance réel (voir DOMAINRULES.md
   * section 50/52) ; sans elle, l'alerte reste affichée mais non contournable depuis l'écran. */
  canConfirmMaintenanceConflict: boolean;
}

type Step = "form" | "conflict";

export function ExtendLocationDialog({
  id,
  startDate,
  endDate,
  pricePerDay,
  currency,
  totalPrice,
  invoice,
  canConfirmMaintenanceConflict,
}: ExtendLocationDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [newEndDate, setNewEndDate] = useState(() => toDatetimeLocalValue(endDate));
  const [step, setStep] = useState<Step>("form");
  const [conflicts, setConflicts] = useState<ConflictingMaintenance[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sprint 13E tâche 2 : la valeur par défaut du champ (date de retour actuelle) n'est jamais
  // valide à soumettre telle quelle (égale, jamais strictement postérieure) — sans ce indicateur,
  // l'erreur de validation s'afficherait dès l'ouverture du formulaire, avant toute interaction
  // de l'utilisateur (anti-pattern). Le bouton Confirmer reste désactivé dans tous les cas.
  const [hasEditedDate, setHasEditedDate] = useState(false);

  const currentEndDate = new Date(endDate);
  const parsedNewEndDate = new Date(newEndDate);
  const isValidDate = newEndDate.length > 0 && !Number.isNaN(parsedNewEndDate.getTime());
  const isStrictlyLater = isValidDate && parsedNewEndDate.getTime() > currentEndDate.getTime();

  const previewTotal = isStrictlyLater
    ? pricePerDay * calculateDaysCount(new Date(startDate), parsedNewEndDate)
    : null;
  const previewExtra = previewTotal !== null ? previewTotal - totalPrice : null;
  const previewBalance = previewTotal !== null && invoice ? previewTotal - invoice.amountPaid : null;

  function openDialog() {
    // Sprint 13E tâche 2 : repart toujours des valeurs actuelles du contrat (props les plus
    // récentes, rafraîchies par router.refresh() après toute modification) — jamais un état
    // resté périmé d'une ouverture précédente du formulaire.
    setNewEndDate(toDatetimeLocalValue(endDate));
    setStep("form");
    setConflicts([]);
    setError(null);
    setHasEditedDate(false);
    setOpen(true);
  }

  function closeDialog() {
    if (isSubmitting) return;
    setOpen(false);
    setStep("form");
    setConflicts([]);
    setError(null);
  }

  async function submitExtension(confirmMaintenanceConflict: boolean) {
    // Protection double-clic/double-soumission : un second clic pendant une requête en cours
    // est un no-op, jamais une deuxième requête.
    if (isSubmitting) {
      return;
    }
    if (!isStrictlyLater) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const isoEndDate = parsedNewEndDate.toISOString();
      const { location } = await apiPatch<{ location: { endDate: string; totalPrice: number } }>(
        `/api/locations/${id}`,
        { extendReturnDate: true, endDate: isoEndDate, confirmMaintenanceConflict }
      );
      toast.success(
        `Location prolongée jusqu'au ${new Date(location.endDate).toLocaleString("fr-FR")} — ` +
          `nouveau total ${formatMoney(location.totalPrice, currency)}.`
      );
      setOpen(false);
      setStep("form");
      setConflicts([]);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && isConflictBody(err.body)) {
        setConflicts(err.body.conflictingMaintenances);
        setStep("conflict");
      } else {
        setError(safeErrorMessage(err, "Erreur lors de la prolongation. Vérifiez votre connexion et réessayez."));
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Button type="button" size="sm" className="w-fit" onClick={openDialog}>
        Prolonger la location
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? openDialog() : closeDialog())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Prolonger la location</DialogTitle>
            <DialogDescription>Retour actuel : {currentEndDate.toLocaleString("fr-FR")}</DialogDescription>
          </DialogHeader>

          {step === "form" && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="newEndDate" required>
                  Nouvelle date et heure de retour
                </Label>
                <Input
                  id="newEndDate"
                  type="datetime-local"
                  value={newEndDate}
                  onChange={(e) => {
                    setNewEndDate(e.target.value);
                    setHasEditedDate(true);
                    setError(null);
                  }}
                />
                {hasEditedDate && !isValidDate && <p className="text-sm text-destructive">Date invalide.</p>}
                {hasEditedDate && isValidDate && !isStrictlyLater && (
                  <p className="text-sm text-destructive">
                    La nouvelle date de retour doit être strictement postérieure au retour actuel.
                  </p>
                )}
              </div>

              {previewTotal !== null && previewExtra !== null && (
                <div className="flex flex-col gap-1.5 rounded-md border border-border p-3 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Montant supplémentaire</span>
                    <span className="font-medium">{formatMoney(previewExtra, currency)}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Nouveau total</span>
                    <span className="font-medium">{formatMoney(previewTotal, currency)}</span>
                  </div>
                  {previewBalance !== null && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Solde restant estimé</span>
                      <span className="font-medium">{formatMoney(previewBalance, currency)}</span>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Montants indicatifs — recalculés et validés par le serveur à la confirmation.
                  </p>
                </div>
              )}

              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          )}

          {step === "conflict" && (
            <div className="flex flex-col gap-3">
              <p role="alert" className="text-sm font-medium text-destructive">
                Cette prolongation chevauche une maintenance planifiée pour ce véhicule. La
                maintenance ne sera jamais déplacée automatiquement.
              </p>
              <ul className="flex flex-col gap-1 text-sm">
                {conflicts.map((maintenance) => (
                  <li key={maintenance.id}>
                    {MAINTENANCE_TYPE_LABELS[maintenance.type] ?? maintenance.type} —{" "}
                    {new Date(maintenance.scheduledDate).toLocaleString("fr-FR")}
                    {maintenance.scheduledEndDate
                      ? ` → ${new Date(maintenance.scheduledEndDate).toLocaleString("fr-FR")}`
                      : ""}
                  </li>
                ))}
              </ul>
              {canConfirmMaintenanceConflict ? (
                <p className="text-sm text-muted-foreground">
                  Vous pouvez confirmer explicitement pour prolonger malgré ce conflit.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Vous n&apos;avez pas la permission de confirmer une prolongation malgré un conflit de
                  maintenance — contactez un administrateur, ou choisissez d&apos;autres dates.
                </p>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog} disabled={isSubmitting}>
              Annuler
            </Button>
            {step === "form" && (
              <Button type="button" disabled={!isStrictlyLater || isSubmitting} onClick={() => submitExtension(false)}>
                {isSubmitting ? "Prolongation..." : "Confirmer"}
              </Button>
            )}
            {step === "conflict" && canConfirmMaintenanceConflict && (
              <Button
                type="button"
                variant="destructive"
                disabled={isSubmitting}
                onClick={() => submitExtension(true)}
              >
                {isSubmitting ? "Confirmation..." : "Confirmer malgré le conflit"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
