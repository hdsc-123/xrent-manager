"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";

type ReservationStatus = "PENDING" | "CONFIRMED" | "CONVERTED" | "CANCELLED";

/** Miroir client de la machine à états de src/lib/reservations.ts (ALLOWED_TRANSITIONS).
 * CONVERTED n'est jamais proposé ici — uniquement via le flux dédié (ConvertReservationCard). */
const ALLOWED_TRANSITIONS: Record<ReservationStatus, Exclude<ReservationStatus, "CONVERTED">[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["CANCELLED"],
  CONVERTED: [],
  CANCELLED: [],
};

const STATUS_LABELS: Record<ReservationStatus, string> = {
  PENDING: "En attente",
  CONFIRMED: "Confirmée",
  CONVERTED: "Convertie",
  CANCELLED: "Annulée",
};

interface ReservationActionsProps {
  id: string;
  status: ReservationStatus;
  notes: string | null;
  canEdit: boolean;
}

export function ReservationActions({ id, status, notes: initialNotes, canEdit }: ReservationActionsProps) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [isSavingNotes, setIsSavingNotes] = useState(false);

  async function handleTransition(next: ReservationStatus) {
    setIsChangingStatus(true);
    try {
      await apiPatch(`/api/reservations/${id}`, { status: next });
      toast.success(`Statut mis à jour : ${STATUS_LABELS[next]}.`);
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

  const nextStatuses = ALLOWED_TRANSITIONS[status];

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
              Statut terminal ({STATUS_LABELS[status]}) — aucune transition possible.
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
