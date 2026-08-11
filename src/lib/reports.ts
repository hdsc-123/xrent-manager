import { prisma } from "@/lib/prisma";

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
 */
export async function getRevenueReport(tenantId: string, startDate: Date, endDate: Date): Promise<RevenueReport> {
  const payments = await prisma.payment.findMany({
    where: { tenantId, paidAt: { gte: startDate, lte: endDate } },
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
