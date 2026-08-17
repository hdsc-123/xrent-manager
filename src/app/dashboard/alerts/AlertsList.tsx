"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Icon,
  Input,
  Label,
} from "@/components/ui";

export interface AlertRow {
  id: string;
  type: string;
  priority: string;
  status: string;
  message: string;
  createdAt: string;
}

const TYPE_LABELS: Record<string, string> = {
  MAINTENANCE_DUE: "Maintenance à venir",
  RETURN_TODAY: "Retour aujourd'hui",
  RETURN_OVERDUE: "Retour en retard",
  INVOICE_OVERDUE: "Facture en retard",
  PAYMENT_DUE: "Paiement restant dû",
  CONTRACT_AT_RISK: "Contrat à risque",
  VEHICLE_UNAVAILABLE: "Véhicule indisponible",
  DOCUMENT_EXPIRED: "Document expiré",
  STOCK_INCONSISTENCY: "Incohérence de stock",
  INSURANCE_EXPIRING: "Assurance à renouveler",
  VIGNETTE_EXPIRING: "Vignette à renouveler",
  TECHNICAL_INSPECTION_DUE: "Contrôle technique",
  OIL_CHANGE_DUE: "Vidange à prévoir",
  VEHICLE_TRANSFER_INCOMING: "Véhicule entrant (transfert)",
  OTHER: "Autre",
};

const PRIORITY_LABELS: Record<string, string> = {
  URGENT: "Urgente",
  HIGH: "Haute",
  MEDIUM: "Moyenne",
  LOW: "Basse",
};

const PRIORITY_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  URGENT: "destructive",
  HIGH: "default",
  MEDIUM: "secondary",
  LOW: "outline",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  ACKNOWLEDGED: "Vue",
  RESOLVED: "Résolue",
};

export function AlertsList({
  alerts,
  canAcknowledge = false,
  canResolve = false,
}: {
  alerts: AlertRow[];
  /** alerts.acknowledge (voir src/lib/permissions.ts) — calculé côté serveur par la page
   * appelante. */
  canAcknowledge?: boolean;
  /** alerts.resolve */
  canResolve?: boolean;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [resolving, setResolving] = useState<AlertRow | null>(null);
  const [resolutionAction, setResolutionAction] = useState("");
  const [resolutionDate, setResolutionDate] = useState("");
  const [resolutionIntervenant, setResolutionIntervenant] = useState("");
  const [resolutionCost, setResolutionCost] = useState("");
  const [nextDueDate, setNextDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleAcknowledge(id: string) {
    setPendingId(id);
    try {
      await apiPatch(`/api/alerts/${id}/acknowledge`, {});
      toast.success("Alerte marquée comme vue.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la mise à jour.");
    } finally {
      setPendingId(null);
    }
  }

  // Sprint 22 : "Résoudre" (ou un clic sur l'alerte elle-même) ouvre désormais un formulaire de
  // suivi (action effectuée, date, intervenant, coût, prochaine échéance) au lieu de résoudre
  // immédiatement sans trace — nécessaire pour un suivi professionnel et traçable des
  // échéances/documents véhicule, et pour l'historique consultable sur la fiche véhicule.
  function openResolve(alert: AlertRow) {
    if (!canResolve || alert.status === "RESOLVED") return;
    setError(null);
    setResolutionAction("");
    setResolutionDate(new Date().toISOString().slice(0, 10));
    setResolutionIntervenant("");
    setResolutionCost("");
    setNextDueDate("");
    setResolving(alert);
  }

  async function handleResolve() {
    if (!resolving) return;
    setError(null);

    let resolutionCostCentimes: number | undefined;
    if (resolutionCost.trim()) {
      const amount = Number(resolutionCost.replace(",", "."));
      if (!Number.isFinite(amount) || amount < 0) {
        setError("Le coût doit être un nombre positif ou nul.");
        return;
      }
      resolutionCostCentimes = Math.round(amount * 100);
    }

    setPendingId(resolving.id);
    try {
      await apiPatch(`/api/alerts/${resolving.id}/resolve`, {
        resolutionAction: resolutionAction.trim() || undefined,
        resolutionDate: resolutionDate || undefined,
        resolutionIntervenant: resolutionIntervenant.trim() || undefined,
        resolutionCost: resolutionCostCentimes,
        nextDueDate: nextDueDate || undefined,
      });
      toast.success("Alerte résolue.");
      setResolving(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erreur lors de la résolution.");
    } finally {
      setPendingId(null);
    }
  }

  if (alerts.length === 0) {
    return (
      <div className="rounded-md border border-border p-8 text-center text-sm text-muted-foreground">
        Aucune alerte.
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        {alerts.map((alert) => {
          const clickable = canResolve && alert.status !== "RESOLVED";
          return (
            <div
              key={alert.id}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={clickable ? () => openResolve(alert) : undefined}
              onKeyDown={
                clickable
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") openResolve(alert);
                    }
                  : undefined
              }
              className={`flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between ${clickable ? "cursor-pointer hover:bg-muted/50" : ""}`}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={PRIORITY_VARIANTS[alert.priority] ?? "outline"}>
                    {PRIORITY_LABELS[alert.priority] ?? alert.priority}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{TYPE_LABELS[alert.type] ?? alert.type}</span>
                  <Badge variant="outline">{STATUS_LABELS[alert.status] ?? alert.status}</Badge>
                </div>
                <p className="text-sm">{alert.message}</p>
                <span className="text-xs text-muted-foreground">
                  {new Date(alert.createdAt).toLocaleString("fr-FR")}
                </span>
              </div>

              {alert.status !== "RESOLVED" && (canAcknowledge || canResolve) && (
                <div className="flex shrink-0 gap-2" onClick={(e) => e.stopPropagation()}>
                  {alert.status === "PENDING" && canAcknowledge && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pendingId === alert.id}
                      onClick={() => handleAcknowledge(alert.id)}
                    >
                      <Icon icon={Check} className="size-4" />
                      Marquer vue
                    </Button>
                  )}
                  {canResolve && (
                    <Button size="sm" disabled={pendingId === alert.id} onClick={() => openResolve(alert)}>
                      <Icon icon={CheckCheck} className="size-4" />
                      Résoudre
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Dialog open={Boolean(resolving)} onOpenChange={(open) => !open && setResolving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Résoudre l&apos;alerte</DialogTitle>
            <DialogDescription>{resolving?.message}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="resolutionAction">
                Action effectuée <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input
                id="resolutionAction"
                value={resolutionAction}
                onChange={(e) => setResolutionAction(e.target.value)}
                placeholder="Ex. renouvellement assurance effectué"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="resolutionDate">Date</Label>
                <Input
                  id="resolutionDate"
                  type="date"
                  value={resolutionDate}
                  onChange={(e) => setResolutionDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="resolutionIntervenant">
                  Intervenant <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input
                  id="resolutionIntervenant"
                  value={resolutionIntervenant}
                  onChange={(e) => setResolutionIntervenant(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="resolutionCost">
                  Coût (MAD) <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input
                  id="resolutionCost"
                  inputMode="decimal"
                  value={resolutionCost}
                  onChange={(e) => setResolutionCost(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nextDueDate">
                  Prochaine échéance <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input
                  id="nextDueDate"
                  type="date"
                  value={nextDueDate}
                  onChange={(e) => setNextDueDate(e.target.value)}
                />
              </div>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolving(null)}>
              Annuler
            </Button>
            <Button onClick={handleResolve} disabled={pendingId === resolving?.id}>
              {pendingId === resolving?.id ? "Résolution..." : "Résoudre"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
