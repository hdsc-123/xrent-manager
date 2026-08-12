import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { logAction } from "@/lib/audit";
import {
  ensureDefaultGroups,
  getPermissionGroups,
  createPermissionGroup,
  PermissionGroupNameInUseError,
} from "@/lib/permissions";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  await ensureDefaultGroups(user.tenantId);
  const groups = await getPermissionGroups(user.tenantId);
  return NextResponse.json({ groups });
}

interface CreateGroupBody {
  name?: string;
  permissions?: string[];
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  let body: CreateGroupBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (!body.name || body.name.trim() === "") {
    return NextResponse.json({ error: "name est requis." }, { status: 400 });
  }
  if (body.permissions !== undefined && !Array.isArray(body.permissions)) {
    return NextResponse.json({ error: "permissions doit être un tableau." }, { status: 400 });
  }

  try {
    const group = await createPermissionGroup({
      tenantId: user.tenantId,
      name: body.name,
      permissions: body.permissions ?? [],
    });

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "permission_group.created",
      resource: "PermissionGroup",
      resourceId: group.id,
      metadata: { name: group.name, permissions: group.permissions },
    });

    return NextResponse.json({ group }, { status: 201 });
  } catch (error) {
    if (error instanceof PermissionGroupNameInUseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la création du groupe de permissions :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
