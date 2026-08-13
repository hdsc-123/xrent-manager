import { NextResponse } from "next/server";
import type { AlertPriority, AlertStatus, AlertType } from "@prisma/client";
import { getSessionUser, canAccessAgency, getAccessibleAgencyIds } from "@/lib/authz";
import { getAlerts, type AlertFilters } from "@/lib/alerts";

const ALERT_TYPES: AlertType[] = [
  "MAINTENANCE_DUE",
  "RETURN_TODAY",
  "INVOICE_OVERDUE",
  "CONTRACT_AT_RISK",
  "PAYMENT_DUE",
  "VEHICLE_UNAVAILABLE",
  "RETURN_OVERDUE",
  "DOCUMENT_EXPIRED",
  "STOCK_INCONSISTENCY",
  "OTHER",
];
const ALERT_PRIORITIES: AlertPriority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const ALERT_STATUSES: AlertStatus[] = ["PENDING", "ACKNOWLEDGED", "RESOLVED"];

export async function GET(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const agencyIdParam = searchParams.get("agencyId") ?? undefined;
  const typeParam = searchParams.get("type") ?? undefined;
  const priorityParam = searchParams.get("priority") ?? undefined;
  const statusParam = searchParams.get("status") ?? undefined;

  if (typeParam && !ALERT_TYPES.includes(typeParam as AlertType)) {
    return NextResponse.json({ error: "type invalide." }, { status: 400 });
  }
  if (priorityParam && !ALERT_PRIORITIES.includes(priorityParam as AlertPriority)) {
    return NextResponse.json({ error: "priority invalide." }, { status: 400 });
  }
  if (statusParam && !ALERT_STATUSES.includes(statusParam as AlertStatus)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }
  if (agencyIdParam && !(await canAccessAgency(user, agencyIdParam))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  const filters: AlertFilters = {
    agencyId: agencyIdParam,
    type: typeParam as AlertType | undefined,
    priority: priorityParam as AlertPriority | undefined,
    status: statusParam as AlertStatus | undefined,
  };

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const alerts = await getAlerts(user.tenantId, filters);

  // Un MEMBER ne voit que les alertes diffusées à tout le tenant (agencyId null) ou
  // rattachées à une agence à laquelle il est rattaché — même principe que vehicles/locations.
  const visibleAlerts =
    accessibleAgencyIds === null || agencyIdParam
      ? alerts
      : alerts.filter((alert) => alert.agencyId === null || accessibleAgencyIds.includes(alert.agencyId));

  return NextResponse.json({ alerts: visibleAlerts });
}
