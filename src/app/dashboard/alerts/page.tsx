import Link from "next/link";
import type { AlertPriority, AlertStatus, AlertType } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getAlerts } from "@/lib/alerts";
import { Button, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { AlertsList, type AlertRow } from "./AlertsList";

const TYPE_OPTIONS: { value: AlertType; label: string }[] = [
  { value: "MAINTENANCE_DUE", label: "Maintenance à venir" },
  { value: "RETURN_TODAY", label: "Retour aujourd'hui" },
  { value: "RETURN_OVERDUE", label: "Retour en retard" },
  { value: "INVOICE_OVERDUE", label: "Facture en retard" },
  { value: "PAYMENT_DUE", label: "Paiement restant dû" },
  { value: "CONTRACT_AT_RISK", label: "Contrat à risque" },
  { value: "VEHICLE_UNAVAILABLE", label: "Véhicule indisponible" },
  { value: "DOCUMENT_EXPIRED", label: "Document expiré" },
  { value: "STOCK_INCONSISTENCY", label: "Incohérence de stock" },
  { value: "INSURANCE_EXPIRING", label: "Assurance à renouveler" },
  { value: "VIGNETTE_EXPIRING", label: "Vignette à renouveler" },
  { value: "TECHNICAL_INSPECTION_DUE", label: "Contrôle technique" },
  { value: "OIL_CHANGE_DUE", label: "Vidange à prévoir" },
  { value: "OTHER", label: "Autre" },
];

const PRIORITY_OPTIONS: { value: AlertPriority; label: string }[] = [
  { value: "URGENT", label: "Urgente" },
  { value: "HIGH", label: "Haute" },
  { value: "MEDIUM", label: "Moyenne" },
  { value: "LOW", label: "Basse" },
];

const STATUS_OPTIONS: { value: AlertStatus; label: string }[] = [
  { value: "PENDING", label: "En attente" },
  { value: "ACKNOWLEDGED", label: "Vue" },
  { value: "RESOLVED", label: "Résolue" },
];

interface PageProps {
  searchParams: Promise<{ type?: string; priority?: string; status?: string }>;
}

export default async function AlertsPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "alerts.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Alertes</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter les alertes.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const params = await searchParams;
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const canAcknowledge = await can(user, "alerts.acknowledge");
  const canResolve = await can(user, "alerts.resolve");

  const alerts = await getAlerts(user.tenantId, {
    type: params.type as AlertType | undefined,
    priority: params.priority as AlertPriority | undefined,
    status: params.status as AlertStatus | undefined,
  });

  const visibleAlerts =
    accessibleAgencyIds === null
      ? alerts
      : alerts.filter((alert) => alert.agencyId === null || accessibleAgencyIds.includes(alert.agencyId));

  const rows: AlertRow[] = visibleAlerts.map((alert) => ({
    id: alert.id,
    type: alert.type,
    priority: alert.priority,
    status: alert.status,
    message: alert.message,
    createdAt: alert.createdAt.toISOString(),
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Alertes</h1>
        <p className="text-sm text-muted-foreground">Triées par priorité puis par date.</p>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3" method="get">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="type" className="text-xs font-medium text-muted-foreground">
            Type
          </label>
          <select
            id="type"
            name="type"
            defaultValue={params.type ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Tous</option>
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="priority" className="text-xs font-medium text-muted-foreground">
            Priorité
          </label>
          <select
            id="priority"
            name="priority"
            defaultValue={params.priority ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Toutes</option>
            {PRIORITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="status" className="text-xs font-medium text-muted-foreground">
            Statut
          </label>
          <select
            id="status"
            name="status"
            defaultValue={params.status ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Tous</option>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {(params.type || params.priority || params.status) && (
          <Button render={<Link href="/dashboard/alerts" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <AlertsList alerts={rows} canAcknowledge={canAcknowledge} canResolve={canResolve} />
    </div>
  );
}
