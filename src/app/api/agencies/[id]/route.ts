import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAgencyById } from "@/lib/db";
import { getSessionUser, canAccessAgency } from "@/lib/authz";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
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
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const agency = await getAgencyById(user.tenantId, id);

  if (!agency) {
    return NextResponse.json({ error: "Agence introuvable." }, { status: 404 });
  }

  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
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
    },
  });

  return NextResponse.json({ agency: updated });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const agency = await getAgencyById(user.tenantId, id);

  if (!agency) {
    return NextResponse.json({ error: "Agence introuvable." }, { status: 404 });
  }

  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
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

  return NextResponse.json({ success: true });
}
