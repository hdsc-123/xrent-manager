import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAgencyById } from "@/lib/db";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (!(await can(user, "agencies.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const agency = await getAgencyById(user.tenantId, id);

  if (!agency) {
    return NextResponse.json({ error: "Agence introuvable." }, { status: 404 });
  }

  if (!(await canAccessAgency(user, agency.id))) {
    return NextResponse.json({ error: "Agence introuvable." }, { status: 404 });
  }

  return NextResponse.json({ agency });
}

interface UpdateAgencyBody {
  name?: string;
  city?: string;
  address?: string;
  phone?: string;
  email?: string;
  managerName?: string;
  managerPhone?: string;
  contractNumberPrefix?: string;
  lastContractNumber?: number;
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (!(await can(user, "agencies.edit"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const agency = await getAgencyById(user.tenantId, id);

  if (!agency) {
    return NextResponse.json({ error: "Agence introuvable." }, { status: 404 });
  }

  let body: UpdateAgencyBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.name !== undefined && !body.name) {
    return NextResponse.json({ error: "name ne peut pas être vide." }, { status: 400 });
  }

  if (
    body.lastContractNumber !== undefined &&
    (!Number.isInteger(body.lastContractNumber) || body.lastContractNumber < 0)
  ) {
    return NextResponse.json(
      { error: "lastContractNumber doit être un entier positif ou nul." },
      { status: 400 }
    );
  }

  const numberingChanged = body.contractNumberPrefix !== undefined || body.lastContractNumber !== undefined;

  const updated = await prisma.agency.update({
    where: { id: agency.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.city !== undefined ? { city: body.city } : {}),
      ...(body.address !== undefined ? { address: body.address } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.managerName !== undefined ? { managerName: body.managerName } : {}),
      ...(body.managerPhone !== undefined ? { managerPhone: body.managerPhone } : {}),
      ...(body.contractNumberPrefix !== undefined
        ? { contractNumberPrefix: body.contractNumberPrefix.trim() }
        : {}),
      ...(body.lastContractNumber !== undefined ? { lastContractNumber: body.lastContractNumber } : {}),
    },
  });

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "agency.updated",
    resource: "Agency",
    resourceId: agency.id,
    metadata: {
      changes: body,
      ...(numberingChanged
        ? {
            previousNumbering: {
              contractNumberPrefix: agency.contractNumberPrefix,
              lastContractNumber: agency.lastContractNumber,
            },
          }
        : {}),
    } as unknown as Prisma.InputJsonValue,
  });

  return NextResponse.json({ agency: updated });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (!(await can(user, "agencies.delete"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const agency = await getAgencyById(user.tenantId, id);

  if (!agency) {
    return NextResponse.json({ error: "Agence introuvable." }, { status: 404 });
  }

  try {
    await prisma.agency.delete({ where: { id: agency.id } });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2003"
    ) {
      return NextResponse.json(
        { error: "Impossible de supprimer une agence ayant des utilisateurs rattachés." },
        { status: 409 }
      );
    }
    throw error;
  }

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "agency.deleted",
    resource: "Agency",
    resourceId: agency.id,
    metadata: { name: agency.name },
  });

  return NextResponse.json({ success: true });
}
