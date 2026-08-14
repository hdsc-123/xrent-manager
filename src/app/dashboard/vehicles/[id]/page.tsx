import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicleById } from "@/lib/vehicles";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui";
import { EditVehicleForm } from "./EditVehicleForm";

interface PageProps {
  params: Promise<{ id: string }>;
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  CONFIRMED: "Confirmée",
  ACTIVE: "En cours",
  COMPLETED: "Terminée",
  CANCELLED: "Annulée",
};

// Sprint 19 (DOMAINRULES.md section 37) : mêmes libellés que MaintenancesTable.tsx/
// VehicleTransfersTable.tsx/VehicleTripsTable.tsx — dupliqués ici plutôt qu'importés (petits
// dictionnaires locaux, même convention déjà en place dans tout le dashboard).
const MAINTENANCE_TYPE_LABELS: Record<string, string> = {
  OIL_CHANGE: "Vidange",
  TIRE_CHANGE: "Changement de pneus",
  INSPECTION: "Contrôle technique",
  REPAIR: "Réparation",
  OTHER: "Autre",
};

const MAINTENANCE_STATUS_LABELS: Record<string, string> = {
  SCHEDULED: "Planifiée",
  IN_PROGRESS: "En cours",
  COMPLETED: "Terminée",
  CANCELLED: "Annulée",
};

const MOVEMENT_STATUS_LABELS: Record<string, string> = {
  IN_TRANSIT: "En transit",
  IN_PROGRESS: "En cours",
  COMPLETED: "Terminé",
  CANCELLED: "Annulé",
};

