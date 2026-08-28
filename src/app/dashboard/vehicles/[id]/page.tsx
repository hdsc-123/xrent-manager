import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicleById, getMaintenanceEffectiveEnd, periodsOverlap } from "@/lib/vehicles";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui";
import { EditVehicleForm } from "./EditVehicleForm";
import { VehicleReadOnlyDetails } from "./VehicleReadOnlyDetails";

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

// Sprint 22 : historique des alertes de ce véhicule (voir la requête `alerts` ci-dessous).
const ALERT_TYPE_LABELS: Record<string, string> = {
  MAINTENANCE_DUE: "Maintenance à venir",
  RETURN_TODAY: "Retour aujourd'hui",
  RETURN_OVERDUE: "Retour en retard",
  CONTRACT_AT_RISK: "Contrat à risque",
  VEHICLE_UNAVAILABLE: "Véhicule indisponible",
  STOCK_INCONSISTENCY: "Incohérence de stock",
  INSURANCE_EXPIRING: "Assurance à renouveler",
  VIGNETTE_EXPIRING: "Vignette à renouveler",
  TECHNICAL_INSPECTION_DUE: "Contrôle technique",
  OIL_CHANGE_DUE: "Vidange à prévoir",
  VEHICLE_TRANSFER_INCOMING: "Véhicule entrant (transfert)",
  OTHER: "Autre",
};

const ALERT_STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  ACKNOWLEDGED: "Vue",
  RESOLVED: "Résolue",
};

