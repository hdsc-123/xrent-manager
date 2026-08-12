import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { checkDueMaintenances, checkReturnsToday, checkOverdueInvoices } from "@/lib/scheduled-tasks";

/**
 * Déclenche les trois vérifications pour le tenant de l'ADMIN connecté (aucun rôle
 * "superadmin" transverse n'existe — HANDOFF.md section 8 point 16 — donc pas de scan
 * multi-tenant global ici ; un vrai cron devrait itérer les tenants avec un mécanisme
 * d'authentification dédié, hors périmètre de ce sprint). Réservé ADMIN, même
 * justification pragmatique que pour /api/reports/* (HANDOFF.md, décision Sprint 6).
 */
export async function POST() {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Réservé aux administrateurs." }, { status: 403 });
  }

  const [dueMaintenances, returnsToday, overdueInvoices] = await Promise.all([
    checkDueMaintenances(user.tenantId),
    checkReturnsToday(user.tenantId),
    checkOverdueInvoices(user.tenantId),
  ]);

  return NextResponse.json({
    created: {
      dueMaintenances: dueMaintenances.length,
      returnsToday: returnsToday.length,
      overdueInvoices: overdueInvoices.length,
    },
  });
}
