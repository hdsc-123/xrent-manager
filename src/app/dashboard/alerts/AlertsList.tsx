"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
import { Badge, Button } from "@/components/ui";

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

  async function handleAction(id: string, action: "acknowledge" | "resolve") {
    setPendingId(id);
    try {
      await apiPatch(`/api/alerts/${id}/${action}`, {});
      toast.success(action === "acknowledge" ? "Alerte marquée comme vue." : "Alerte résolue.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la mise à jour.");
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
    <div className="flex flex-col gap-2">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
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
            <div className="flex shrink-0 gap-2">
              {alert.status === "PENDING" && canAcknowledge && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pendingId === alert.id}
                  onClick={() => handleAction(alert.id, "acknowledge")}
                >
                  <Check className="size-4" />
                  Marquer vue
                </Button>
              )}
              {canResolve && (
                <Button
                  size="sm"
                  disabled={pendingId === alert.id}
                  onClick={() => handleAction(alert.id, "resolve")}
                >
                  <CheckCheck className="size-4" />
                  Résoudre
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
