import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recomputeCashRegisterBalance } from "@/lib/cash-register";
import { logAction } from "@/lib/audit";

/**
 * Réinitialisation des données métier/test d'un tenant (Sprint 14D), déclenchable depuis
 * `/dashboard/settings` par un ADMIN. Distincte de `scripts/reset-dev-data.js` (outil CLI
 * garde-fouté par nom de base `_dev`/`_test`, qui vide *toutes* les données de *tous* les
 * tenants) : cette fonction reste strictement scopée à `tenantId`, comme toute autre
 * opération du SaaS (SECURITY.md section 1) — un ADMIN ne peut jamais réinitialiser un
 * tenant autre que le sien.
 *
 * Conservé (schéma/config indispensables au fonctionnement) : Tenant, Agency, User,
 * UserAgency, PermissionGroup/GroupPermission/UserPermission, ExpenseCategory, CashRegister
 * (solde recalculé à 0 après la purge des CashEntry, jamais supprimé), Account/Session/
 * VerificationToken (NextAuth).
 *
 * Vidé : Client, Vehicle, Location, Invoice, Payment, Maintenance, VehicleTransfer,
 * VehicleTrip, Alert, Invitation, Reservation, CashEntry ; AuditLog uniquement si
 * `includeAuditLog` (option « réinitialisation complète », voir l'énoncé du sprint).
 * `Tenant.lastContractNumber` est remis à 0 (cohérent avec la suppression de toutes les
 * `Location`, voir DOMAINRULES.md section 29) — `contractNumberPrefix` fait partie de la
 * configuration et n'est jamais touché.
 *
 * Ordre de suppression : enfants avant parents (contrainte de clé étrangère), même ordre
 * que `scripts/reset-dev-data.js` — Payment avant Invoice, Invoice/Maintenance/
 * VehicleTransfer/VehicleTrip avant Location, Location avant Vehicle/Client.
 */

/**
 * SECURITY.md section 17 (décision validée Sprint 1) : tout reset de données doit être
 * techniquement impossible en environnement de production, vérifié côté serveur de façon
 * non contournable depuis le client — le détail du mécanisme restait "À DÉCIDER" jusqu'ici.
 * Tranché ici (Sprint 14D) : `process.env.NODE_ENV === "production"` (même convention que
 * `src/lib/prisma.ts`) — `next build && next start` la positionne à `"production"`, `next dev`
 * (utilisé aussi bien en développement que par le serveur de test Vitest, voir
 * vitest.global-setup.ts) la laisse à `"development"`. Non contournable depuis le client :
 * ni `tenantId` ni aucun autre paramètre de la requête n'influence ce contrôle.
 */
export class DataResetNotAllowedInProductionError extends Error {
  constructor() {
    super("Le reset de données est désactivé en environnement de production.");
    this.name = "DataResetNotAllowedInProductionError";
  }
}

function assertNotProduction(): void {
  if (process.env.NODE_ENV === "production") {
    throw new DataResetNotAllowedInProductionError();
  }
}

export class InvalidResetConfirmationError extends Error {
  constructor() {
    super("Le nom saisi ne correspond pas au nom du tenant.");
    this.name = "InvalidResetConfirmationError";
  }
}

export class DataResetInProgressError extends Error {
  constructor() {
    super("Une réinitialisation est déjà en cours pour ce tenant.");
    this.name = "DataResetInProgressError";
  }
}

/**
 * Verrou best-effort en mémoire de process, pour empêcher un double-clic/une double
 * soumission concurrente sur le même tenant — décision non soumise à validation préalable,
 * prise en cours d'implémentation. Aucune infrastructure de verrou distribué (Redis, etc.)
 * n'existe ailleurs dans ce projet (sessions NextAuth en JWT, stateless ; hébergeur/stratégie
 * de déploiement encore À DÉCIDER, voir ARCHITECTURE.md) : un `Set` en mémoire suffit tant que
 * l'application tourne sur un seul process, et n'aggrave aucun risque déjà présent. À revoir
 * explicitement si un déploiement multi-instance est décidé un jour.
 */
const tenantsResetting = new Set<string>();

export interface DataResetCounts {
  client: number;
  vehicle: number;
  location: number;
  invoice: number;
  payment: number;
  maintenance: number;
  vehicleTransfer: number;
  vehicleTrip: number;
  alert: number;
  invitation: number;
  reservation: number;
  cashEntry: number;
  auditLog: number;
}

