import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { deleteAuditLogEntries } from "@/lib/audit";

interface BulkDeleteBody {
  ids?: string[];
}

/**
 * Sprint 24-1 : suppression multiple d'entrées du journal d'audit — même garde double
 * (role === "ADMIN" ET can(user, "audit.delete")) que DELETE /api/audit/[id]/route.ts, voir son
 * commentaire pour le détail. `deleteAuditLogEntries` filtre déjà par tenantId : un id d'un
 * autre tenant glissé dans la liste est silencieusement ignoré, jamais supprimé.
 */
export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN" || !(await can(user, "audit.delete"))) {
    return NextResponse.json({ error: "Accès réservé aux administrateurs disposant de la permission audit.delete." }, { status: 403 });
  }

  let body: BulkDeleteBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (!Array.isArray(body.ids) || body.ids.length === 0 || !body.ids.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "ids doit être un tableau non vide d'identifiants." }, { status: 400 });
  }

  const deleted = await deleteAuditLogEntries(user.tenantId, body.ids, user.id);

  return NextResponse.json({ success: true, deleted });
}
