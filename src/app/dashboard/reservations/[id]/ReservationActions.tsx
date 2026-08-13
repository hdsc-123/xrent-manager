"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";

type ReservationStatus = "PENDING" | "CONFIRMED" | "CONVERTED" | "CANCELLED";

interface ReservationActionsProps {
  id: string;
  status: ReservationStatus;
  notes: string | null;
  canEdit: boolean;
}

/**
 * Actions de statut explicites (Sprint 13D, refonte du flux réservation → contrat) :
 * "Confirmer" (PENDING → CONFIRMED) et "Annuler" (PENDING/CONFIRMED → CANCELLED) — la
 * conversion en contrat n'est plus une transition de statut proposée ici, elle a son propre
 * flux dédié (voir ConvertReservationLink dans page.tsx, qui mène au formulaire
 * /dashboard/reservations/[id]/convert), pour ne plus confondre les deux actions comme dans
 * l'ancien flux (un seul bouton « Changer le statut » générique).
 */
export function ReservationActions({ id, status, notes: initialNotes, canEdit }: ReservationActionsProps) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [isSavingNotes, setIsSavingNotes] = useState(false);

  async function handleTransition(next: "CONFIRMED" | "CANCELLED") {
    setIsChangingStatus(true);
    try {
      await apiPatch(`/api/reservations/${id}`, { status: next });
      toast.success(next === "CONFIRMED" ? "Réservation confirmée." : "Réservation annulée.");
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

  if (!canEdit) {
    return null;
  }

  const canCancel = status === "PENDING" || status === "CONFIRMED";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {(status === "PENDING" || canCancel) && (
          <div className="flex flex-wrap gap-2">
            {status === "PENDING" && (
              <Button type="button" size="sm" disabled={isChangingStatus} onClick={() => handleTransition("CONFIRMED")}>
                Confirmer la réservation
              </Button>
            )}
            {canCancel && (
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
          </div>
        )}

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
      </CardContent>
    </Card>
  );
}
