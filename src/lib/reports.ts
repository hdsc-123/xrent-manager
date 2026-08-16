import { prisma } from "@/lib/prisma";
import { getVehicleLastKnownState } from "@/lib/vehicles";
import { calculateDaysCount } from "@/lib/format";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Statuts de Location considérés comme "réalisés" (occupation effective du véhicule). */
const REALIZED_LOCATION_STATUSES = ["ACTIVE", "COMPLETED"] as const;

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface RevenueByMonth {
  month: string;
  revenue: number;
}

export interface RevenueReport {
  totalRevenue: number;
  currency: string;
  paymentCount: number;
  byMonth: RevenueByMonth[];
}

/**
 * Revenu = somme des Payment.amount (encaissements réels) sur la période, pas le montant
 * facturé (Invoice.totalAmount peut inclure des factures non encore payées). Suppose une
 * devise unique par tenant (voir DOMAINRULES.md section 14, multi-devises À DÉCIDER) :
 * la devise retournée est celle du premier paiement trouvé, "MAD" par défaut si aucun.
 *
 * Sprint 33 (DOMAINRULES.md section 48) : exclut les paiements de dégât — un paiement de dégât
 * n'a plus jamais d'invoiceId (Payment.invoiceId/damageInvoiceId mutuellement exclusifs,
 * contrainte CHECK en base, remplace le filtre `damageId: null` provisoire du Sprint 32). Ce
 * rapport reste défini comme le chiffre d'affaires locatif, sans changer silencieusement de
 * périmètre. Les paiements de dégât restent consultables dans la caisse et sur leur
 * DamageInvoice (src/lib/damage-invoices.ts) ; un rapport financier dédié aux dégâts reste à
 * faire (hors périmètre de ce sprint).
 */
export async function getRevenueReport(tenantId: string, startDate: Date, endDate: Date): Promise<RevenueReport> {
  const payments = await prisma.payment.findMany({
    where: { tenantId, paidAt: { gte: startDate, lte: endDate }, invoiceId: { not: null } },
    orderBy: { paidAt: "asc" },
  });

  const byMonthMap = new Map<string, number>();
  let totalRevenue = 0;

  for (const payment of payments) {
    totalRevenue += payment.amount;
    const key = monthKey(payment.paidAt);
    byMonthMap.set(key, (byMonthMap.get(key) ?? 0) + payment.amount);
  }

  const byMonth = Array.from(byMonthMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, revenue]) => ({ month, revenue }));

  return {
    totalRevenue,
    currency: payments[0]?.currency ?? "MAD",
    paymentCount: payments.length,
    byMonth,
  };
}

export interface VehicleUtilization {
  vehicleId: string;
  name: string;
  licensePlate: string;
  rentedDays: number;
  periodDays: number;
  utilizationRate: number;
}

/**
 * Jours loués = somme, pour chaque Location ACTIVE/COMPLETED du véhicule, du chevauchement
 * entre [Location.startDate, Location.endDate] et [startDate, endDate] (arrondi au jour
 * supérieur, comme calculateTotalPrice dans src/lib/locations.ts). PENDING/CONFIRMED ne
 * comptent pas (pas encore une occupation réelle) ; CANCELLED ne compte jamais.
 */
export async function getVehicleUtilizationReport(
  tenantId: string,
  startDate: Date,
  endDate: Date
): Promise<VehicleUtilization[]> {
  const periodDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / DAY_MS));

  const vehicles = await prisma.vehicle.findMany({
    where: { tenantId },
    select: {
      id: true,
      name: true,
      licensePlate: true,
      locations: {
        where: {
          status: { in: [...REALIZED_LOCATION_STATUSES] },
          startDate: { lte: endDate },
          endDate: { gte: startDate },
        },
        select: { startDate: true, endDate: true },
      },
    },
  });

  return vehicles
    .map((vehicle) => {
      const rentedDays = vehicle.locations.reduce((sum, location) => {
        const clippedStart = location.startDate > startDate ? location.startDate : startDate;
        const clippedEnd = location.endDate < endDate ? location.endDate : endDate;
        if (clippedEnd <= clippedStart) return sum;
        return sum + Math.ceil((clippedEnd.getTime() - clippedStart.getTime()) / DAY_MS);
      }, 0);

      return {
        vehicleId: vehicle.id,
        name: vehicle.name,
        licensePlate: vehicle.licensePlate,
        rentedDays,
        periodDays,
        utilizationRate: rentedDays / periodDays,
      };
    })
    .sort((a, b) => b.utilizationRate - a.utilizationRate);
}

export interface TopVehicle {
  vehicleId: string;
  name: string;
  licensePlate: string;
  locationCount: number;
  revenue: number;
  currency: string;
}

