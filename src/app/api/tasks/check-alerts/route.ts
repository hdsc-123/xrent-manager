import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import {
  checkDueMaintenances,
  checkReturnsToday,
  checkOverdueInvoices,
  checkContractsAtRisk,
  checkPaymentsDue,
  checkVehiclesUnavailable,
  checkOverdueReturns,
  checkExpiredDocuments,
  checkStockInconsistencies,
  checkInsuranceExpiring,
  checkVignetteExpiring,
  checkTechnicalInspectionDue,
  checkOilChangeDue,
} from "@/lib/scheduled-tasks";

/**
 * Déclenche les treize vérifications (3 initiales + 6 ajoutées Sprint 14C + 4 ajoutées
 * Sprint 19, DOMAINRULES.md sections 30/37) pour le tenant de l'ADMIN connecté (aucun rôle
 * "superadmin" transverse n'existe — HANDOFF.md section 8 point 16 — donc pas de scan
 * multi-tenant global ici ; un vrai cron devrait itérer les tenants avec un mécanisme
 * d'authentification dédié, hors périmètre de ce sprint). Réservé ADMIN, même justification
 * pragmatique que pour /api/reports/* (HANDOFF.md, décision Sprint 6).
 */
export async function POST() {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Réservé aux administrateurs." }, { status: 403 });
  }

  const [
    dueMaintenances,
    returnsToday,
    overdueInvoices,
    contractsAtRisk,
    paymentsDue,
    vehiclesUnavailable,
    overdueReturns,
    expiredDocuments,
    stockInconsistencies,
    insuranceExpiring,
    vignetteExpiring,
    technicalInspectionDue,
    oilChangeDue,
  ] = await Promise.all([
    checkDueMaintenances(user.tenantId),
    checkReturnsToday(user.tenantId),
    checkOverdueInvoices(user.tenantId),
    checkContractsAtRisk(user.tenantId),
    checkPaymentsDue(user.tenantId),
    checkVehiclesUnavailable(user.tenantId),
    checkOverdueReturns(user.tenantId),
    checkExpiredDocuments(user.tenantId),
    checkStockInconsistencies(user.tenantId),
    checkInsuranceExpiring(user.tenantId),
    checkVignetteExpiring(user.tenantId),
    checkTechnicalInspectionDue(user.tenantId),
    checkOilChangeDue(user.tenantId),
  ]);

  return NextResponse.json({
    created: {
      dueMaintenances: dueMaintenances.length,
      returnsToday: returnsToday.length,
      overdueInvoices: overdueInvoices.length,
      contractsAtRisk: contractsAtRisk.length,
      paymentsDue: paymentsDue.length,
      vehiclesUnavailable: vehiclesUnavailable.length,
      overdueReturns: overdueReturns.length,
      expiredDocuments: expiredDocuments.length,
      stockInconsistencies: stockInconsistencies.length,
      insuranceExpiring: insuranceExpiring.length,
      vignetteExpiring: vignetteExpiring.length,
      technicalInspectionDue: technicalInspectionDue.length,
      oilChangeDue: oilChangeDue.length,
    },
  });
}
