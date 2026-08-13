import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/authz";

/**
 * Annuaire minimal (id + name uniquement, jamais email/role/passwordHash) du tenant courant —
 * ouvert à tout user authentifié (contrairement à GET /api/users, réservé ADMIN, HANDOFF.md
 * point 17) : nécessaire pour désigner un "responsable"/"employé" (véhicule en transfert ou en
 * déplacement, Sprint 14C) sans donner accès à l'annuaire complet (email/rôle) à un MEMBER.
 */
export async function GET() {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const users = await prisma.user.findMany({
    where: { tenantId: user.tenantId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ users });
}
