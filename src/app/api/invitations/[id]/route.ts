import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { getInvitationById, revokeInvitation } from "@/lib/invitations";
import { prisma } from "@/lib/prisma";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Publique (pas de getSessionUser) : l'invité n'a pas encore de compte dans ce tenant.
 * Ne renvoie que des champs non sensibles pour alimenter la page /invitations/[id].
 */
export async function GET(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  const invitation = await getInvitationById(id);

  if (!invitation) {
    return NextResponse.json({ error: "Invitation introuvable." }, { status: 404 });
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: invitation.tenantId }, select: { name: true } });

  return NextResponse.json({
    invitation: {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      tenantName: tenant?.name ?? "",
    },
  });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  const { id } = await params;
  const revoked = await revokeInvitation(user.tenantId, id);
  if (!revoked) {
    return NextResponse.json({ error: "Invitation introuvable ou déjà traitée." }, { status: 404 });
  }

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "invitation.revoked",
    resource: "Invitation",
    resourceId: id,
  });

  return NextResponse.json({ success: true });
}
