import Link from "next/link";
import { Plus } from "lucide-react";
import type { VehicleTripStatus } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicleTrips } from "@/lib/vehicle-trips";
import { prisma } from "@/lib/prisma";
import { Button, Card, CardDescription, CardHeader, CardTitle, Icon } from "@/components/ui";
import { VehicleTripsTable, type VehicleTripRow } from "./VehicleTripsTable";

const STATUS_OPTIONS: { value: VehicleTripStatus; label: string }[] = [
  { value: "IN_PROGRESS", label: "En cours" },
  { value: "COMPLETED", label: "Terminé" },
  { value: "CANCELLED", label: "Annulé" },
];

interface PageProps {
  searchParams: Promise<{ status?: string; vehicleId?: string }>;
}

export default async function VehicleTripsPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "vehicle_trips.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Bons de déplacement</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter les bons de déplacement.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const params = await searchParams;
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const canReturn = await can(user, "vehicle_trips.return");
  const canCancel = await can(user, "vehicle_trips.cancel");

  const trips = await getVehicleTrips(user.tenantId, {
    status: params.status as VehicleTripStatus | undefined,
    vehicleId: params.vehicleId,
  });

  const visibleTrips =
    accessibleAgencyIds === null ? trips : trips.filter((trip) => accessibleAgencyIds.includes(trip.agencyId));

  // Sprint 30 (point 6b, Sprint A) : vehicleMap déjà chargé pour résoudre l'affichage de chaque
  // ligne — réutilisé tel quel pour peupler le filtre véhicule, jamais interrogé une seconde fois.
  const [vehicleMap, agencyMap, userMap] = await Promise.all([
    prisma.vehicle
      .findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true, licensePlate: true } })
      .then((rows) => new Map(rows.map((row) => [row.id, row]))),
    prisma.agency
      .findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true } })
      .then((rows) => new Map(rows.map((row) => [row.id, row.name]))),
    prisma.user
      .findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true } })
      .then((rows) => new Map(rows.map((row) => [row.id, row.name]))),
  ]);

  const rows: VehicleTripRow[] = visibleTrips.map((trip) => ({
    id: trip.id,
    vehicleName: vehicleMap.get(trip.vehicleId)?.name ?? "—",
    licensePlate: vehicleMap.get(trip.vehicleId)?.licensePlate ?? "—",
    agencyName: agencyMap.get(trip.agencyId) ?? "—",
    employeeName: userMap.get(trip.employeeUserId) ?? "—",
    reason: trip.reason,
    destination: trip.destination,
    departureDate: trip.departureDate.toISOString(),
    returnDate: trip.returnDate?.toISOString() ?? null,
    startOdometer: trip.startOdometer,
    endOdometer: trip.endOdometer,
    status: trip.status,
  }));

  const canCreate = (accessibleAgencyIds === null || accessibleAgencyIds.length > 0) && (await can(user, "vehicle_trips.create"));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Bons de déplacement</h1>
          <p className="text-sm text-muted-foreground">
            Déplacement professionnel interne d&apos;un véhicule — sans contrat ni réservation.
          </p>
        </div>
        {canCreate && (
          <Button render={<Link href="/dashboard/vehicle-trips/new" />}>
            <Icon icon={Plus} className="size-4" />
            Nouveau bon de déplacement
          </Button>
        )}
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3" method="get">
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

        <div className="flex flex-col gap-1.5">
          <label htmlFor="vehicleId" className="text-xs font-medium text-muted-foreground">
            Véhicule
          </label>
          <select
            id="vehicleId"
            name="vehicleId"
            defaultValue={params.vehicleId ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Tous</option>
            {Array.from(vehicleMap.entries()).map(([id, vehicle]) => (
              <option key={id} value={id}>
                {vehicle.name} ({vehicle.licensePlate})
              </option>
            ))}
          </select>
        </div>

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {(params.status || params.vehicleId) && (
          <Button render={<Link href="/dashboard/vehicle-trips" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <VehicleTripsTable trips={rows} canReturn={canReturn} canCancel={canCancel} />
    </div>
  );
}
