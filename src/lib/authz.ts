import { auth } from "@/lib/auth";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";

export type SessionUser = Session["user"];

/**
 * Point d'entrée unique pour récupérer l'utilisateur authentifié dans les route handlers.
 * Ne fait aucune vérification de rôle/tenant/agence — chaque route reste responsable
 * d'appliquer ses propres règles d'autorisation (SECURITY.md section 4).
 *
 * `role` est relu frais en base à chaque appel (Sprint 14A) : le JWT NextAuth (session
 * strategy "jwt", voir src/lib/auth.ts) fige `role` au login et ne le rafraîchit jamais
 * tout seul — sans cette relecture, un ADMIN rétrogradé par un autre ADMIN garderait un
 * accès ADMIN complet (y compris le contournement de can(), src/lib/permissions.ts) sur son
 * appareil déjà connecté jusqu'à expiration du JWT (30 jours). getEffectivePermissions()/
 * can() relisaient déjà la base à chaque appel ; seul `role` restait périmé. Ce correctif
 * est isolé ici plutôt que dans le callback jwt() de NextAuth pour ne pas ajouter de requête
 * base de données à src/proxy.ts (qui appelle auth() directement, sans passer par
 * getSessionUser(), et documente explicitement rester une vérification optimiste sans DB).
 * Si l'utilisateur n'existe plus (supprimé), la session est traitée comme inexistante —
 * déconnexion immédiate plutôt que d'attendre l'expiration naturelle du JWT.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();

  if (!session?.user) {
    return null;
  }

  const current = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });

  if (!current) {
    return null;
  }

  return { ...session.user, role: current.role };
}

/**
 * Un ADMIN a un accès transverse à toutes les agences de son tenant (SECURITY.md
 * section 2) ; un MEMBER doit être explicitement rattaché à l'agence via UserAgency.
 * Centralisé ici pour être réutilisé par toutes les routes scopées agence (agencies,
 * vehicles, locations).
 *
 * Vérifie systématiquement que l'agence appartient bien au tenant de l'utilisateur avant
 * tout — un ADMIN n'a un accès transverse qu'aux agences de *son* tenant, jamais à celles
 * d'un autre tenant, même en fournissant un agencyId arbitraire (SECURITY.md section 1).
 */
export async function canAccessAgency(user: SessionUser, agencyId: string): Promise<boolean> {
  const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { tenantId: true } });

  if (!agency || agency.tenantId !== user.tenantId) {
    return false;
  }

  if (user.role === "ADMIN") {
    return true;
  }

  const link = await prisma.userAgency.findUnique({
    where: { userId_agencyId: { userId: user.id, agencyId } },
  });

  return link !== null;
}

/** Liste des agencyId auxquelles ce user a accès (toutes celles du tenant pour un ADMIN). */
export async function getAccessibleAgencyIds(user: SessionUser): Promise<string[] | null> {
  if (user.role === "ADMIN") {
    return null; // null = pas de restriction, toutes les agences du tenant.
  }

  const links = await prisma.userAgency.findMany({
    where: { userId: user.id },
    select: { agencyId: true },
  });

  return links.map((link) => link.agencyId);
}
