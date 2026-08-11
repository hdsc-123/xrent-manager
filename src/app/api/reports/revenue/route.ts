import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { getRevenueReport } from "@/lib/reports";

/**
 * Rapports financiers réservés à ADMIN (données agrégées sur tout le tenant, pas
 * seulement les agences d'un MEMBER) — décision prise en cours d'implémentation
 * (Sprint 6), pas explicitement validée au préalable, à confirmer (voir HANDOFF.md).
 */
export async function GET(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");

  if (!fromParam || !toParam) {
    return NextResponse.json({ error: "from et to sont requis." }, { status: 400 });
  }

  const from = new Date(fromParam);
  const to = new Date(toParam);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return NextResponse.json({ error: "from et to doivent être des dates ISO valides." }, { status: 400 });
  }

  const report = await getRevenueReport(user.tenantId, from, to);
  return NextResponse.json(report);
}
