"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
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
 * Sprint technique 1 (DOMAINRULES.md section 60, HANDOFF.md point 43) : « Créer une
 * prolongation » — nouveau contrat indépendant, lié au contrat parent et à la racine de la
 * chaîne (POST /api/locations/[id]/extend, src/lib/location-chains.ts). Distinct
 * d'ExtendLocationDialog.tsx (extendReturnDate, mécanisme actuel non modifié/non retiré à ce
 * stade — les deux coexistent tant que le nouveau mécanisme n'a pas remplacé l'ancien dans le
 * parcours utilisateur, DOMAINRULES.md section 60 règle 11).
 *
 * Formulaire volontairement minimal pour ce sprint (nouvelle date de retour uniquement) —
 * changement de véhicule/agence/tarif restent possibles via l'API (createLocationExtension
 * accepte déjà ces champs) mais ne sont pas encore exposés dans cette interface, explicitement
 * hors périmètre de ce sprint (affichage de la chaîne, solde consolidé, PDF dédié, retours
 * spécifiques : sprints suivants).
 */

function safeErrorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface CreateExtensionButtonProps {
  parentLocationId: string;
  parentEndDate: string;
}

export function CreateExtensionButton({ parentLocationId, parentEndDate }: CreateExtensionButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [endDate, setEndDate] = useState(() => toDatetimeLocalValue(parentEndDate));
  const [hasEditedDate, setHasEditedDate] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parentEnd = new Date(parentEndDate);
  const parsedEndDate = new Date(endDate);
  const isValidDate = endDate.length > 0 && !Number.isNaN(parsedEndDate.getTime());
  const isStrictlyLater = isValidDate && parsedEndDate.getTime() > parentEnd.getTime();

  function openDialog() {
    setEndDate(toDatetimeLocalValue(parentEndDate));
    setHasEditedDate(false);
    setError(null);
    setOpen(true);
  }

  function closeDialog() {
    if (isSubmitting) return;
    setOpen(false);
    setError(null);
  }

  async function submit() {
    // Protection double-clic/double-soumission — même patron que les autres actions de contrat
    // (LocationActions.tsx, ExtendLocationDialog.tsx).
    if (isSubmitting || !isStrictlyLater) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const { location } = await apiPost<{ location: { contractNumber: string | null } }>(
        `/api/locations/${parentLocationId}/extend`,
        { endDate: parsedEndDate.toISOString() }
      );
      toast.success(
        location.contractNumber
          ? `Prolongation créée — nouveau contrat ${location.contractNumber}.`
          : "Prolongation créée."
      );
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(safeErrorMessage(err, "Erreur lors de la création de la prolongation. Vérifiez votre connexion et réessayez."));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="outline" className="w-fit" onClick={openDialog}>
        Créer une prolongation
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? openDialog() : closeDialog())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Créer une prolongation</DialogTitle>
            <DialogDescription>
              Crée un nouveau contrat indépendant, lié à celui-ci, à partir du retour actuel (
              {parentEnd.toLocaleString("fr-FR")}). Le contrat actuel n&apos;est jamais modifié.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="extensionEndDate" required>
                Nouvelle date et heure de retour
              </Label>
              <Input
                id="extensionEndDate"
                type="datetime-local"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setHasEditedDate(true);
                  setError(null);
                }}
              />
              {hasEditedDate && !isValidDate && <p className="text-sm text-destructive">Date invalide.</p>}
              {hasEditedDate && isValidDate && !isStrictlyLater && (
                <p className="text-sm text-destructive">
                  La nouvelle date de retour doit être strictement postérieure au retour actuel du contrat.
                </p>
              )}
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog} disabled={isSubmitting}>
              Annuler
            </Button>
            <Button type="button" disabled={!isStrictlyLater || isSubmitting} onClick={submit}>
              {isSubmitting ? "Création..." : "Créer la prolongation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
