import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { logAction } from "@/lib/audit";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_AUTHENTICATED_JSON_BODY_BYTES } from "@/lib/request-guards";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export async function GET() {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (!(await can(user, "agencies.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const agencies = await prisma.agency.findMany({ where: { tenantId: user.tenantId } });

  return NextResponse.json({ agencies });
}

interface CreateAgencyBody {
  name?: string;
  slug?: string;
  city?: string;
  address?: string;
  phone?: string;
  email?: string;
  managerName?: string;
  managerPhone?: string;
}

export async function POST(request: Request) {
  if (isRequestBodyTooLarge(request, MAX_AUTHENTICATED_JSON_BODY_BYTES)) {
    return requestBodyTooLargeResponse(MAX_AUTHENTICATED_JSON_BODY_BYTES);
  }

  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (!(await can(user, "agencies.create"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  let body: CreateAgencyBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { name } = body;
  const slug = body.slug ? slugify(body.slug) : name ? slugify(name) : "";

  if (!name || !slug) {
    return NextResponse.json({ error: "name est requis." }, { status: 400 });
  }

  try {
    const agency = await prisma.agency.create({
      data: {
        tenantId: user.tenantId,
        name,
        slug,
        city: body.city,
        address: body.address,
        phone: body.phone,
        email: body.email,
        managerName: body.managerName,
        managerPhone: body.managerPhone,
      },
    });

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "agency.created",
      resource: "Agency",
      resourceId: agency.id,
      metadata: { name: agency.name },
    });

    return NextResponse.json({ agency }, { status: 201 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "Ce slug d'agence est déjà utilisé pour ce tenant." },
        { status: 409 }
      );
    }

    console.error("Erreur lors de la création de l'agence :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
