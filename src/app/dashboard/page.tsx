import Link from "next/link";
import { Bell, CalendarClock, CalendarRange, Car, FileWarning, Store, Wrench } from "lucide-react";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { getTenantById } from "@/lib/db";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getAlerts } from "@/lib/alerts";
import { formatMoney } from "@/lib/format";
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
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const [
    canViewReservations,
    canViewVehicles,
    canViewAgencies,
    canCreateAgencies,
    canViewLocations,
    canViewMaintenances,
    canViewInvoices,
  ] = await Promise.all([
    can(user, "reservations.view"),
    can(user, "vehicles.view"),
    can(user, "agencies.view"),
    can(user, "agencies.create"),
    can(user, "locations.view"),
    can(user, "maintenances.view"),
    can(user, "invoices.view"),
  ]);

  const [
    tenant,
    returnsToday,
    dueMaintenances,
    overdueInvoicesCount,
    recentAlerts,
    reservationsTodayCount,
    reservationsTodayByCurrency,
    availableVehiclesCount,
    availableVehiclesSample,
  ] = await Promise.all([
    getTenantById(user.tenantId),
    // Sprint 17 : ces trois comptages ("À faire aujourd'hui") sont désormais gated par la même
    // permission *.view que leur module — un groupe sans accès (ex. COMPTABILITÉ, sans
    // locations.view/maintenances.view) voyait jusqu'ici un compte agrégé réel malgré un accès
    // par ailleurs bloqué au clic (403), même principe que les tuiles Réservations/Véhicules
    // ci-dessous depuis le Sprint 15.
    canViewLocations
      ? prisma.location.count({
          where: { tenantId: user.tenantId, ...agencyScope, status: "ACTIVE", endDate: { lte: endOfToday } },
        })
      : 0,
    canViewMaintenances
      ? prisma.maintenance.count({
          where: { tenantId: user.tenantId, ...agencyScope, status: "SCHEDULED", scheduledDate: { lte: endOfToday } },
        })
      : 0,
    canViewInvoices
      ? prisma.invoice.count({
          where: {
            tenantId: user.tenantId,
            ...agencyScope,
            status: { in: ["SENT", "PARTIALLY_PAID"] },
            dueDate: { lt: now },
          },
        })
      : 0,
    getAlerts(user.tenantId, {}),
    // Sprint 15 : Reservation n'a pas d'agencyId (DOMAINRULES.md section 21 — aucune agence
    // réelle n'est associée à une réservation avant sa conversion en contrat) : ce widget
    // reste donc tenant-wide, pas de scoping par agence possible ici (contrairement aux
    // tuiles ci-dessus, qui portent toutes sur Location/Maintenance/Invoice, agency-scopées).
    canViewReservations
      ? prisma.reservation.count({
          where: { tenantId: user.tenantId, startDate: { gte: startOfToday, lte: endOfToday } },
        })
      : 0,
    canViewReservations
      ? prisma.reservation.groupBy({
          by: ["currency"],
          where: {
            tenantId: user.tenantId,
            startDate: { gte: startOfToday, lte: endOfToday },
            totalPrice: { not: null },
          },
          _sum: { totalPrice: true },
        })
      : [],
    canViewVehicles
      ? prisma.vehicle.count({ where: { tenantId: user.tenantId, ...agencyScope, status: "AVAILABLE" } })
      : 0,
    canViewVehicles
      ? prisma.vehicle.findMany({
          where: { tenantId: user.tenantId, ...agencyScope, status: "AVAILABLE" },
          select: { name: true, licensePlate: true },
          take: 5,
          orderBy: { name: "asc" },
        })
      : [],
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
        {canViewReservations && (
          <Card>
            <CardHeader>
              <CardDescription className="flex items-center gap-2">
                <CalendarRange className="size-4" /> Réservations aujourd&apos;hui
              </CardDescription>
              <CardTitle className="text-3xl">{reservationsTodayCount}</CardTitle>
              {reservationsTodayByCurrency.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {reservationsTodayByCurrency
                    .map((group) => formatMoney(group._sum.totalPrice ?? 0, group.currency))
                    .join(" + ")}
                </p>
              )}
            </CardHeader>
          </Card>
        )}
        {canViewVehicles && (
          <Card>
            <CardHeader>
              <CardDescription className="flex items-center gap-2">
                <Car className="size-4" /> Véhicules disponibles
              </CardDescription>
              <CardTitle className="text-3xl">{availableVehiclesCount}</CardTitle>
              {availableVehiclesSample.length > 0 && (
                <p className="truncate text-sm text-muted-foreground">
                  {availableVehiclesSample
                    .map((vehicle) => vehicle.name || vehicle.licensePlate)
                    .join(", ")}
                  {availableVehiclesCount > availableVehiclesSample.length && "…"}
                </p>
              )}
            </CardHeader>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <Store className="size-4" /> Agence
            </CardDescription>
            <CardTitle className="truncate text-3xl">{tenant?.name ?? "—"}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {(canViewLocations || canViewMaintenances || canViewInvoices) && (
        <Card>
          <CardHeader>
            <CardTitle>À faire aujourd&apos;hui</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {canViewLocations && (
              <Link
                href="/dashboard/locations?status=ACTIVE"
                className="flex items-center justify-between rounded-md border border-border p-3 hover:bg-accent"
              >
                <span className="flex items-center gap-2 text-sm">
                  <CalendarClock className="size-4 text-muted-foreground" /> Retours
                </span>
                <span className="text-lg font-semibold">{returnsToday}</span>
              </Link>
            )}
            {canViewMaintenances && (
              <Link
                href="/dashboard/maintenances?status=SCHEDULED"
                className="flex items-center justify-between rounded-md border border-border p-3 hover:bg-accent"
              >
                <span className="flex items-center gap-2 text-sm">
                  <Wrench className="size-4 text-muted-foreground" /> Maintenances
                </span>
                <span className="text-lg font-semibold">{dueMaintenances}</span>
              </Link>
            )}
            {canViewInvoices && (
              <Link
                href="/dashboard/invoices"
                className="flex items-center justify-between rounded-md border border-border p-3 hover:bg-accent"
              >
                <span className="flex items-center gap-2 text-sm">
                  <FileWarning className="size-4 text-muted-foreground" /> Factures en retard
                </span>
                <span className="text-lg font-semibold">{overdueInvoicesCount}</span>
              </Link>
            )}
          </CardContent>
        </Card>
      )}

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

      {(canCreateAgencies || canViewAgencies || user.role === "ADMIN") && (
        <Card>
          <CardHeader>
            <CardTitle>Actions rapides</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {canCreateAgencies && (
              <Button render={<Link href="/dashboard/agencies/new" />}>Créer une agence</Button>
            )}
            {canViewAgencies && (
              <Button variant="outline" render={<Link href="/dashboard/agencies" />}>
                Voir les agences
              </Button>
            )}
            {user.role === "ADMIN" && (
              <Button variant="outline" render={<Link href="/dashboard/users" />}>
                Voir les utilisateurs
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
