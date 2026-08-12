import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { getUserById, updateUserRole, resetUserPassword, deleteUser, LastAdminError } from "@/lib/users";
import { validatePassword } from "@/lib/password-policy";
import { logAction } from "@/lib/audit";

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

  return NextResponse.json({
    user: { id: target.id, name: target.name, email: target.email, role: target.role, createdAt: target.createdAt },
  });
}

interface PatchUserBody {
  role?: string;
  password?: string;
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
    }
  } catch (error) {
    if (error instanceof LastAdminError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  const updated = await getUserById(user.tenantId, target.id);
  return NextResponse.json({
    user: { id: updated!.id, name: updated!.name, email: updated!.email, role: updated!.role },
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
