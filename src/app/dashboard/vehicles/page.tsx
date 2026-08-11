import Link from "next/link";
import { Plus } from "lucide-react";
import type { VehicleStatus } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui";
import { VehiclesTable, type VehicleRow } from "./VehiclesTable";

const STATUS_OPTIONS: { value: VehicleStatus; label: string }[] = [
  { value: "AVAILABLE", label: "Disponible" },
  { value: "RENTED", label: "Loué" },
  { value: "MAINTENANCE", label: "Maintenance" },
  { value: "INACTIVE", label: "Inactif" },
];

interface PageProps {
  searchParams: Promise<{ agencyId?: string; status?: string; category?: string }>;
}

export default async function VehiclesPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  const params = await searchParams;
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);

  const [agencies, categories, vehicles] = await Promise.all([
    prisma.agency.findMany({
      where: {
        tenantId: user.tenantId,
        ...(accessibleAgencyIds ? { id: { in: accessibleAgencyIds } } : {}),
      },
      orderBy: { name: "asc" },
    }),
    prisma.vehicle.findMany({
      where: { tenantId: user.tenantId },
      select: { category: true },
      distinct: ["category"],
      orderBy: { category: "asc" },
    }),
    prisma.vehicle.findMany({
      where: {
        tenantId: user.tenantId,
        ...(accessibleAgencyIds ? { agencyId: { in: accessibleAgencyIds } } : {}),
        ...(params.agencyId ? { agencyId: params.agencyId } : {}),
        ...(params.status ? { status: params.status as VehicleStatus } : {}),
        ...(params.category ? { category: params.category } : {}),
      },
      include: { agency: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const rows: VehicleRow[] = vehicles.map((vehicle) => ({
    id: vehicle.id,
    name: vehicle.name,
    licensePlate: vehicle.licensePlate,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    category: vehicle.category,
    status: vehicle.status,
    pricePerDay: vehicle.pricePerDay,
    currency: vehicle.currency,
    agencyName: vehicle.agency.name,
  }));

  const canCreate = accessibleAgencyIds === null || accessibleAgencyIds.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Véhicules</h1>
          <p className="text-sm text-muted-foreground">Flotte de véhicules de votre organisation.</p>
        </div>
        {canCreate && (
          <Button render={<Link href="/dashboard/vehicles/new" />}>
            <Plus className="size-4" />
            Créer un véhicule
          </Button>
        )}
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3" method="get">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="agencyId" className="text-xs font-medium text-muted-foreground">
            Agence
          </label>
          <select
            id="agencyId"
            name="agencyId"
            defaultValue={params.agencyId ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Toutes</option>
            {agencies.map((agency) => (
              <option key={agency.id} value={agency.id}>
                {agency.name}
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
          <label htmlFor="category" className="text-xs font-medium text-muted-foreground">
            Catégorie
          </label>
          <select
            id="category"
            name="category"
            defaultValue={params.category ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Toutes</option>
            {categories.map(({ category }) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </div>

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {(params.agencyId || params.status || params.category) && (
          <Button render={<Link href="/dashboard/vehicles" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <VehiclesTable vehicles={rows} />
    </div>
  );
}
