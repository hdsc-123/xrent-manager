import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/authz";

/**
 * Lecture seule pour ce sprint (voir HANDOFF.md, points À DÉCIDER 2 et 17) :
 * la modification de rôle et la suppression d'utilisateurs restent hors périmètre
 * tant que la granularité des permissions n'a pas été validée par le propriétaire
 * du projet. Réservé aux ADMIN (annuaire du tenant, données plus sensibles qu'une
 * liste d'agences). Ne sélectionne jamais `passwordHash`.
 */
export async function GET() {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  const users = await prisma.user.findMany({
    where: { tenantId: user.tenantId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ users });
}
