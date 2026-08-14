import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import {
  getAlertById,
  resolveAlert,
  InvalidAlertStatusTransitionError,
  InvalidAlertResolutionCostError,
} from "@/lib/alerts";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface ResolveBody {
  resolutionAction?: string;
  resolutionDate?: string;
  resolutionIntervenant?: string;
  resolutionCost?: number;
  resolutionCurrency?: string;
  nextDueDate?: string;
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "alerts.resolve"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const alert = await getAlertById(user.tenantId, id);

  if (!alert || (alert.agencyId && !(await canAccessAgency(user, alert.agencyId)))) {
    return NextResponse.json({ error: "Alerte introuvable." }, { status: 404 });
  }

  // Sprint 22 : formulaire de suivi optionnel — un corps vide reste accepté (résolution
  // "simple", comportement inchangé pour les alertes qui n'en ont pas besoin, ex. RETURN_TODAY).
  let body: ResolveBody = {};
  const rawBody = await request.text();
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
    }
  }

  const resolutionDate = body.resolutionDate ? new Date(body.resolutionDate) : undefined;
  if (resolutionDate && Number.isNaN(resolutionDate.getTime())) {
    return NextResponse.json({ error: "resolutionDate doit être une date ISO valide." }, { status: 400 });
  }
  const nextDueDate = body.nextDueDate ? new Date(body.nextDueDate) : undefined;
  if (nextDueDate && Number.isNaN(nextDueDate.getTime())) {
    return NextResponse.json({ error: "nextDueDate doit être une date ISO valide." }, { status: 400 });
  }

  try {
    const updated = await resolveAlert(user.tenantId, alert.id, user.id, {
      resolutionAction: body.resolutionAction,
      resolutionDate,
      resolutionIntervenant: body.resolutionIntervenant,
      resolutionCost: body.resolutionCost,
      resolutionCurrency: body.resolutionCurrency,
      nextDueDate,
    });
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "alert.resolved",
      resource: "Alert",
      resourceId: alert.id,
      metadata: { type: alert.type, ...body },
    });
    return NextResponse.json({ alert: updated });
  } catch (error) {
    if (error instanceof InvalidAlertStatusTransitionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidAlertResolutionCostError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("Erreur lors de la résolution de l'alerte :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