export default async function VehicleDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  const vehicle = await getVehicleById(user.tenantId, id);
  if (!vehicle || !(await canAccessAgency(user, vehicle.agencyId))) {
    notFound();
  }

  const canEdit = await can(user, "vehicles.edit");
  const [canViewMaintenances, canViewTransfers, canViewTrips] = await Promise.all([
    can(user, "maintenances.view"),
    can(user, "vehicle_transfers.view"),
    can(user, "vehicle_trips.view"),
  ]);

  const [agency, locations, maintenances, transfers, trips] = await Promise.all([
    prisma.agency.findUnique({ where: { id: vehicle.agencyId }, select: { name: true } }),
    prisma.location.findMany({
      where: { vehicleId: vehicle.id },
      include: { client: { select: { name: true } } },
      orderBy: { startDate: "desc" },
    }),
    // Sprint 19 (DOMAINRULES.md section 37) : historique complet des maintenances/mouvements
    // directement sur la fiche véhicule — jusqu'ici uniquement visible via les listes globales
    // /dashboard/maintenances, /vehicle-transfers, /vehicle-trips, sans filtre par véhicule.
    canViewMaintenances
      ? prisma.maintenance.findMany({ where: { vehicleId: vehicle.id }, orderBy: { scheduledDate: "desc" } })
      : [],
    canViewTransfers
      ? prisma.vehicleTransfer.findMany({
          where: { vehicleId: vehicle.id },
          include: { fromAgency: { select: { name: true } }, toAgency: { select: { name: true } } },
          orderBy: { departureDate: "desc" },
        })
      : [],
    canViewTrips
      ? prisma.vehicleTrip.findMany({
          where: { vehicleId: vehicle.id },
          include: { employeeUser: { select: { name: true } } },
          orderBy: { departureDate: "desc" },
        })
      : [],
  ]);

  // Sprint 19 : historique des mouvements = transferts + bons de déplacement fusionnés et
  // triés par date de départ, pour une vue chronologique unique de "où est passé ce véhicule".
  const movements = [
    ...transfers.map((transfer) => ({
      id: transfer.id,
      kind: "Transfert" as const,
      date: transfer.departureDate,
      detail: `${transfer.fromAgency.name} → ${transfer.toAgency.name}`,
      responsible: null as string | null,
      status: transfer.status as string,
    })),
    ...trips.map((trip) => ({
      id: trip.id,
      kind: "Déplacement" as const,
      date: trip.departureDate,
      detail: `${trip.destination} (${trip.reason})`,
      responsible: trip.employeeUser.name,
      status: trip.status as string,
    })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime());

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">{vehicle.name}</h1>
        <p className="text-sm text-muted-foreground">
          {vehicle.make} {vehicle.model} ({vehicle.year}) — Agence : {agency?.name ?? "—"}
        </p>
      </div>

      {canEdit ? (
        <EditVehicleForm
          id={vehicle.id}
          initialName={vehicle.name}
          initialCategory={vehicle.category}
          initialStatus={vehicle.status}
          initialPricePerDay={vehicle.pricePerDay}
          licensePlate={vehicle.licensePlate}
          initialWw={vehicle.ww}
          initialChassisNumber={vehicle.chassisNumber}
          initialColor={vehicle.color}
          initialDoors={vehicle.doors}
          initialSeats={vehicle.seats}
          initialTransmission={vehicle.transmission}
          initialFuel={vehicle.fuel}
          initialHorsepower={vehicle.horsepower}
          initialPowerKW={vehicle.powerKW}
          initialEngineSize={vehicle.engineSize}
          initialAc={vehicle.ac}
          initialGps={vehicle.gps}
          initialImageUrl={vehicle.imageUrl}
          initialInsuranceExpiryDate={vehicle.insuranceExpiryDate ? vehicle.insuranceExpiryDate.toISOString().slice(0, 10) : null}
          initialVignetteExpiryDate={vehicle.vignetteExpiryDate ? vehicle.vignetteExpiryDate.toISOString().slice(0, 10) : null}
          initialTechnicalInspectionExpiryDate={
            vehicle.technicalInspectionExpiryDate ? vehicle.technicalInspectionExpiryDate.toISOString().slice(0, 10) : null
          }
          initialNextOilChangeDate={vehicle.nextOilChangeDate ? vehicle.nextOilChangeDate.toISOString().slice(0, 10) : null}
          initialNextOilChangeKm={vehicle.nextOilChangeKm}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Vous n&apos;avez pas la permission de modifier ce véhicule.
        </p>
      )}

      <div>
        <h2 className="mb-2 font-heading text-lg font-semibold">Locations associées</h2>
        {locations.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune location pour ce véhicule.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Client</th>
                  <th className="px-3 py-2 font-medium">Période</th>
                  <th className="px-3 py-2 font-medium">Statut</th>
                  <th className="px-3 py-2 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((location) => (
                  <tr key={location.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <Link
                        href={`/dashboard/locations/${location.id}`}
                        className="text-primary hover:underline"
                      >
                        {location.client.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      {location.startDate.toLocaleDateString("fr-FR")} →{" "}
                      {location.endDate.toLocaleDateString("fr-FR")}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="outline">{STATUS_LABELS[location.status] ?? location.status}</Badge>
                    </td>
                    <td className="px-3 py-2">{formatMoney(location.totalPrice, location.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canViewMaintenances && (
        <div>
          <h2 className="mb-2 font-heading text-lg font-semibold">Historique maintenance</h2>
          {maintenances.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune maintenance pour ce véhicule.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Planifiée</th>
                    <th className="px-3 py-2 font-medium">Terminée</th>
                    <th className="px-3 py-2 font-medium">Statut</th>
                    <th className="px-3 py-2 font-medium">Coût</th>
                  </tr>
                </thead>
                <tbody>
                  {maintenances.map((maintenance) => (
                    <tr key={maintenance.id} className="border-t border-border">
                      <td className="px-3 py-2">{MAINTENANCE_TYPE_LABELS[maintenance.type] ?? maintenance.type}</td>
                      <td className="px-3 py-2">{maintenance.scheduledDate.toLocaleDateString("fr-FR")}</td>
                      <td className="px-3 py-2">
                        {maintenance.completedDate ? maintenance.completedDate.toLocaleDateString("fr-FR") : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline">
                          {MAINTENANCE_STATUS_LABELS[maintenance.status] ?? maintenance.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        {maintenance.cost !== null ? formatMoney(maintenance.cost, maintenance.currency) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {(canViewTransfers || canViewTrips) && (
        <div>
          <h2 className="mb-2 font-heading text-lg font-semibold">Historique des mouvements</h2>
          {movements.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun transfert ni bon de déplacement pour ce véhicule.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Détail</th>
                    <th className="px-3 py-2 font-medium">Responsable</th>
                    <th className="px-3 py-2 font-medium">Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.map((movement) => (
                    <tr key={`${movement.kind}-${movement.id}`} className="border-t border-border">
                      <td className="px-3 py-2">{movement.kind}</td>
                      <td className="px-3 py-2">{movement.date.toLocaleString("fr-FR")}</td>
                      <td className="px-3 py-2">{movement.detail}</td>
                      <td className="px-3 py-2">{movement.responsible ?? "—"}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline">{MOVEMENT_STATUS_LABELS[movement.status] ?? movement.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
