import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { markAllSecurityNotificationsRead } from "@/lib/security-notifications";

/**
 * Politique MFA (2026-08-30, brief explicite du propriétaire du projet) : marque toutes les
 * notifications de sécurité non lues de l'utilisateur connecté comme lues — jamais un autre
 * utilisateur, jamais un id fourni par le client.
 */
export async function POST() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const count = await markAllSecurityNotificationsRead(user.tenantId, user.id);
  return NextResponse.json({ markedCount: count });
}
