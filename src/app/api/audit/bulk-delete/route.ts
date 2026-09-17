import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { deleteAuditLogEntries } from "@/lib/audit";
import { stepUpRequiredAndMissing, stepUpRequiredResponse } from "@/lib/mfa-session";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_AUTHENTICATED_JSON_BODY_BYTES } from "@/lib/request-guards";

interface BulkDeleteBody {
  ids?: string[];
}

/**
 * Sprint 24-1 : suppression multiple d'entrées du journal d'audit — même garde double
 * (role === "ADMIN" ET can(user, "audit.delete")) que DELETE /api/audit/[id]/route.ts, voir son
 * commentaire pour le détail. `deleteAuditLogEntries` filtre déjà par tenantId : un id d'un
 * autre tenant glissé dans la liste est silencieusement ignoré, jamais supprimé.
 *
 * Correctif (revue OWASP Phase 6, 2026-08-31) : `ids` n'était borné par aucune limite haute,
 * contrairement à `POST /api/documents/batch-pdf` (`MAX_BATCH_SIZE = 500`) qui traite le même
 * genre de sélection multiple — un tableau disproportionné (des dizaines/centaines de milliers
 * d'identifiants) atteignait directement `prisma.auditLog.deleteMany({ where: { id: { in: ids },
 * tenantId } })`, une clause SQL `IN (...)` non bornée. Même plafond réutilisé par cohérence.
 */
const MAX_BULK_DELETE_SIZE = 500;
export async function POST(request: Request) {
  if (isRequestBodyTooLarge(request, MAX_AUTHENTICATED_JSON_BODY_BYTES)) {
    return requestBodyTooLargeResponse(MAX_AUTHENTICATED_JSON_BODY_BYTES);
  }

  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN" || !(await can(user, "audit.delete"))) {
    return NextResponse.json({ error: "Accès réservé aux administrateurs disposant de la permission audit.delete." }, { status: 403 });
  }

  // Phase 3C MFA : step-up requis avant toute mutation (opt-in, voir src/lib/mfa-session.ts).
  if (await stepUpRequiredAndMissing(user)) {
    return stepUpRequiredResponse();
  }

  let body: BulkDeleteBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (
    !Array.isArray(body.ids) ||
    body.ids.length === 0 ||
    !body.ids.every((id) => typeof id === "string" && id.trim() !== "")
  ) {
    return NextResponse.json(
      { error: "ids doit être un tableau non vide d'identifiants non vides." },
      { status: 400 }
    );
  }

  if (body.ids.length > MAX_BULK_DELETE_SIZE) {
    return NextResponse.json(
      { error: `La sélection ne peut pas dépasser ${MAX_BULK_DELETE_SIZE} entrées.` },
      { status: 400 }
    );
  }

  const deleted = await deleteAuditLogEntries(user.tenantId, body.ids, user.id);

  return NextResponse.json({ success: true, deleted });
}
