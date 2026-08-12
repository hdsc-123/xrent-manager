import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { getAuditLogs } from "@/lib/audit";

/**
 * Liste du journal d'audit du tenant, réservée ADMIN (données sensibles sur l'activité
 * des utilisateurs). Voir src/lib/audit.ts pour le périmètre d'instrumentation actuel.
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
  const resource = searchParams.get("resource") ?? undefined;
  const action = searchParams.get("action") ?? undefined;
  const userId = searchParams.get("userId") ?? undefined;
  const fromParam = searchParams.get("from") ?? undefined;
  const toParam = searchParams.get("to") ?? undefined;

  const logs = await getAuditLogs(user.tenantId, {
    resource,
    action,
    userId,
    from: fromParam ? new Date(fromParam) : undefined,
    to: toParam ? new Date(toParam) : undefined,
  });

  return NextResponse.json({ logs });
}
