"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";

type ReservationStatus = "PENDING" | "CONFIRMED" | "CONVERTED" | "CANCELLED" | "NO_SHOW";

interface ReservationActionsProps {
  id: string;
  status: ReservationStatus;
  notes: string | null;
  canEdit: boolean;
  /** Sprint 24 — reservations.confirm, distincte de reservations.edit. */
  canConfirm: boolean;
  /** Sprint 24 — reservations.cancel, distincte de reservations.edit. */
  canCancel: boolean;
  /** Sprint 24 — reservations.no_show, distincte de reservations.edit. */
  canNoShow: boolean;
}

/**
 * Actions de statut explicites (Sprint 13D, refonte du flux réservation → contrat) :
 * "Confirmer" (PENDING → CONFIRMED) et "Annuler" (PENDING/CONFIRMED → CANCELLED) — la
 * conversion en contrat n'est plus une transition de statut proposée ici, elle a son propre
 * flux dédié (voir ConvertReservationLink dans page.tsx, qui mène au formulaire
 * /dashboard/reservations/[id]/convert), pour ne plus confondre les deux actions comme dans
 * l'ancien flux (un seul bouton « Changer le statut » générique).
 */
export function ReservationActions({
  id,
  status,
  notes: initialNotes,
  canEdit,
  canConfirm,
  canCancel,
  canNoShow,
}: ReservationActionsProps) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [isSavingNotes, setIsSavingNotes] = useState(false);

  async function handleTransition(next: "CONFIRMED" | "CANCELLED" | "NO_SHOW") {
    setIsChangingStatus(true);
    try {
      await apiPatch(`/api/reservations/${id}`, { status: next });
      const messages: Record<typeof next, string> = {
        CONFIRMED: "Réservation confirmée.",
        CANCELLED: "Réservation annulée.",
        NO_SHOW: "Réservation marquée No Show.",
      };
      toast.success(messages[next]);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors du changement de statut.");
    } finally {
      setIsChangingStatus(false);
    }
  }

  async function handleSaveNotes() {
    setIsSavingNotes(true);
    try {
      await apiPatch(`/api/reservations/${id}`, { notes });
      toast.success("Notes enregistrées.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de l'enregistrement.");
    } finally {
      setIsSavingNotes(false);
    }
  }

  if (!canEdit && !canConfirm && !canCancel && !canNoShow) {
    return null;
  }

  // Sprint 24 : chaque bouton croise désormais le statut (machine à états, inchangée) ET sa
  // propre permission (reservations.confirm/cancel/no_show) — plus reservations.edit.
  const showConfirm = status === "PENDING" && canConfirm;
  const showCancel = (status === "PENDING" || status === "CONFIRMED") && canCancel;
  // Sprint 23 (DOMAINRULES.md section 39) — même statuts que canTransition(status, "NO_SHOW").
  const showNoShow = (status === "PENDING" || status === "CONFIRMED") && canNoShow;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {(showConfirm || showCancel || showNoShow) && (
          <div className="flex flex-wrap gap-2">
            {showConfirm && (
              <Button type="button" size="sm" disabled={isChangingStatus} onClick={() => handleTransition("CONFIRMED")}>
                Confirmer la réservation
              </Button>
            )}
            {showCancel && (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={isChangingStatus}
                onClick={() => handleTransition("CANCELLED")}
              >
                Annuler
              </Button>
            )}
            {/* Sprint 23 — client jamais présenté, distinct d'Annuler. */}
            {showNoShow && (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={isChangingStatus}
                onClick={() => handleTransition("NO_SHOW")}
              >
                No Show
              </Button>
            )}
          </div>
        )}

        {canEdit && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Remarques</span>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-fit"
              disabled={isSavingNotes}
              onClick={handleSaveNotes}
            >
              {isSavingNotes ? "Enregistrement..." : "Enregistrer"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
