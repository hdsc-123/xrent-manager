import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { deleteAuditLogEntry, AuditLogNotFoundError } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Sprint 24-1 : suppression d'une entrée du journal d'audit — brief explicite du propriétaire
 * du projet. Double vérification requise, jamais l'une sans l'autre : role === "ADMIN" (comme le
 * reste du module audit, SECURITY.md section 4/13) ET can(user, "audit.delete") (permission
 * dédiée, src/lib/permissions.ts) — un non-ADMIN reste bloqué même si un groupe personnalisé lui
 * accorde cette clé ; un ADMIN sans la clé explicitement assignée reste néanmoins autorisé, can()
 * court-circuitant déjà sur le rôle avant toute consultation de PermissionGroup/UserPermission,
 * comme pour toute autre clé du catalogue (voir le commentaire sur audit.delete). Strictement
 * tenant-scopé (deleteAuditLogEntry revérifie tenantId avant suppression, jamais un id brut).
 */
export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN" || !(await can(user, "audit.delete"))) {
    return NextResponse.json({ error: "Accès réservé aux administrateurs disposant de la permission audit.delete." }, { status: 403 });
  }

  const { id } = await params;

  try {
    await deleteAuditLogEntry(user.tenantId, id, user.id);
  } catch (error) {
    if (error instanceof AuditLogNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }

  return NextResponse.json({ success: true });
}
