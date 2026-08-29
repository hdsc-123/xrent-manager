import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import {
  getUserById,
  updateUserRole,
  resetUserPassword,
  deleteUser,
  setUserAgencies,
  getUserAgencyIds,
  LastAdminError,
  InvalidAgencyError,
} from "@/lib/users";
import { validatePassword } from "@/lib/password-policy";
import { logAction } from "@/lib/audit";
import { stepUpRequiredAndMissing, STEP_UP_REQUIRED_MESSAGE } from "@/lib/mfa-session";

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

  const agencyIds = await getUserAgencyIds(target.id);

  return NextResponse.json({
    user: {
      id: target.id,
      name: target.name,
      email: target.email,
      role: target.role,
      createdAt: target.createdAt,
      agencyIds,
    },
  });
}

interface PatchUserBody {
  role?: string;
  password?: string;
  agencyIds?: string[];
}

export async function PATCH(request: Request, { params }: RouteParams) {
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

  let body: PatchUserBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.role !== undefined && body.role !== "ADMIN" && body.role !== "MEMBER") {
    return NextResponse.json({ error: "role doit être ADMIN ou MEMBER." }, { status: 400 });
  }

  if (body.password !== undefined) {
    const passwordErrors = validatePassword(body.password);
    if (passwordErrors.length > 0) {
      return NextResponse.json({ error: passwordErrors[0], errors: passwordErrors }, { status: 400 });
    }
  }

  if (body.agencyIds !== undefined && !Array.isArray(body.agencyIds)) {
    return NextResponse.json({ error: "agencyIds doit être un tableau." }, { status: 400 });
  }

  // Phase 3C MFA (périmètre : uniquement le changement de rôle) : step-up requis avant toute
  // mutation de cette requête si un changement de rôle est effectivement demandé — vérifié avant
  // le bloc try ci-dessous pour ne jamais laisser passer un changement de mot de passe/d'agences
  // bundlé dans la même requête pendant qu'un changement de rôle est bloqué (aucune mutation
  // partielle). Un compte sans MFA garde le comportement actuel (opt-in, src/lib/mfa-session.ts).
  if (body.role !== undefined && body.role !== target.role && (await stepUpRequiredAndMissing(user))) {
    return NextResponse.json({ error: STEP_UP_REQUIRED_MESSAGE }, { status: 403 });
  }

  try {
    if (body.role !== undefined && body.role !== target.role) {
      await updateUserRole(user.tenantId, target.id, body.role as "ADMIN" | "MEMBER");
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "user.role_changed",
        resource: "User",
        resourceId: target.id,
        metadata: { from: target.role, to: body.role },
      });
    }

    if (body.password !== undefined) {
      await resetUserPassword(user.tenantId, target.id, body.password);
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "user.password_reset",
        resource: "User",
        resourceId: target.id,
      });
    }

    if (body.agencyIds !== undefined) {
      await setUserAgencies(user.tenantId, target.id, body.agencyIds);
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "user.agencies_changed",
        resource: "User",
        resourceId: target.id,
        metadata: { agencyIds: body.agencyIds },
      });
    }
  } catch (error) {
    if (error instanceof LastAdminError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidAgencyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const updated = await getUserById(user.tenantId, target.id);
  const agencyIds = await getUserAgencyIds(target.id);
  return NextResponse.json({
    user: { id: updated!.id, name: updated!.name, email: updated!.email, role: updated!.role, agencyIds },
  });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
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

  try {
    await deleteUser(user.tenantId, target.id);
  } catch (error) {
    if (error instanceof LastAdminError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "user.deleted",
    resource: "User",
    resourceId: target.id,
    metadata: { email: target.email, role: target.role },
  });

  return NextResponse.json({ success: true });
}
