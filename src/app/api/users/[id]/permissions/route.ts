import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { getSessionUser } from "@/lib/authz";
import { getUserById } from "@/lib/users";
import { logAction } from "@/lib/audit";
import { stepUpRequiredAndMissing, STEP_UP_REQUIRED_MESSAGE } from "@/lib/mfa-session";
import { createSecurityNotification } from "@/lib/security-notifications";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_AUTHENTICATED_JSON_BODY_BYTES } from "@/lib/request-guards";
import {
  ensureDefaultGroups,
  getUserPermissionsView,
  setUserPermissions,
  InvalidPermissionGroupError,
} from "@/lib/permissions";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  const { id } = await params;
  const target = await getUserById(user.tenantId, id);
  if (!target) {
    return NextResponse.json({ error: "Utilisateur introuvable." }, { status: 404 });
  }

  await ensureDefaultGroups(user.tenantId);
  const permissions = await getUserPermissionsView(user.tenantId, id);
  return NextResponse.json({ permissions });
}

interface PatchPermissionsBody {
  permissionGroupId?: string | null;
  individualPermissions?: string[];
}

export async function PATCH(request: Request, { params }: RouteParams) {
  if (isRequestBodyTooLarge(request, MAX_AUTHENTICATED_JSON_BODY_BYTES)) {
    return requestBodyTooLargeResponse(MAX_AUTHENTICATED_JSON_BODY_BYTES);
  }

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  const { id } = await params;
  const target = await getUserById(user.tenantId, id);
  if (!target) {
    return NextResponse.json({ error: "Utilisateur introuvable." }, { status: 404 });
  }

  // Phase 3C MFA : step-up requis avant toute mutation (opt-in, voir src/lib/mfa-session.ts).
  if (await stepUpRequiredAndMissing(user)) {
    return NextResponse.json({ error: STEP_UP_REQUIRED_MESSAGE }, { status: 403 });
  }

  let body: PatchPermissionsBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.individualPermissions !== undefined && !Array.isArray(body.individualPermissions)) {
    return NextResponse.json({ error: "individualPermissions doit être un tableau." }, { status: 400 });
  }

  try {
    const permissions = await setUserPermissions(user.tenantId, id, {
      permissionGroupId: body.permissionGroupId,
      individualPermissions: body.individualPermissions,
    });

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "user.permissions_changed",
      resource: "User",
      resourceId: id,
      metadata: { changes: body } as unknown as Prisma.InputJsonValue,
    });

    // Politique MFA (2026-08-30) : notification de sécurité pour la cible.
    await createSecurityNotification({
      tenantId: user.tenantId,
      userId: id,
      type: "ROLE_OR_PERMISSIONS_CHANGED",
    });

    return NextResponse.json({ permissions });
  } catch (error) {
    if (error instanceof InvalidPermissionGroupError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Erreur lors de la modification des permissions de l'utilisateur :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
