import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicleUtilizationReport, getTopVehicles } from "@/lib/reports";

/**
 * Sprint 15 : le contrôle strict ADMIN-only a été remplacé par can(user, "reports.view")
 * — la clé existe déjà dans le catalogue et est accordée par défaut à MEMBER/COMPTABILITÉ
 * (voir DEFAULT_GROUPS dans src/lib/permissions.ts), mais cette route l'ignorait jusqu'ici.
 * Un ADMIN passe toujours (can() court-circuite sur le rôle).
 */
export async function GET(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (!(await can(user, "reports.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const limitParam = searchParams.get("limit");

  if (!fromParam || !toParam) {
    return NextResponse.json({ error: "from et to sont requis." }, { status: 400 });
  }

  const from = new Date(fromParam);
  const to = new Date(toParam);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return NextResponse.json({ error: "from et to doivent être des dates ISO valides." }, { status: 400 });
  }

  const limit = limitParam ? Number(limitParam) : 5;
  if (!Number.isInteger(limit) || limit <= 0) {
    return NextResponse.json({ error: "limit doit être un entier positif." }, { status: 400 });
  }

  const [utilization, topVehicles] = await Promise.all([
    getVehicleUtilizationReport(user.tenantId, from, to),
    getTopVehicles(user.tenantId, limit),
  ]);

  return NextResponse.json({ utilization, topVehicles });
}