export default async function VehicleDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  // Correctif sprint soft 404 (2026-08-24) : gate manquant découvert lors de l'audit exhaustif
  // — cette page ne vérifiait jusqu'ici que l'accès à l'agence, jamais vehicles.view,
  // contrairement à /dashboard/vehicles (liste) et GET /api/vehicles/[id], qui l'exigent tous
  // les deux. Même correctif que locations/[id] (Sprint technique 2).
  if (!(await can(user, "vehicles.view"))) {
    notFound();
  }

  const vehicle = await getVehicleById(user.tenantId, id);
  if (!vehicle || !(await canAccessAgency(user, vehicle.agencyId))) {
    notFound();
  }

  const canEdit = await can(user, "vehicles.edit");
  const [canViewMaintenances, canViewTransfers, canViewTrips, canViewAlerts] = await Promise.all([
    can(user, "maintenances.view"),
    can(user, "vehicle_transfers.view"),
    can(user, "vehicle_trips.view"),
    can(user, "alerts.view"),
  ]);

  const [agency, locations, maintenances, transfers, trips, alerts] = await Promise.all([
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
          include: {
            fromAgency: { select: { name: true } },
            toAgency: { select: { name: true } },
            responsibleUser: { select: { name: true } },
          },
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
    // Sprint 22 : historique des alertes de ce véhicule (documents/échéances/mobilité — voir
    // src/lib/scheduled-tasks.ts, ces vérifications utilisent toutes vehicle.id comme entityId).
    // Les cuid() étant globalement uniques, filtrer par entityId seul (sans restreindre
    // entityType) ne risque aucune collision avec une alerte liée à une autre ressource
    // (Maintenance/Location/Invoice ont leurs propres id).
    canViewAlerts
      ? prisma.alert.findMany({
          where: { tenantId: user.tenantId, entityId: vehicle.id },
          orderBy: { createdAt: "desc" },
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
      detail: transfer.arrivalDriverName
        ? `${transfer.fromAgency.name} → ${transfer.toAgency.name} (chauffeur : ${transfer.arrivalDriverName})`
        : `${transfer.fromAgency.name} → ${transfer.toAgency.name}`,
      responsible: transfer.responsibleUser.name as string | null,
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

  // Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 5) : "Disponibilité" — statut, location
  // active/prochaine + date de retour prévue, maintenances planifiées + leur période bloquante,
  // et tout conflit éventuel entre les deux. Dérivé des données déjà chargées ci-dessus (aucune
  // requête supplémentaire), même formule de chevauchement que la validation serveur
  // (periodsOverlap/getMaintenanceEffectiveEnd, src/lib/vehicles.ts) pour ne jamais afficher un
  // conflit différent de celui réellement appliqué à l'écriture.
  const now = new Date();
  const BLOCKING_LOCATION_STATUSES = new Set(["PENDING", "CONFIRMED", "ACTIVE"]);
  const currentOrNextLocation =
    locations
      .filter((location) => BLOCKING_LOCATION_STATUSES.has(location.status) && location.endDate >= now)
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())[0] ?? null;

  const blockingMaintenances = maintenances.filter(
    (maintenance) => maintenance.status === "SCHEDULED" || maintenance.status === "IN_PROGRESS"
  );
  const maintenancesWithConflict = blockingMaintenances.map((maintenance) => {
    const effectiveEnd = getMaintenanceEffectiveEnd(maintenance);
    const conflict = currentOrNextLocation
      ? periodsOverlap(currentOrNextLocation.startDate, currentOrNextLocation.endDate, maintenance.scheduledDate, effectiveEnd)
      : false;
    return { maintenance, effectiveEnd, conflict };
  });
  const hasConflict = maintenancesWithConflict.some((entry) => entry.conflict);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">{vehicle.name}</h1>
        <p className="text-sm text-muted-foreground">
          {vehicle.make} {vehicle.model} ({vehicle.year}) — Agence : {agency?.name ?? "—"}
        </p>
      </div>

      <div className="rounded-md border border-border p-4">
        <h2 className="mb-3 font-heading text-lg font-semibold">Disponibilité</h2>
        <div className="flex flex-col gap-2 text-sm">
          <div>
            <span className="text-muted-foreground">Statut : </span>
            <Badge variant="outline">{STATUS_LABELS[vehicle.status] ?? vehicle.status}</Badge>
          </div>
          <div>
            <span className="text-muted-foreground">Location active / prochaine : </span>
            {currentOrNextLocation ? (
              <>
                <Link
                  href={`/dashboard/locations/${currentOrNextLocation.id}`}
                  className="text-primary hover:underline"
                >
                  {currentOrNextLocation.client.name}
                </Link>{" "}
                ({STATUS_LABELS[currentOrNextLocation.status] ?? currentOrNextLocation.status}) — retour prévu le{" "}
                {currentOrNextLocation.endDate.toLocaleString("fr-FR")}
              </>
            ) : (
              "Aucune"
            )}
          </div>
          {canViewMaintenances && (
            <div>
              <span className="text-muted-foreground">Maintenance(s) planifiée(s) : </span>
              {maintenancesWithConflict.length === 0 ? (
                "Aucune"
              ) : (
                <ul className="mt-1 flex flex-col gap-1">
                  {maintenancesWithConflict.map(({ maintenance, effectiveEnd, conflict }) => (
                    <li key={maintenance.id}>
                      {MAINTENANCE_TYPE_LABELS[maintenance.type] ?? maintenance.type} — période bloquante :{" "}
                      {maintenance.scheduledDate.toLocaleString("fr-FR")} → {effectiveEnd.toLocaleString("fr-FR")}
                      {conflict && (
                        <Badge variant="destructive" className="ml-2">
                          Conflit avec la location ci-dessus
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {hasConflict && (
            <p role="alert" className="text-sm font-medium text-destructive">
              Conflit détecté : ce véhicule a une maintenance planifiée qui chevauche sa location
              active/prochaine. Aucun déplacement automatique n&apos;a lieu — une décision explicite
              est nécessaire (prolongation confirmée malgré le conflit, ou replanification de la
              maintenance).
            </p>
          )}
        </div>
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
          initialCurrentOdometer={vehicle.currentOdometer}
          initialCurrentFuelLevel={vehicle.currentFuelLevel}
          initialInsuranceExpiryDate={vehicle.insuranceExpiryDate ? vehicle.insuranceExpiryDate.toISOString().slice(0, 10) : null}
          initialVignetteExpiryDate={vehicle.vignetteExpiryDate ? vehicle.vignetteExpiryDate.toISOString().slice(0, 10) : null}
          initialTechnicalInspectionExpiryDate={
            vehicle.technicalInspectionExpiryDate ? vehicle.technicalInspectionExpiryDate.toISOString().slice(0, 10) : null
          }
          initialNextOilChangeDate={vehicle.nextOilChangeDate ? vehicle.nextOilChangeDate.toISOString().slice(0, 10) : null}
          initialNextOilChangeKm={vehicle.nextOilChangeKm}
          initialDeactivatedAt={vehicle.deactivatedAt ? vehicle.deactivatedAt.toISOString() : null}
          initialDeactivatedReason={vehicle.deactivatedReason}
          canDeactivate={user.role === "ADMIN"}
        />
      ) : (
        // Sprint 22 : la fiche complète reste visible en lecture seule (vehicles.view) —
        // auparavant seul un message de refus s'affichait ici, masquant toutes les données
        // du véhicule à un rôle pourtant autorisé à les consulter.
        <VehicleReadOnlyDetails
          category={vehicle.category}
          status={vehicle.status}
          pricePerDay={vehicle.pricePerDay}
          currency={vehicle.currency}
          licensePlate={vehicle.licensePlate}
          ww={vehicle.ww}
          chassisNumber={vehicle.chassisNumber}
          color={vehicle.color}
          doors={vehicle.doors}
          seats={vehicle.seats}
          transmission={vehicle.transmission}
          fuel={vehicle.fuel}
          horsepower={vehicle.horsepower}
          powerKW={vehicle.powerKW}
          engineSize={vehicle.engineSize}
          ac={vehicle.ac}
          gps={vehicle.gps}
          imageUrl={vehicle.imageUrl}
          insuranceExpiryDate={vehicle.insuranceExpiryDate ? vehicle.insuranceExpiryDate.toISOString().slice(0, 10) : null}
          vignetteExpiryDate={vehicle.vignetteExpiryDate ? vehicle.vignetteExpiryDate.toISOString().slice(0, 10) : null}
          technicalInspectionExpiryDate={
            vehicle.technicalInspectionExpiryDate ? vehicle.technicalInspectionExpiryDate.toISOString().slice(0, 10) : null
          }
          nextOilChangeDate={vehicle.nextOilChangeDate ? vehicle.nextOilChangeDate.toISOString().slice(0, 10) : null}
          nextOilChangeKm={vehicle.nextOilChangeKm}
          deactivatedAt={vehicle.deactivatedAt ? vehicle.deactivatedAt.toISOString() : null}
          deactivatedReason={vehicle.deactivatedReason}
        />
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

      {canViewAlerts && (
        <div>
          <h2 className="mb-2 font-heading text-lg font-semibold">Alertes</h2>
          {alerts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune alerte pour ce véhicule.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Message</th>
                    <th className="px-3 py-2 font-medium">Statut</th>
                    <th className="px-3 py-2 font-medium">Suivi</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((alert) => (
                    <tr key={alert.id} className="border-t border-border align-top">
                      <td className="px-3 py-2">{ALERT_TYPE_LABELS[alert.type] ?? alert.type}</td>
                      <td className="px-3 py-2">{alert.message}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline">{ALERT_STATUS_LABELS[alert.status] ?? alert.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {alert.status === "RESOLVED" ? (
                          <div className="flex flex-col gap-0.5">
                            {alert.resolutionAction && <span>Action : {alert.resolutionAction}</span>}
                            {alert.resolutionIntervenant && <span>Intervenant : {alert.resolutionIntervenant}</span>}
                            {alert.resolutionCost !== null && (
                              <span>Coût : {formatMoney(alert.resolutionCost, alert.resolutionCurrency ?? "MAD")}</span>
                            )}
                            {alert.nextDueDate && (
                              <span>Prochaine échéance : {alert.nextDueDate.toLocaleDateString("fr-FR")}</span>
                            )}
                            {!alert.resolutionAction &&
                              !alert.resolutionIntervenant &&
                              alert.resolutionCost === null &&
                              !alert.nextDueDate &&
                              "—"}
                          </div>
                        ) : (
                          "—"
                        )}
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
