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

/**
 * Sprint 19 (DOMAINRULES.md section 37) : visibilité d'une réservation par agence de
 * départ/retour (pickupAgencyId/dropoffAgencyId, résolus côté serveur depuis le texte libre
 * pickupAgency/dropoffAgency — voir src/lib/reservations.ts, buildAgencyLookupMap). Un ADMIN
 * voit tout. Un MEMBER voit la réservation si l'une des deux agences résolues lui est
 * accessible. Si aucune des deux villes ne correspond à une agence réelle du tenant (texte
 * broker non reconnu, ou ambiguïté entre plusieurs agences), comportement antérieur à ce
 * sprint conservé : visible dès que reservations.view est accordé, pour ne pas régresser
 * l'import Excel/broker existant.
 */
export async function canAccessReservationAgencies(
  user: SessionUser,
  reservation: { pickupAgencyId: string | null; dropoffAgencyId: string | null }
): Promise<boolean> {
  if (reservation.pickupAgencyId === null && reservation.dropoffAgencyId === null) {
    return true;
  }

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  if (accessibleAgencyIds === null) {
    return true;
  }

  const accessible = new Set(accessibleAgencyIds);
  return (
    (reservation.pickupAgencyId !== null && accessible.has(reservation.pickupAgencyId)) ||
    (reservation.dropoffAgencyId !== null && accessible.has(reservation.dropoffAgencyId))
  );
}

/**
 * Sprint 19 : seule l'agence de départ (pickupAgencyId) peut modifier/convertir/supprimer une
 * réservation — l'agence d'arrivée ne peut que la consulter (canAccessReservationAgencies
 * ci-dessus). Si pickupAgencyId n'est pas résolu (texte broker non reconnu), comportement
 * antérieur conservé : n'importe quel titulaire de reservations.edit/convert peut agir.
 */
export async function canEditReservationAgency(
  user: SessionUser,
  reservation: { pickupAgencyId: string | null }
): Promise<boolean> {
  if (reservation.pickupAgencyId === null) {
    return true;
  }
  return canAccessAgency(user, reservation.pickupAgencyId);
}

/**
 * Sprint 19 : un contrat (Location) reste visible/gérable par son agence de rattachement
 * (agencyId, dérivée du véhicule) comme avant ce sprint, mais aussi par son agence de retour
 * (dropoffAgencyId, voir Location.dropoffAgencyId) quand elle diffère — permet à l'agence
 * d'arrivée de consulter le contrat et d'enregistrer la réception du véhicule (kilométrage/
 * statut) sans accès à l'agence de départ. Alimente aussi le widget "Retours" du dashboard
 * pour cette agence, voir src/app/dashboard/page.tsx.
 */
export async function canAccessLocationAgency(
  user: SessionUser,
  location: { agencyId: string; dropoffAgencyId: string | null }
): Promise<boolean> {
  if (await canAccessAgency(user, location.agencyId)) {
    return true;
  }
  return location.dropoffAgencyId !== null && canAccessAgency(user, location.dropoffAgencyId);
}
