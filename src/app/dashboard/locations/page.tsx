import Link from "next/link";
import { Plus } from "lucide-react";
import type { LocationStatus } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { Button, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { LocationsTable, type LocationRow } from "./LocationsTable";

const STATUS_OPTIONS: { value: LocationStatus; label: string }[] = [
  { value: "PENDING", label: "En attente" },
  { value: "CONFIRMED", label: "Confirmée" },
  { value: "ACTIVE", label: "En cours" },
  { value: "COMPLETED", label: "Terminée" },
  { value: "CANCELLED", label: "Annulée" },
];

interface PageProps {
  searchParams: Promise<{
    status?: string;
    vehicleId?: string;
    clientId?: string;
    from?: string;
    to?: string;
  }>;
}

export default async function LocationsPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "locations.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Locations</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter les locations.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const params = await searchParams;
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);

  const [vehicles, clients, agencies, locations] = await Promise.all([
    prisma.vehicle.findMany({
      where: {
        tenantId: user.tenantId,
        ...(accessibleAgencyIds ? { agencyId: { in: accessibleAgencyIds } } : {}),
      },
      select: { id: true, name: true, licensePlate: true },
      orderBy: { name: "asc" },
    }),
    prisma.client.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.agency.findMany({
      where: {
        tenantId: user.tenantId,
        ...(accessibleAgencyIds ? { id: { in: accessibleAgencyIds } } : {}),
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.location.findMany({
      where: {
        tenantId: user.tenantId,
        ...(accessibleAgencyIds ? { agencyId: { in: accessibleAgencyIds } } : {}),
        ...(params.status ? { status: params.status as LocationStatus } : {}),
        ...(params.vehicleId ? { vehicleId: params.vehicleId } : {}),
        ...(params.clientId ? { clientId: params.clientId } : {}),
        ...(params.from ? { endDate: { gte: new Date(params.from) } } : {}),
        ...(params.to ? { startDate: { lte: new Date(params.to) } } : {}),
      },
      include: {
        client: { select: { name: true } },
        vehicle: { select: { name: true, licensePlate: true } },
      },
      orderBy: { startDate: "desc" },
    }),
  ]);

  // Une facture DRAFT est générée automatiquement à la création d'une location (Sprint 12B,
  // src/app/api/locations/route.ts) mais reste résiliente (peut échouer sans bloquer la
  // location) : la plus récente facture par location est donc recherchée ici, pas garantie.
  const invoices = await prisma.invoice.findMany({
    where: { locationId: { in: locations.map((location) => location.id) } },
    select: { id: true, locationId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const invoiceIdByLocationId = new Map<string, string>();
  for (const invoice of invoices) {
    if (!invoiceIdByLocationId.has(invoice.locationId)) {
      invoiceIdByLocationId.set(invoice.locationId, invoice.id);
    }
  }

  const rows: LocationRow[] = locations.map((location) => ({
    id: location.id,
    contractNumber: location.contractNumber,
    clientName: location.client.name,
    vehicleName: location.vehicle.name,
    licensePlate: location.vehicle.licensePlate,
    startDate: location.startDate.toISOString(),
    endDate: location.endDate.toISOString(),
    status: location.status,
    totalPrice: location.totalPrice,
    currency: location.currency,
    invoiceId: invoiceIdByLocationId.get(location.id) ?? null,
  }));

  const canCreate =
    (await can(user, "locations.create")) && (accessibleAgencyIds === null || accessibleAgencyIds.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Locations</h1>
          <p className="text-sm text-muted-foreground">Réservations et contrats de location.</p>
        </div>
        {canCreate && (
          <Button render={<Link href="/dashboard/locations/new" />}>
            <Plus className="size-4" />
            Créer une location
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
            {vehicles.map((vehicle) => (
              <option key={vehicle.id} value={vehicle.id}>
                {vehicle.name} ({vehicle.licensePlate})
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="clientId" className="text-xs font-medium text-muted-foreground">
            Client
          </label>
          <select
            id="clientId"
            name="clientId"
            defaultValue={params.clientId ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Tous</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
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
            type="date"
            name="from"
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
            type="date"
            name="to"
            defaultValue={params.to ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {(params.status || params.vehicleId || params.clientId || params.from || params.to) && (
          <Button render={<Link href="/dashboard/locations" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <LocationsTable locations={rows} agencies={agencies} />
    </div>
  );
}
