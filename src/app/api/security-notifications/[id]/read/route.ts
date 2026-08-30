import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { markSecurityNotificationRead } from "@/lib/security-notifications";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Politique MFA (2026-08-30, brief explicite du propriétaire du projet) : marque une seule
 * notification de sécurité comme lue — toujours scopée à (tenantId, userId) de la session,
 * jamais un id cible en dehors des propres notifications de l'appelant (voir
 * markSecurityNotificationRead, src/lib/security-notifications.ts, qui renvoie null plutôt que
 * de révéler l'existence d'une notification appartenant à un autre utilisateur).
 */
export async function PATCH(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const updated = await markSecurityNotificationRead(user.tenantId, user.id, id);
  if (!updated) {
    return NextResponse.json({ error: "Notification introuvable." }, { status: 404 });
  }

  return NextResponse.json({ notification: updated });
}
