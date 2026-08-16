import { NextResponse } from "next/server";
import { getSessionUser, canAccessLocationAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getLocationById } from "@/lib/locations";
import {
  getDamageById,
  updateDamage,
  DamageNotEditableError,
  InvalidDamageAmountError,
  InvalidDamageNatureError,
} from "@/lib/damages";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Un dégât n'a pas d'agencyId propre : la portée agence est vérifiée via le contrat
 * (Damage.locationId), même principe que canAccessLocationAgency pour la Location elle-même —
 * jamais une agence devinée à partir du seul véhicule (un dégât reste attaché à un contrat
 * précis, potentiellement retourné à l'agence de dropoff, pas seulement l'agence du véhicule). */
export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "damages.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const damage = await getDamageById(user.tenantId, id);
  if (!damage) {
    return NextResponse.json({ error: "Dégât introuvable." }, { status: 404 });
  }

  const location = await getLocationById(user.tenantId, damage.locationId);
  if (!location || !(await canAccessLocationAgency(user, location))) {
    return NextResponse.json({ error: "Dégât introuvable." }, { status: 404 });
  }

  return NextResponse.json({ damage });
}

interface UpdateDamageBody {
  nature?: unknown;
  description?: unknown;
  billableAmount?: unknown;
}

/**
 * Sprint 33 (DOMAINRULES.md section 48, objectif 4) — corrige nature/description/billableAmount
 * d'un dégât **tant qu'il n'a pas encore été facturé** (Damage.damageInvoiceId null) ; refusé
 * au-delà (DamageNotEditableError, 409) — voir src/lib/damages.ts, updateDamage. Jamais appliqué
 * par aucune route au Sprint 32 (la permission `damages.edit` existait au catalogue sans route,
 * comblé ici).
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "damages.edit"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const existing = await getDamageById(user.tenantId, id);
  if (!existing) {
    return NextResponse.json({ error: "Dégât introuvable." }, { status: 404 });
  }
  const location = await getLocationById(user.tenantId, existing.locationId);
  if (!location || !(await canAccessLocationAgency(user, location))) {
    return NextResponse.json({ error: "Dégât introuvable." }, { status: 404 });
  }

  let body: UpdateDamageBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.nature !== undefined && typeof body.nature !== "string") {
    return NextResponse.json({ error: "nature doit être une chaîne." }, { status: 400 });
  }
  if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
    return NextResponse.json({ error: "description doit être une chaîne." }, { status: 400 });
  }
  if (
    body.billableAmount !== undefined &&
    body.billableAmount !== null &&
    typeof body.billableAmount !== "number"
  ) {
    return NextResponse.json({ error: "billableAmount doit être un nombre." }, { status: 400 });
  }

  try {
    const updated = await updateDamage(user.tenantId, id, {
      nature: body.nature as string | undefined,
      description: body.description as string | null | undefined,
      billableAmount: body.billableAmount as number | null | undefined,
    });
    if (!updated) {
      return NextResponse.json({ error: "Dégât introuvable." }, { status: 404 });
    }

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "damage.updated",
      resource: "Damage",
      resourceId: updated.id,
      metadata: {
        previousNature: existing.nature,
        newNature: updated.nature,
        previousDescription: existing.description,
        newDescription: updated.description,
        previousBillableAmount: existing.billableAmount,
        newBillableAmount: updated.billableAmount,
      },
    });

    return NextResponse.json({ damage: updated });
  } catch (error) {
    if (error instanceof InvalidDamageNatureError || error instanceof InvalidDamageAmountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DamageNotEditableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la modification du dégât :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
