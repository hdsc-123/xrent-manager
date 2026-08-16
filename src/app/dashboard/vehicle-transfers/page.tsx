import Link from "next/link";
import { Plus } from "lucide-react";
import type { VehicleTransferStatus } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicleTransfers } from "@/lib/vehicle-transfers";
import { prisma } from "@/lib/prisma";
import { Button, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { VehicleTransfersTable, type VehicleTransferRow } from "./VehicleTransfersTable";

const STATUS_OPTIONS: { value: VehicleTransferStatus; label: string }[] = [
  { value: "IN_TRANSIT", label: "En transit" },
  { value: "COMPLETED", label: "Réceptionné" },
  { value: "CANCELLED", label: "Annulé" },
];

interface PageProps {
  searchParams: Promise<{ status?: string; vehicleId?: string }>;
}

export default async function VehicleTransfersPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "vehicle_transfers.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Transferts entre agences</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter les transferts de véhicules.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const params = await searchParams;
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const canValidatePerm = await can(user, "vehicle_transfers.validate");
  const canCancel = await can(user, "vehicle_transfers.cancel");

  const transfers = await getVehicleTransfers(user.tenantId, {
    status: params.status as VehicleTransferStatus | undefined,
    vehicleId: params.vehicleId,
  });

  const visibleTransfers =
    accessibleAgencyIds === null
      ? transfers
      : transfers.filter(
          (transfer) =>
            accessibleAgencyIds.includes(transfer.fromAgencyId) || accessibleAgencyIds.includes(transfer.toAgencyId)
        );

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

  const rows: VehicleTransferRow[] = visibleTransfers.map((transfer) => ({
    id: transfer.id,
    vehicleName: vehicleMap.get(transfer.vehicleId)?.name ?? "—",
    licensePlate: vehicleMap.get(transfer.vehicleId)?.licensePlate ?? "—",
    fromAgencyName: agencyMap.get(transfer.fromAgencyId) ?? "—",
    toAgencyName: agencyMap.get(transfer.toAgencyId) ?? "—",
    fromCity: transfer.fromCity,
    toCity: transfer.toCity,
    departureDate: transfer.departureDate.toISOString(),
    arrivalDate: transfer.arrivalDate?.toISOString() ?? null,
    startOdometer: transfer.startOdometer,
    responsibleName: userMap.get(transfer.responsibleUserId) ?? "—",
    reason: transfer.reason,
    status: transfer.status,
    canValidate: canValidatePerm && (accessibleAgencyIds === null || accessibleAgencyIds.includes(transfer.toAgencyId)),
  }));

  const canCreate = (accessibleAgencyIds === null || accessibleAgencyIds.length > 0) && (await can(user, "vehicle_transfers.create"));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Transferts entre agences</h1>
          <p className="text-sm text-muted-foreground">
            Déplacement d&apos;un véhicule d&apos;une agence vers une autre — distinct des locations.
          </p>
        </div>
        {canCreate && (
          <Button render={<Link href="/dashboard/vehicle-transfers/new" />}>
            <Plus className="size-4" />
            Nouveau transfert
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
          <Button render={<Link href="/dashboard/vehicle-transfers" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <VehicleTransfersTable transfers={rows} canCancel={canCancel} />
    </div>
  );
}
