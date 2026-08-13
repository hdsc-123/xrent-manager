import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import {
  DataResetInProgressError,
  DataResetNotAllowedInProductionError,
  InvalidResetConfirmationError,
  getDataResetSummary,
  resetTenantData,
} from "@/lib/data-reset";

/**
 * GET : aperçu (comptages réels) avant confirmation ; POST : exécute la réinitialisation.
 * Réservé ADMIN, toujours scopé au tenant de l'ADMIN connecté (jamais un tenant arbitraire —
 * aucun paramètre `tenantId` accepté en entrée, voir src/lib/data-reset.ts).
 */
export async function GET() {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  try {
    const summary = await getDataResetSummary(user.tenantId);
    return NextResponse.json(summary);
  } catch (error) {
    if (error instanceof DataResetNotAllowedInProductionError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}

interface DataResetBody {
  confirmTenantName?: string;
  includeAuditLog?: boolean;
}

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  let body: DataResetBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (!body.confirmTenantName) {
    return NextResponse.json({ error: "confirmTenantName est requis." }, { status: 400 });
  }

  try {
    const deleted = await resetTenantData({
      tenantId: user.tenantId,
      userId: user.id,
      confirmTenantName: body.confirmTenantName,
      includeAuditLog: body.includeAuditLog ?? false,
    });

    return NextResponse.json({ success: true, deleted });
  } catch (error) {
    if (error instanceof InvalidResetConfirmationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DataResetInProgressError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof DataResetNotAllowedInProductionError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}
