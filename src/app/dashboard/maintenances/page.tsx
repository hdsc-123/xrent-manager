import Link from "next/link";
import { Plus } from "lucide-react";
import type { MaintenanceStatus, MaintenanceType } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui";
import { MaintenancesTable, type MaintenanceRow } from "./MaintenancesTable";

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

  const params = await searchParams;
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);

  const [vehicles, maintenances] = await Promise.all([
    prisma.vehicle.findMany({
      where: {
        tenantId: user.tenantId,
        ...(accessibleAgencyIds ? { agencyId: { in: accessibleAgencyIds } } : {}),
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

  const canCreate = accessibleAgencyIds === null || accessibleAgencyIds.length > 0;

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

      <MaintenancesTable maintenances={rows} />
    </div>
  );
}
