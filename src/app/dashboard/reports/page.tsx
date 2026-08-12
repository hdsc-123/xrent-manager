import Link from "next/link";
import { getSessionUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  getRevenueReport,
  getTopVehicles,
  getLocationsByMonth,
  getRevenueByAgency,
  getOverallOccupancyRate,
  getReservationsByStatus,
} from "@/lib/reports";
import { formatMoney } from "@/lib/format";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import {
  RevenueByMonthChart,
  LocationsByStatusChart,
  LocationsByMonthChart,
  RevenueByAgencyChart,
  OccupancyGauge,
  ReservationsByStatusChart,
} from "./ReportsCharts";
import { ExportCsvButton } from "./ExportCsvButton";

const LOCATION_STATUSES = ["PENDING", "CONFIRMED", "ACTIVE", "COMPLETED", "CANCELLED"] as const;

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function startOfNextMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

export default async function ReportsPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (user.role !== "ADMIN") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Rapports</CardTitle>
          <CardDescription>Cette section est réservée aux administrateurs du tenant.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const params = await searchParams;
  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const from = params.from ? new Date(params.from) : defaultFrom;
  const to = params.to ? new Date(params.to) : now;

  const monthStart = startOfMonth(now);
  const nextMonthStart = startOfNextMonth(now);

  const [
    revenue,
    topVehicles,
    locationsThisMonth,
    locationsByStatusRaw,
    locationsByMonth,
    revenueByAgency,
    occupancyRate,
    reservationsByStatus,
  ] = await Promise.all([
    getRevenueReport(user.tenantId, from, to),
    getTopVehicles(user.tenantId, 5),
    prisma.location.count({
      where: { tenantId: user.tenantId, startDate: { gte: monthStart, lt: nextMonthStart } },
    }),
    prisma.location.groupBy({
      by: ["status"],
      where: { tenantId: user.tenantId, startDate: { gte: from, lte: to } },
      _count: { _all: true },
    }),
    getLocationsByMonth(user.tenantId, from, to),
    getRevenueByAgency(user.tenantId, from, to),
    getOverallOccupancyRate(user.tenantId, from, to),
    getReservationsByStatus(user.tenantId, from, to),
  ]);

  const countByStatus = new Map(locationsByStatusRaw.map((entry) => [entry.status, entry._count._all]));
  const locationsByStatus = LOCATION_STATUSES.map((status) => ({
    status,
    count: countByStatus.get(status) ?? 0,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Rapports</h1>
        <p className="text-sm text-muted-foreground">Vue d&apos;ensemble de l&apos;activité de votre organisation.</p>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3" method="get">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
            Du
          </label>
          <input
            id="from"
            type="date"
            name="from"
            defaultValue={from.toISOString().slice(0, 10)}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="to" className="text-xs font-medium text-muted-foreground">
            Au
          </label>
          <input
            id="to"
            type="date"
            name="to"
            defaultValue={to.toISOString().slice(0, 10)}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>
        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
      </form>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Revenu total (période sélectionnée)</CardDescription>
            <CardTitle className="text-2xl">{formatMoney(revenue.totalRevenue, revenue.currency)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Locations ce mois-ci</CardDescription>
            <CardTitle className="text-2xl">{locationsThisMonth}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Véhicule le plus loué</CardDescription>
            <CardTitle className="text-2xl">{topVehicles[0]?.name ?? "—"}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Revenu par mois</CardTitle>
          <CardDescription>Somme des paiements encaissés, par mois d&apos;encaissement.</CardDescription>
        </CardHeader>
        <CardContent>
          <RevenueByMonthChart data={revenue.byMonth} currency={revenue.currency} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Locations par statut</CardTitle>
          <CardDescription>Locations dont la date de début est comprise dans la période sélectionnée.</CardDescription>
        </CardHeader>
        <CardContent>
          <LocationsByStatusChart data={locationsByStatus} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Locations par mois</CardTitle>
            <CardDescription>Locations créées, par mois, sur la période sélectionnée.</CardDescription>
          </CardHeader>
          <CardContent>
            <LocationsByMonthChart data={locationsByMonth} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Répartition par agence</CardTitle>
            <CardDescription>Revenu facturé (locations en cours ou terminées), par agence.</CardDescription>
          </CardHeader>
          <CardContent>
            <RevenueByAgencyChart data={revenueByAgency} currency={revenue.currency} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Taux d&apos;occupation</CardTitle>
            <CardDescription>Jours loués / jours disponibles, tous véhicules confondus.</CardDescription>
          </CardHeader>
          <CardContent>
            <OccupancyGauge rate={occupancyRate} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Réservations par statut</CardTitle>
            <CardDescription>Réservations créées sur la période, par statut et par source.</CardDescription>
          </CardHeader>
          <CardContent>
            <ReservationsByStatusChart data={reservationsByStatus} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>Véhicules les plus loués</CardTitle>
              <CardDescription>Classés par revenu facturé (locations en cours ou terminées).</CardDescription>
            </div>
            <ExportCsvButton
              filename="vehicules-les-plus-loues.csv"
              rows={topVehicles.map((vehicle) => ({
                vehicule: vehicle.name,
                immatriculation: vehicle.licensePlate,
                locations: vehicle.locationCount,
                revenu: (vehicle.revenue / 100).toFixed(2),
                devise: vehicle.currency,
              }))}
            />
          </div>
        </CardHeader>
        <CardContent>
          {topVehicles.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune donnée.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Véhicule</th>
                    <th className="px-3 py-2 font-medium">Locations</th>
                    <th className="px-3 py-2 font-medium">Revenu</th>
                  </tr>
                </thead>
                <tbody>
                  {topVehicles.map((vehicle) => (
                    <tr key={vehicle.vehicleId} className="border-t border-border">
                      <td className="px-3 py-2">
                        <Link href={`/dashboard/vehicles/${vehicle.vehicleId}`} className="text-primary hover:underline">
                          {vehicle.name} ({vehicle.licensePlate})
                        </Link>
                      </td>
                      <td className="px-3 py-2">{vehicle.locationCount}</td>
                      <td className="px-3 py-2">{formatMoney(vehicle.revenue, vehicle.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
