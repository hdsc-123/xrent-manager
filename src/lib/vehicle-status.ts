import type { Prisma, Vehicle, VehicleStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { BLOCKING_MAINTENANCE_STATUSES, getMaintenanceEffectiveEnd } from "@/lib/vehicles";

/**
 * Source de vérité unique du statut opérationnel d'un véhicule (sprint "statut opérationnel
 * automatique", 2026-08-28 — révise DOMAINRULES.md section 5, qui documentait jusqu'ici
 * `Vehicle.status` comme un champ manuel simple, décision reconduite aux Sprints 28/34/campagne
 * QA 2026-08-28). Le statut n'est plus jamais saisi par le client : il est entièrement dérivé
 * des opérations métier réellement actives sur ce véhicule à `referenceDate`, avec une priorité
 * fixe en cas de chevauchement (qui ne devrait de toute façon jamais se produire — chaque point
 * d'entrée qui démarre une opération bloquante refuse déjà de le faire tant qu'une autre est en
 * cours, voir assertVehicleNotDeactivated/assertVehicleStatusAllowsLocation et les gardes
 * `status !== "AVAILABLE"` de vehicle-transfers.ts/vehicle-trips.ts) :
 *
 *   1. RENTED       — une Location `ACTIVE` existe pour ce véhicule.
 *   2. TRANSFERRING — un VehicleTransfer `IN_TRANSIT` existe pour ce véhicule.
 *   3. MAINTENANCE  — une Maintenance SCHEDULED/IN_PROGRESS dont la période bloquante
 *                      (getMaintenanceEffectiveEnd, même définition que findConflictingMaintenances,
 *                      src/lib/vehicles.ts) couvre `referenceDate` — une maintenance planifiée
 *                      pour une date future ne bloque donc jamais prématurément.
 *   4. ON_TRIP      — un VehicleTrip `IN_PROGRESS` existe pour ce véhicule.
 *   5. AVAILABLE    — aucune des opérations ci-dessus.
 *
 * Ne tient volontairement compte ni de `Vehicle.deactivatedAt` (état administratif orthogonal,
 * voir assertVehicleNotDeactivated ci-dessous — un véhicule désactivé peut avoir un statut
 * opérationnel calculé `AVAILABLE` tout en restant inutilisable) ni des `Location`
 * `PENDING`/`CONFIRMED` (une réservation future n'occupe pas le véhicule *maintenant* — seule une
 * Location `ACTIVE` reflète un contrat réellement en cours ; la vérification de conflit de dates
 * pour une nouvelle réservation reste `checkAvailability`, inchangée).
 *
 * `tx` optionnel (même convention que checkAvailability/findConflictingMaintenances,
 * src/lib/vehicles.ts) : à passer systématiquement quand le véhicule est déjà verrouillé
 * (`lockVehicleForUpdate`) dans la transaction appelante, pour lire un état garanti à jour vis-
 * à-vis de toute autre transaction concurrente visant le même véhicule.
 */
export async function getVehicleOperationalStatus(
  vehicleId: string,
  referenceDate: Date = new Date(),
  tx: Prisma.TransactionClient = prisma
): Promise<VehicleStatus> {
  const activeLocation = await tx.location.findFirst({
    where: { vehicleId, status: "ACTIVE" },
    select: { id: true },
  });
  if (activeLocation) {
    return "RENTED";
  }

  const activeTransfer = await tx.vehicleTransfer.findFirst({
    where: { vehicleId, status: "IN_TRANSIT" },
    select: { id: true },
  });
  if (activeTransfer) {
    return "TRANSFERRING";
  }

  const candidateMaintenances = await tx.maintenance.findMany({
    where: {
      vehicleId,
      status: { in: [...BLOCKING_MAINTENANCE_STATUSES] },
      scheduledDate: { lte: referenceDate },
    },
    select: { scheduledDate: true, scheduledEndDate: true },
  });
  const hasActiveMaintenance = candidateMaintenances.some(
    (maintenance) => referenceDate < getMaintenanceEffectiveEnd(maintenance)
  );
  if (hasActiveMaintenance) {
    return "MAINTENANCE";
  }

  const activeTrip = await tx.vehicleTrip.findFirst({
    where: { vehicleId, status: "IN_PROGRESS" },
    select: { id: true },
  });
  if (activeTrip) {
    return "ON_TRIP";
  }

  return "AVAILABLE";
}

/**
 * Recalcule le statut opérationnel et réécrit `Vehicle.status` (cache synchronisé, jamais la
 * source de vérité — voir le commentaire sur l'enum `VehicleStatus`, prisma/schema.prisma). À
 * appeler dans la même transaction Prisma que toute écriture Location/Maintenance/
 * VehicleTransfer/VehicleTrip qui peut faire varier le statut réel (activation/retour/
 * annulation de contrat, démarrage/clôture/annulation de maintenance, lancement/réception/
 * annulation de transfert ou de déplacement) — remplace les anciennes écritures aveugles
 * `status: "AVAILABLE"` qui ne tenaient jamais compte d'une autre opération bloquante
 * potentiellement déjà active.
 */
export async function syncVehicleStatus(
  vehicleId: string,
  tx: Prisma.TransactionClient,
  referenceDate: Date = new Date()
): Promise<VehicleStatus> {
  const status = await getVehicleOperationalStatus(vehicleId, referenceDate, tx);
  await tx.vehicle.update({ where: { id: vehicleId }, data: { status } });
  return status;
}

/**
 * Synchronise `Vehicle.currentOdometer`/`currentFuelLevel` avec le kilométrage/carburant de
 * retour d'un contrat qui vient de passer à `COMPLETED` (revue durée de réservation/retour
 * véhicule, 2026-09-01) — jusqu'ici ces deux champs restaient figés à leur valeur de création
 * (Sprint 24, "purement informatifs, jamais mis à jour après création"), la fiche véhicule ne
 * reflétait donc jamais un retour réel alors que `getVehicleLastKnownState` (src/lib/vehicles.ts)
 * dérivait déjà correctement le bon kilométrage/carburant de départ du contrat suivant à partir
 * de `Location.endOdometer`/`endFuelLevel`. Cette fonction ne remplace pas
 * `getVehicleLastKnownState` (qui reste la source de vérité pour tout calcul dérivé, un mouvement
 * plus récent y prime toujours) — elle tient seulement `Vehicle.currentOdometer`/
 * `currentFuelLevel` à jour pour l'affichage de la fiche véhicule et comme repli initial.
 *
 * À appeler dans la même transaction que la validation du retour (jamais après coup) — deux
 * points d'entrée existent aujourd'hui pour clore un contrat (PATCH /api/locations/[id],
 * transition de statut générique ; POST /api/locations/[id]/return, retour orchestré complet),
 * tous deux doivent appeler cette fonction pour rester cohérents.
 *
 * Kilométrage et carburant : mise à jour atomique via `GREATEST` (une seule instruction SQL,
 * jamais un `SELECT` puis `UPDATE` séparés) pour les deux champs — ni l'un ni l'autre ne régresse
 * jamais, y compris sous course entre deux retours concurrents sur le même véhicule (ex. un
 * retour tardif traité après un retour plus récent déjà appliqué). Revue QA du 2026-09-01 :
 * corrige la version initiale de cette fonction, qui n'appliquait la protection anti-régression
 * qu'au kilométrage et écrasait aveuglément le carburant — un retour renseignant un niveau plus
 * bas qu'un retour déjà traité pouvait donc faire reculer la jauge affichée sur la fiche véhicule.
 *
 * `odometer`/`fuelLevel` à `null` = valeur non fournie sur ce retour (les deux sont optionnels
 * sur `Location`, voir prisma/schema.prisma) : le champ correspondant du véhicule n'est alors pas
 * touché, jamais réinitialisé à `null`. L'historique et les valeurs propres au contrat
 * (`Location.endOdometer`/`endFuelLevel`) ne sont jamais modifiés par cette fonction — seul le
 * repli affiché sur la fiche véhicule (`Vehicle.currentOdometer`/`currentFuelLevel`) l'est.
 */
export async function syncVehicleOdometerAndFuel(
  vehicleId: string,
  values: { odometer: number | null; fuelLevel: number | null },
  tx: Prisma.TransactionClient
): Promise<void> {
  if (values.odometer !== null) {
    await tx.$executeRaw`
      UPDATE "Vehicle"
      SET "currentOdometer" = GREATEST(COALESCE("currentOdometer", 0), ${values.odometer})
      WHERE id = ${vehicleId}
    `;
  }
  if (values.fuelLevel !== null) {
    await tx.$executeRaw`
      UPDATE "Vehicle"
      SET "currentFuelLevel" = GREATEST(COALESCE("currentFuelLevel", 0), ${values.fuelLevel})
      WHERE id = ${vehicleId}
    `;
  }
}

/**
 * État administratif (`Vehicle.deactivatedAt`, sprint "statut opérationnel automatique",
 * 2026-08-28 — remplace l'ancien `VehicleStatus.INACTIVE`) : décision réservée ADMIN,
 * orthogonale au statut opérationnel calculé ci-dessus. Bloque, sans exception, toute nouvelle
 * Location/Maintenance/VehicleTransfer/VehicleTrip — même sévérité que
 * `VehicleUnavailableForLocationError` (Sprint 28, Finding E), auquel ce contrôle s'ajoute
 * plutôt que de le remplacer.
 */
export class VehicleDeactivatedError extends Error {
  constructor() {
    super("Ce véhicule est désactivé — aucune nouvelle opération n'est possible tant qu'il n'a pas été réactivé par un administrateur.");
    this.name = "VehicleDeactivatedError";
  }
}

export function assertVehicleNotDeactivated(vehicle: Pick<Vehicle, "deactivatedAt">): void {
  if (vehicle.deactivatedAt) {
    throw new VehicleDeactivatedError();
  }
}
