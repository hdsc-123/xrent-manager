import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { listSecurityNotifications, countUnreadSecurityNotifications } from "@/lib/security-notifications";

/**
 * Politique MFA (2026-08-30, brief explicite du propriétaire du projet) : notifications de
 * sécurité de l'utilisateur connecté uniquement — jamais un id/userId fourni par le client, même
 * principe que GET /api/users/me. Un utilisateur ne peut jamais lire les notifications d'un
 * autre, contrôlé ici côté serveur (jamais l'interface seule).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const [notifications, unreadCount] = await Promise.all([
    listSecurityNotifications(user.tenantId, user.id),
    countUnreadSecurityNotifications(user.tenantId, user.id),
  ]);

  return NextResponse.json({ notifications, unreadCount });
}
