import { NextResponse } from "next/server";
import { getSessionUser, type SessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getAuditLogCount, purgeAuditLog, logAction } from "@/lib/audit";
import { stepUpRequiredAndMissing, STEP_UP_REQUIRED_MESSAGE } from "@/lib/mfa-session";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_AUTHENTICATED_JSON_BODY_BYTES } from "@/lib/request-guards";

/**
 * Sprint 24-1 : purge complète du journal d'audit du tenant courant — la suppression la plus
 * destructrice des trois (unité/masse/purge), donc la plus protégée : même garde double que
 * DELETE /api/audit/[id]/route.ts (role === "ADMIN" ET can(user, "audit.delete")), plus une
 * confirmation par saisie exacte du nom du tenant, même mécanisme que POST /api/data-reset
 * (src/lib/data-reset.ts) — pour un geste de cette gravité, une simple boîte de dialogue
 * "Confirmer/Annuler" est jugée insuffisante, cohérent avec le principe déjà en vigueur ailleurs
 * dans l'application pour la purge de données.
 */
async function requireAuditDeleteAccess(): Promise<SessionUser | NextResponse> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN" || !(await can(user, "audit.delete"))) {
    return NextResponse.json(
      { error: "Accès réservé aux administrateurs disposant de la permission audit.delete." },
      { status: 403 }
    );
  }
  return user;
}

/** Aperçu avant confirmation — nom du tenant (affiché dans la boîte de dialogue) et nombre d'entrées à purger. */
export async function GET() {
  const access = await requireAuditDeleteAccess();
  if (access instanceof NextResponse) return access;
  const user = access;

  const [tenant, count] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId }, select: { name: true } }),
    getAuditLogCount(user.tenantId),
  ]);

  return NextResponse.json({ tenantName: tenant.name, count });
}

interface PurgeAuditLogBody {
  confirmTenantName?: string;
}

export async function POST(request: Request) {
  if (isRequestBodyTooLarge(request, MAX_AUTHENTICATED_JSON_BODY_BYTES)) {
    return requestBodyTooLargeResponse(MAX_AUTHENTICATED_JSON_BODY_BYTES);
  }

  const access = await requireAuditDeleteAccess();
  if (access instanceof NextResponse) return access;
  const user = access;

  // Phase 3C MFA : step-up requis avant toute mutation (opt-in, voir src/lib/mfa-session.ts) —
  // uniquement sur POST (la purge elle-même), jamais sur GET ci-dessus (simple aperçu en lecture,
  // aucune mutation).
  if (await stepUpRequiredAndMissing(user)) {
    return NextResponse.json({ error: STEP_UP_REQUIRED_MESSAGE }, { status: 403 });
  }

  let body: PurgeAuditLogBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId }, select: { name: true } });

  if (body.confirmTenantName !== tenant.name) {
    // Sprint 24-1 : même principe que data.reset_failed (src/lib/data-reset.ts, Sprint 16) — une
    // tentative de purge avec une confirmation invalide laisse une trace, sans jamais journaliser
    // le nom réellement saisi (pas nécessaire au diagnostic, SECURITY.md section 12).
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "audit.purge_failed",
      resource: "AuditLog",
      metadata: { reason: "invalid_confirmation" },
    });
    return NextResponse.json({ error: "Le nom saisi ne correspond pas au nom du tenant." }, { status: 400 });
  }

  const deleted = await purgeAuditLog(user.tenantId, user.id);

  return NextResponse.json({ success: true, deleted });
}