/** Classement par revenu facturé (somme de Location.totalPrice, locations ACTIVE/COMPLETED). */
export async function getTopVehicles(tenantId: string, limit: number): Promise<TopVehicle[]> {
  const vehicles = await prisma.vehicle.findMany({
    where: { tenantId },
    select: {
      id: true,
      name: true,
      licensePlate: true,
      currency: true,
      locations: {
        where: { status: { in: [...REALIZED_LOCATION_STATUSES] } },
        select: { totalPrice: true },
      },
    },
  });

  return vehicles
    .map((vehicle) => ({
      vehicleId: vehicle.id,
      name: vehicle.name,
      licensePlate: vehicle.licensePlate,
      locationCount: vehicle.locations.length,
      revenue: vehicle.locations.reduce((sum, location) => sum + location.totalPrice, 0),
      currency: vehicle.currency,
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

export interface LocationsByMonth {
  month: string;
  count: number;
}

/** Nombre de locations créées par mois sur la période (tous statuts confondus). */
export async function getLocationsByMonth(
  tenantId: string,
  startDate: Date,
  endDate: Date
): Promise<LocationsByMonth[]> {
  const locations = await prisma.location.findMany({
    where: { tenantId, createdAt: { gte: startDate, lte: endDate } },
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const byMonthMap = new Map<string, number>();
  for (const location of locations) {
    const key = monthKey(location.createdAt);
    byMonthMap.set(key, (byMonthMap.get(key) ?? 0) + 1);
  }

  return Array.from(byMonthMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, count]) => ({ month, count }));
}

export interface RevenueByAgency {
  agencyId: string;
  agencyName: string;
  revenue: number;
  currency: string;
}

/**
 * Revenu facturé (Location.totalPrice, ACTIVE/COMPLETED) réparti par agence sur la période.
 * Sprint 22 : `agencyIds` restreint le résultat aux agences accessibles à l'appelant (voir
 * getAccessibleAgencyIds, src/lib/authz.ts) — null = toutes les agences du tenant (ADMIN).
 * Jusqu'ici cette fonction retournait toujours toutes les agences du tenant sans restriction :
 * un MEMBER restreint à une agence voyait quand même le CA de toutes les autres via ce graphique
 * (reports.view n'a jamais été scopé par agence).
 */
export async function getRevenueByAgency(
  tenantId: string,
  startDate: Date,
  endDate: Date,
  agencyIds: string[] | null = null
): Promise<RevenueByAgency[]> {
  const agencies = await prisma.agency.findMany({
    where: { tenantId, ...(agencyIds ? { id: { in: agencyIds } } : {}) },
    select: {
      id: true,
      name: true,
      locations: {
        where: {
          status: { in: [...REALIZED_LOCATION_STATUSES] },
          createdAt: { gte: startDate, lte: endDate },
        },
        select: { totalPrice: true, currency: true },
      },
    },
  });

  return agencies
    .map((agency) => ({
      agencyId: agency.id,
      agencyName: agency.name,
      revenue: agency.locations.reduce((sum, location) => sum + location.totalPrice, 0),
      currency: agency.locations[0]?.currency ?? "MAD",
    }))
    .filter((entry) => entry.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue);
}

/**
 * Taux d'occupation global du tenant sur la période : somme des jours loués (tous
 * véhicules confondus, voir getVehicleUtilizationReport) / (nombre de véhicules × jours de
 * la période). 0 si le tenant n'a aucun véhicule.
 */
export async function getOverallOccupancyRate(tenantId: string, startDate: Date, endDate: Date): Promise<number> {
  const utilization = await getVehicleUtilizationReport(tenantId, startDate, endDate);
  if (utilization.length === 0) {
    return 0;
  }

  const totalRentedDays = utilization.reduce((sum, entry) => sum + entry.rentedDays, 0);
  const totalPossibleDays = utilization.reduce((sum, entry) => sum + entry.periodDays, 0);
  return totalPossibleDays > 0 ? totalRentedDays / totalPossibleDays : 0;
}

export interface ReservationsByStatus {
  status: string;
  broker: number;
  direct: number;
}

/** Nombre de réservations par statut (créées sur la période), réparties broker/direct
 * pour un graphique en barres empilées (spec section 5). */
export async function getReservationsByStatus(
  tenantId: string,
  startDate: Date,
  endDate: Date
): Promise<ReservationsByStatus[]> {
  const grouped = await prisma.reservation.groupBy({
    by: ["status", "source"],
    where: { tenantId, createdAt: { gte: startDate, lte: endDate } },
    _count: { _all: true },
  });

  // Sprint 23 : NO_SHOW ajouté (DOMAINRULES.md section 39) — sans cette entrée, groupBy()
  // renvoie bien les lignes NO_SHOW mais map() les ignore silencieusement (statut absent de
  // la liste), sous-comptant le graphique comme l'ancien bug "broker" du Sprint 17.
  const ALL_STATUSES = ["PENDING", "CONFIRMED", "CONVERTED", "CANCELLED", "NO_SHOW"] as const;

  // Sprint 15 a transformé `source` en texte libre (normalizeSource) précisément pour ne plus
  // perdre les codes broker réels (TJS/DCH/CT...) — un groupBy par valeur exacte de `source`
  // ne doit donc plus jamais chercher la seule valeur "BROKER" (Sprint 17 : ce bucketing datait
  // de l'ancien enum fermé BROKER/DIRECT et sous-comptait silencieusement tout autre code
  // broker réel). Toute source non-DIRECT/non-nulle est par définition un broker.
  return ALL_STATUSES.map((status) => {
    const entriesForStatus = grouped.filter((entry) => entry.status === status);
    const direct = entriesForStatus
      .filter((entry) => entry.source === "DIRECT" || entry.source === null)
      .reduce((sum, entry) => sum + entry._count._all, 0);
    const broker = entriesForStatus
      .filter((entry) => entry.source !== "DIRECT" && entry.source !== null)
      .reduce((sum, entry) => sum + entry._count._all, 0);
    return { status, broker, direct };
  });
}

export interface VehiclePerformanceRow {
  vehicleId: string;
  model: string;
  make: string;
  licensePlate: string;
  currentAgencyName: string;
  currentOdometer: number | null;
  currentFuelLevel: number | null;
  validatedContractCount: number;
  rentedDays: number;
  revenue: number;
  expenses: number;
  currency: string;
  /** revenue - expenses, décroissant — voir le classement ci-dessous. */
  netMargin: number;
  rank: number;
}

/**
 * Onglet « Performance véhicule » (Sprint 23, DOMAINRULES.md section 39, point D de
 * l'énoncé) — toutes villes confondues pour un ADMIN (`agencyIds` null), sinon restreint aux
 * agences accessibles à l'appelant (`getAccessibleAgencyIds`, `src/lib/authz.ts`). Réutilise
 * les mêmes conventions que `getTopVehicles`/`getVehicleUtilizationReport` ci-dessus plutôt que
 * de les dupliquer : `REALIZED_LOCATION_STATUSES` (ACTIVE/COMPLETED) pour les contrats
 * « validés », CA = `Location.totalPrice` facturé (pas encaissé, même définition que
 * `getTopVehicles.revenue`) sur toute la durée (pas de fenêtre de dates, contrairement aux
 * autres rapports — cet onglet est un cumul, pas un rapport périodique). Dépenses = somme de
 * `Maintenance.cost`, seule dépense véhicule-scopée existante dans le schéma. Classement
 * (`rank`) : marge nette (CA - dépenses) décroissante.
 */
export async function getVehiclePerformanceReport(
  tenantId: string,
  agencyIds: string[] | null = null
): Promise<VehiclePerformanceRow[]> {
  const vehicles = await prisma.vehicle.findMany({
    where: { tenantId, ...(agencyIds ? { agencyId: { in: agencyIds } } : {}) },
    select: {
      id: true,
      model: true,
      make: true,
      licensePlate: true,
      currency: true,
      agency: { select: { name: true } },
      locations: {
        where: { status: { in: [...REALIZED_LOCATION_STATUSES] } },
        select: { totalPrice: true, startDate: true, endDate: true },
      },
      maintenances: { select: { cost: true } },
    },
  });

  const rows = await Promise.all(
    vehicles.map(async (vehicle) => {
      const lastKnownState = await getVehicleLastKnownState(tenantId, vehicle.id);
      const revenue = vehicle.locations.reduce((sum, location) => sum + location.totalPrice, 0);
      const rentedDays = vehicle.locations.reduce(
        (sum, location) => sum + calculateDaysCount(location.startDate, location.endDate),
        0
      );
      const expenses = vehicle.maintenances.reduce((sum, maintenance) => sum + (maintenance.cost ?? 0), 0);

      return {
        vehicleId: vehicle.id,
        model: vehicle.model,
        make: vehicle.make,
        licensePlate: vehicle.licensePlate,
        currentAgencyName: vehicle.agency.name,
        currentOdometer: lastKnownState.odometer,
        currentFuelLevel: lastKnownState.fuelLevel,
        validatedContractCount: vehicle.locations.length,
        rentedDays,
        revenue,
        expenses,
        currency: vehicle.currency,
        netMargin: revenue - expenses,
      };
    })
  );

  return rows
    .sort((a, b) => b.netMargin - a.netMargin)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}
