import Link from "next/link";
import { Plus } from "lucide-react";
import type { MaintenanceStatus, MaintenanceType } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { Button, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { MaintenancesTable, type MaintenanceRow } from "./MaintenancesTable";
import { VehicleStatusOverviewTable, type VehicleStatusRow } from "./VehicleStatusOverviewTable";

const STATUS_OPTIONS: { value: MaintenanceStatus; label: string }[] = [
  { value: "SCHEDULED", label: "Planifiée" },
  { value: "IN_PROGRESS", label: "En cours" },
  { value: "COMPLETED", label: "Terminée" },
  { value: "CANCELLED", label: "Annulée" },
];

const TYPE_OPTIONS: { value: MaintenanceType; label: string }[] = [
  { value: "OIL_CHANGE", label: "Vidange" },
  { value: "TIRE_CHANGE", label: "Changement de pneus" },
  { value: "INSPECTION", label: "Contrôle technique" },
  { value: "REPAIR", label: "Réparation" },
  { value: "OTHER", label: "Autre" },
];

interface PageProps {
  searchParams: Promise<{ status?: string; type?: string; vehicleId?: string; from?: string; to?: string }>;
}

export default async function MaintenancesPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "maintenances.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Maintenances</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter les maintenances.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const params = await searchParams;
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const canEdit = await can(user, "maintenances.edit");
  // Sprint 24 : terminer/annuler ne sont plus couvertes par maintenances.edit — clés dédiées.
  const canComplete = await can(user, "maintenances.complete");
  const canCancel = await can(user, "maintenances.cancel");

  const [vehicles, vehiclesWithStatus, maintenances] = await Promise.all([
    prisma.vehicle.findMany({
      where: {
        tenantId: user.tenantId,
        ...(accessibleAgencyIds ? { agencyId: { in: accessibleAgencyIds } } : {}),
      },
      orderBy: { name: "asc" },
    }),
    // État réel des véhicules (Sprint 14C, section 3) : la location ACTIVE en cours (s'il y en
    // a une) donne la date de retour à afficher, indépendamment de Vehicle.status (qui peut être
    // désynchronisé — voir l'alerte STOCK_INCONSISTENCY, src/lib/scheduled-tasks.ts).
    prisma.vehicle.findMany({
      where: {
        tenantId: user.tenantId,
        ...(accessibleAgencyIds ? { agencyId: { in: accessibleAgencyIds } } : {}),
      },
      include: {
        agency: { select: { name: true } },
        locations: {
          where: { status: "ACTIVE" },
          orderBy: { endDate: "asc" },
          take: 1,
          select: { endDate: true },
        },
      },
      orderBy: { name: "asc" },
    }),
    prisma.maintenance.findMany({
      where: {
        tenantId: user.tenantId,
        ...(accessibleAgencyIds ? { agencyId: { in: accessibleAgencyIds } } : {}),
        ...(params.status ? { status: params.status as MaintenanceStatus } : {}),
        ...(params.type ? { type: params.type as MaintenanceType } : {}),
        ...(params.vehicleId ? { vehicleId: params.vehicleId } : {}),
        ...(params.from ? { scheduledDate: { gte: new Date(params.from) } } : {}),
        ...(params.to ? { scheduledDate: { lte: new Date(params.to) } } : {}),
      },
      include: {
        vehicle: { select: { name: true, licensePlate: true } },
        agency: { select: { name: true } },
      },
      orderBy: { scheduledDate: "desc" },
    }),
  ]);

  const rows: MaintenanceRow[] = maintenances.map((maintenance) => ({
    id: maintenance.id,
    vehicleName: maintenance.vehicle.name,
    licensePlate: maintenance.vehicle.licensePlate,
    agencyName: maintenance.agency.name,
    type: maintenance.type,
    status: maintenance.status,
    scheduledDate: maintenance.scheduledDate.toISOString(),
    completedDate: maintenance.completedDate?.toISOString() ?? null,
    cost: maintenance.cost,
    currency: maintenance.currency,
    notes: maintenance.notes,
  }));

  const overviewRows: VehicleStatusRow[] = vehiclesWithStatus.map((vehicle) => {
    const activeLocation = vehicle.locations[0] ?? null;
    return {
      id: vehicle.id,
      name: vehicle.name,
      licensePlate: vehicle.licensePlate,
      agencyName: vehicle.agency.name,
      status: vehicle.status,
      returnDate: activeLocation?.endDate.toISOString() ?? null,
      available: vehicle.status === "AVAILABLE" && activeLocation === null,
    };
  });

  const canCreate = (accessibleAgencyIds === null || accessibleAgencyIds.length > 0) && (await can(user, "maintenances.create"));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Maintenances</h1>
          <p className="text-sm text-muted-foreground">Suivi des entretiens de la flotte de véhicules.</p>
        </div>
        {canCreate && (
          <Button render={<Link href="/dashboard/maintenances/new" />}>
            <Plus className="size-4" />
            Planifier une maintenance
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="font-heading text-lg font-semibold">État des véhicules</h2>
        <p className="text-sm text-muted-foreground">
          Un véhicule loué reste visible ici (avec sa date de retour) pour anticiper une maintenance à son retour.
        </p>
        <VehicleStatusOverviewTable vehicles={overviewRows} />
      </div>

      <h2 className="font-heading text-lg font-semibold">Historique des maintenances</h2>

      <form className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3" method="get">
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
            {vehicles.map((vehicle) => (
              <option key={vehicle.id} value={vehicle.id}>
                {vehicle.name} ({vehicle.licensePlate})
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
          <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
            Du
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={params.from ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="to" className="text-xs font-medium text-muted-foreground">
            Au
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={params.to ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {(params.status || params.type || params.vehicleId || params.from || params.to) && (
          <Button render={<Link href="/dashboard/maintenances" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <MaintenancesTable maintenances={rows} canEdit={canEdit} canComplete={canComplete} canCancel={canCancel} />
    </div>
  );
}
