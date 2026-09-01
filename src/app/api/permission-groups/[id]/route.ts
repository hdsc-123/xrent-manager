import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { getSessionUser } from "@/lib/authz";
import { logAction } from "@/lib/audit";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_AUTHENTICATED_JSON_BODY_BYTES } from "@/lib/request-guards";
import {
  getPermissionGroupById,
  updatePermissionGroup,
  deletePermissionGroup,
  PermissionGroupNameInUseError,
  PermissionGroupHasUsersError,
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
  const group = await getPermissionGroupById(user.tenantId, id);
  if (!group) {
    return NextResponse.json({ error: "Groupe de permissions introuvable." }, { status: 404 });
  }

  return NextResponse.json({ group });
}

interface PatchGroupBody {
  name?: string;
  permissions?: string[];
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

  let body: PatchGroupBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.name !== undefined && body.name.trim() === "") {
    return NextResponse.json({ error: "name ne peut pas être vide." }, { status: 400 });
  }
  if (body.permissions !== undefined && !Array.isArray(body.permissions)) {
    return NextResponse.json({ error: "permissions doit être un tableau." }, { status: 400 });
  }

  try {
    const group = await updatePermissionGroup(user.tenantId, id, {
      name: body.name,
      permissions: body.permissions,
    });
    if (!group) {
      return NextResponse.json({ error: "Groupe de permissions introuvable." }, { status: 404 });
    }

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "permission_group.updated",
      resource: "PermissionGroup",
      resourceId: group.id,
      metadata: { changes: body } as unknown as Prisma.InputJsonValue,
    });

    return NextResponse.json({ group });
  } catch (error) {
    if (error instanceof PermissionGroupNameInUseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la modification du groupe de permissions :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
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

  try {
    const deleted = await deletePermissionGroup(user.tenantId, id);
    if (!deleted) {
      return NextResponse.json({ error: "Groupe de permissions introuvable." }, { status: 404 });
    }
  } catch (error) {
    if (error instanceof PermissionGroupHasUsersError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la suppression du groupe de permissions :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "permission_group.deleted",
    resource: "PermissionGroup",
    resourceId: id,
  });

  return NextResponse.json({ success: true });
}
