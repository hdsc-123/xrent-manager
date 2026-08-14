import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/authz";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function isForeignKeyConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2003"
  );
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;

  // Un tenant n'est jamais accessible en dehors du sien, y compris pour un ADMIN
  // (SECURITY.md section 1) — 404 plutôt que 403 pour ne pas confirmer l'existence
  // d'un tenant tiers (protection IDOR, SECURITY.md section 7).
  if (id !== user.tenantId) {
    return NextResponse.json({ error: "Tenant introuvable." }, { status: 404 });
  }

  const tenant = await prisma.tenant.findUnique({ where: { id } });

  if (!tenant) {
    return NextResponse.json({ error: "Tenant introuvable." }, { status: 404 });
  }

  return NextResponse.json({ tenant });
}

interface UpdateTenantBody {
  name?: string;
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;

  if (id !== user.tenantId) {
    return NextResponse.json({ error: "Tenant introuvable." }, { status: 404 });
  }

  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  let body: UpdateTenantBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (!body.name) {
    return NextResponse.json({ error: "name est requis." }, { status: 400 });
  }

  const tenant = await prisma.tenant.update({
    where: { id },
    data: {
      name: body.name,
    },
  });

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "tenant.updated",
    resource: "Tenant",
    resourceId: tenant.id,
    metadata: { changes: body } as unknown as Prisma.InputJsonValue,
  });

  return NextResponse.json({ tenant });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;

  if (id !== user.tenantId) {
    return NextResponse.json({ error: "Tenant introuvable." }, { status: 404 });
  }

  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  try {
    await prisma.tenant.delete({ where: { id } });
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      return NextResponse.json(
        { error: "Impossible de supprimer un tenant ayant des agences ou utilisateurs actifs." },
        { status: 409 }
      );
    }
    throw error;
  }

  return NextResponse.json({ success: true });
}
