import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { getAlertById, acknowledgeAlert, InvalidAlertStatusTransitionError } from "@/lib/alerts";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const alert = await getAlertById(user.tenantId, id);

  // agencyId null = alerte diffusée à tout le tenant, visible/actionnable par tous.
  if (!alert || (alert.agencyId && !(await canAccessAgency(user, alert.agencyId)))) {
    return NextResponse.json({ error: "Alerte introuvable." }, { status: 404 });
  }

  try {
    const updated = await acknowledgeAlert(user.tenantId, alert.id, user.id);
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "alert.acknowledged",
      resource: "Alert",
      resourceId: alert.id,
      metadata: { type: alert.type },
    });
    return NextResponse.json({ alert: updated });
  } catch (error) {
    if (error instanceof InvalidAlertStatusTransitionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    console.error("Erreur lors de l'acquittement de l'alerte :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
