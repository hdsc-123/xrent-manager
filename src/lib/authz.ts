import { auth } from "@/lib/auth";
import type { Session } from "next-auth";

export type SessionUser = Session["user"];

/**
 * Point d'entrée unique pour récupérer l'utilisateur authentifié dans les route handlers.
 * Ne fait aucune vérification de rôle/tenant/agence — chaque route reste responsable
 * d'appliquer ses propres règles d'autorisation (SECURITY.md section 4).
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();

  if (!session?.user) {
    return null;
  }

  return session.user;
}
