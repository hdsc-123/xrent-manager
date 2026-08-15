import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";

/**
 * Annuaire minimal (id + name uniquement, jamais email/role/passwordHash) du tenant courant —
 * ouvert à tout user authentifié (contrairement à GET /api/users, réservé ADMIN, HANDOFF.md
 * point 17) : nécessaire pour désigner un "responsable"/"employé" (véhicule en transfert ou en
 * déplacement, Sprint 14C) sans donner accès à l'annuaire complet (email/rôle) à un MEMBER.
 *
 * Sprint 24 (correction) : jusqu'ici renvoyait tous les users du tenant sans distinction — un
 * agent d'une agence satellite voyait apparaître les responsables/agents de toutes les autres
 * agences/villes du tenant dans les formulaires de transfert/déplacement. Un ADMIN (accès
 * transverse, jamais restreint) continue de voir tout le tenant ; un non-ADMIN ne voit
 * désormais que les users rattachés (UserAgency) à une agence qui lui est accessible ou qui
 * partage la ville d'une de ses agences — plus lui-même, toujours inclus.
 */
export async function GET() {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);

  if (accessibleAgencyIds === null) {
    const users = await prisma.user.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    return NextResponse.json({ users });
  }

  const ownAgencies = await prisma.agency.findMany({
    where: { tenantId: user.tenantId, id: { in: accessibleAgencyIds } },
    select: { city: true },
  });
  const ownCities = Array.from(
    new Set(ownAgencies.map((agency) => agency.city?.trim().toLowerCase()).filter((city): city is string => !!city))
  );

  const visibleAgencies = await prisma.agency.findMany({
    where: {
      tenantId: user.tenantId,
      OR: [
        { id: { in: accessibleAgencyIds } },
        ...(ownCities.length > 0 ? [{ city: { in: ownCities, mode: "insensitive" as const } }] : []),
      ],
    },
    select: { id: true },
  });
  const visibleAgencyIds = visibleAgencies.map((agency) => agency.id);

  const users = await prisma.user.findMany({
    where: {
      tenantId: user.tenantId,
      OR: [{ id: user.id }, { userAgencies: { some: { agencyId: { in: visibleAgencyIds } } } }],
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ users });
}