async function countResetTargets(tenantId: string): Promise<DataResetCounts> {
  const [
    client,
    vehicle,
    location,
    invoice,
    payment,
    maintenance,
    vehicleTransfer,
    vehicleTrip,
    alert,
    invitation,
    reservation,
    cashEntry,
    auditLog,
  ] = await Promise.all([
    prisma.client.count({ where: { tenantId } }),
    prisma.vehicle.count({ where: { tenantId } }),
    prisma.location.count({ where: { tenantId } }),
    prisma.invoice.count({ where: { tenantId } }),
    prisma.payment.count({ where: { tenantId } }),
    prisma.maintenance.count({ where: { tenantId } }),
    prisma.vehicleTransfer.count({ where: { tenantId } }),
    prisma.vehicleTrip.count({ where: { tenantId } }),
    prisma.alert.count({ where: { tenantId } }),
    prisma.invitation.count({ where: { tenantId } }),
    prisma.reservation.count({ where: { tenantId } }),
    prisma.cashEntry.count({ where: { tenantId } }),
    prisma.auditLog.count({ where: { tenantId } }),
  ]);

  return {
    client,
    vehicle,
    location,
    invoice,
    payment,
    maintenance,
    vehicleTransfer,
    vehicleTrip,
    alert,
    invitation,
    reservation,
    cashEntry,
    auditLog,
  };
}

export interface DataResetSummary {
  tenantName: string;
  toDelete: DataResetCounts;
}

/** Aperçu avant confirmation — comptages réels, affichés dans la boîte de dialogue de reset. */
export async function getDataResetSummary(tenantId: string): Promise<DataResetSummary> {
  assertNotProduction();

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
  const toDelete = await countResetTargets(tenantId);
  return { tenantName: tenant.name, toDelete };
}

export interface ResetTenantDataInput {
  tenantId: string;
  userId: string;
  confirmTenantName: string;
  includeAuditLog: boolean;
}

/**
 * Exécute la réinitialisation. `confirmTenantName` doit correspondre exactement au nom
 * actuel du tenant (saisi par l'ADMIN dans la boîte de dialogue de confirmation) — protège
 * contre un clic accidentel, même après avoir franchi le rôle et l'avertissement affiché.
 */
export async function resetTenantData(input: ResetTenantDataInput): Promise<DataResetCounts> {
  assertNotProduction();

  // Vérifié et posé de façon strictement synchrone, avant tout `await` : garantit que deux
  // appels concurrents sur le même tenant (même process) sont sérialisés de façon
  // déterministe, plutôt que de risquer une fenêtre de course entre la lecture du tenant et
  // la pose du verrou.
  if (tenantsResetting.has(input.tenantId)) {
    throw new DataResetInProgressError();
  }
  tenantsResetting.add(input.tenantId);

  try {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: input.tenantId }, select: { name: true } });

    if (input.confirmTenantName !== tenant.name) {
      throw new InvalidResetConfirmationError();
    }

    const { tenantId } = input;

    const [
      paymentResult,
      invoiceResult,
      maintenanceResult,
      vehicleTransferResult,
      vehicleTripResult,
      locationResult,
      vehicleResult,
      clientResult,
      reservationResult,
      alertResult,
      invitationResult,
      cashEntryResult,
    ] = await prisma.$transaction([
      prisma.payment.deleteMany({ where: { tenantId } }),
      prisma.invoice.deleteMany({ where: { tenantId } }),
      prisma.maintenance.deleteMany({ where: { tenantId } }),
      prisma.vehicleTransfer.deleteMany({ where: { tenantId } }),
      prisma.vehicleTrip.deleteMany({ where: { tenantId } }),
      prisma.location.deleteMany({ where: { tenantId } }),
      prisma.vehicle.deleteMany({ where: { tenantId } }),
      prisma.client.deleteMany({ where: { tenantId } }),
      prisma.reservation.deleteMany({ where: { tenantId } }),
      prisma.alert.deleteMany({ where: { tenantId } }),
      prisma.invitation.deleteMany({ where: { tenantId } }),
      prisma.cashEntry.deleteMany({ where: { tenantId } }),
      prisma.tenant.update({ where: { id: tenantId }, data: { lastContractNumber: 0 } }),
    ]);

    const auditLogResult = input.includeAuditLog
      ? await prisma.auditLog.deleteMany({ where: { tenantId } })
      : { count: 0 };

    // CashEntry vient d'être vidée : le solde recalculé (recomputeCashRegisterBalance,
    // src/lib/cash-register.ts) est nécessairement 0 — jamais mis à jour à la main pour
    // rester cohérent avec le principe "solde toujours recalculé depuis les écritures
    // réelles" (DOMAINRULES.md).
    await recomputeCashRegisterBalance(tenantId);

    const deleted: DataResetCounts = {
      payment: paymentResult.count,
      invoice: invoiceResult.count,
      maintenance: maintenanceResult.count,
      vehicleTransfer: vehicleTransferResult.count,
      vehicleTrip: vehicleTripResult.count,
      location: locationResult.count,
      vehicle: vehicleResult.count,
      client: clientResult.count,
      reservation: reservationResult.count,
      alert: alertResult.count,
      invitation: invitationResult.count,
      cashEntry: cashEntryResult.count,
      auditLog: auditLogResult.count,
    };

    await logAction({
      tenantId,
      userId: input.userId,
      action: "data.reset",
      resource: "Tenant",
      resourceId: tenantId,
      metadata: { deleted, includeAuditLog: input.includeAuditLog } as unknown as Prisma.InputJsonValue,
    });

    return deleted;
  } finally {
    tenantsResetting.delete(input.tenantId);
  }
}
