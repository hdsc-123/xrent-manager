"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui";

type LocationStatus = "PENDING" | "CONFIRMED" | "ACTIVE" | "COMPLETED" | "CANCELLED";

/** Miroir client de la machine à états de src/lib/locations.ts (ALLOWED_TRANSITIONS). */
const ALLOWED_TRANSITIONS: Record<LocationStatus, LocationStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

const STATUS_LABELS: Record<LocationStatus, string> = {
  PENDING: "En attente",
  CONFIRMED: "Confirmée",
  ACTIVE: "En cours",
  COMPLETED: "Terminée",
  CANCELLED: "Annulée",
};

interface LocationActionsProps {
  id: string;
  status: LocationStatus;
  notes: string | null;
  endOdometer: number | null;
  /** locations.edit (voir src/lib/permissions.ts) — masque toute la carte Actions
   * (transitions de statut + notes/kilométrage) si absent, calculé côté serveur par la
   * page appelante. Même pattern que ReservationActions. */
  canEdit: boolean;
}

export function LocationActions({
  id,
  status,
  notes: initialNotes,
  endOdometer: initialEndOdometer,
  canEdit,
}: LocationActionsProps) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [endOdometer, setEndOdometer] = useState(
    initialEndOdometer !== null ? String(initialEndOdometer) : ""
  );
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [isSavingNotes, setIsSavingNotes] = useState(false);

  async function handleTransition(next: LocationStatus) {
    setIsChangingStatus(true);
    try {
      await apiPatch(`/api/locations/${id}`, { status: next });
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
      await apiPatch(`/api/locations/${id}`, {
        notes,
        endOdometer: endOdometer ? Number(endOdometer) : null,
      });
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
          <span className="text-xs font-medium text-muted-foreground">Kilométrage retour</span>
          <Input
            type="number"
            value={endOdometer}
            onChange={(e) => setEndOdometer(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Notes</span>
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
