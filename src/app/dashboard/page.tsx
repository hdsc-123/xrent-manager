import Link from "next/link";
import { Bell, Building2, CalendarClock, FileWarning, Store, Users, Wrench } from "lucide-react";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { getTenantById } from "@/lib/db";
import { prisma } from "@/lib/prisma";
import { getAlerts } from "@/lib/alerts";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui";

const PRIORITY_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  URGENT: "destructive",
  HIGH: "default",
  MEDIUM: "secondary",
  LOW: "outline",
};

export default async function DashboardPage() {
  const user = await getSessionUser();

  if (!user) {
    return null;
  }

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const agencyScope = accessibleAgencyIds ? { agencyId: { in: accessibleAgencyIds } } : {};
  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const [
    tenant,
    agencyCount,
    userCount,
    returnsToday,
    dueMaintenances,
    overdueInvoicesCount,
    recentAlerts,
  ] = await Promise.all([
    getTenantById(user.tenantId),
    prisma.agency.count({ where: { tenantId: user.tenantId } }),
    prisma.user.count({ where: { tenantId: user.tenantId } }),
    prisma.location.count({
      where: { tenantId: user.tenantId, ...agencyScope, status: "ACTIVE", endDate: { lte: endOfToday } },
    }),
    prisma.maintenance.count({
      where: { tenantId: user.tenantId, ...agencyScope, status: "SCHEDULED", scheduledDate: { lte: endOfToday } },
    }),
    prisma.invoice.count({
      where: {
        tenantId: user.tenantId,
        ...agencyScope,
        status: { in: ["SENT", "PARTIALLY_PAID"] },
        dueDate: { lt: now },
      },
    }),
    getAlerts(user.tenantId, {}),
  ]);

  const visibleRecentAlerts = (
    accessibleAgencyIds === null
      ? recentAlerts
      : recentAlerts.filter((alert) => alert.agencyId === null || accessibleAgencyIds.includes(alert.agencyId))
  ).slice(0, 5);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold">
          Bonjour {user.name || user.email}
        </h1>
        <p className="text-sm text-muted-foreground">
          {tenant?.name} · rôle {user.role === "ADMIN" ? "Administrateur" : "Membre"}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <Store className="size-4" /> Agences
            </CardDescription>
            <CardTitle className="text-3xl">{agencyCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <Users className="size-4" /> Utilisateurs
            </CardDescription>
            <CardTitle className="text-3xl">{userCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <Building2 className="size-4" /> Tenant
            </CardDescription>
            <CardTitle className="truncate text-3xl">{tenant?.name ?? "—"}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>À faire aujourd&apos;hui</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Link
            href="/dashboard/locations?status=ACTIVE"
            className="flex items-center justify-between rounded-md border border-border p-3 hover:bg-accent"
          >
            <span className="flex items-center gap-2 text-sm">
              <CalendarClock className="size-4 text-muted-foreground" /> Retours
            </span>
            <span className="text-lg font-semibold">{returnsToday}</span>
          </Link>
          <Link
            href="/dashboard/maintenances?status=SCHEDULED"
            className="flex items-center justify-between rounded-md border border-border p-3 hover:bg-accent"
          >
            <span className="flex items-center gap-2 text-sm">
              <Wrench className="size-4 text-muted-foreground" /> Maintenances
            </span>
            <span className="text-lg font-semibold">{dueMaintenances}</span>
          </Link>
          <Link
            href="/dashboard/invoices"
            className="flex items-center justify-between rounded-md border border-border p-3 hover:bg-accent"
          >
            <span className="flex items-center gap-2 text-sm">
              <FileWarning className="size-4 text-muted-foreground" /> Factures en retard
            </span>
            <span className="text-lg font-semibold">{overdueInvoicesCount}</span>
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="size-4" /> Alertes récentes
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {visibleRecentAlerts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune alerte.</p>
          ) : (
            visibleRecentAlerts.map((alert) => (
              <div key={alert.id} className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant={PRIORITY_VARIANTS[alert.priority] ?? "outline"}>{alert.priority}</Badge>
                  <span className="truncate text-sm">{alert.message}</span>
                </div>
                <Badge variant="outline" className="shrink-0">
                  {alert.status === "PENDING" ? "En attente" : alert.status === "ACKNOWLEDGED" ? "Vue" : "Résolue"}
                </Badge>
              </div>
            ))
          )}
          <Button variant="outline" size="sm" className="w-fit" render={<Link href="/dashboard/alerts" />}>
            Voir toutes les alertes
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actions rapides</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button render={<Link href="/dashboard/agencies/new" />}>
            Créer une agence
          </Button>
          <Button variant="outline" render={<Link href="/dashboard/agencies" />}>
            Voir les agences
          </Button>
          <Button variant="outline" render={<Link href="/dashboard/users" />}>
            Voir les utilisateurs
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
