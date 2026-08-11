import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/authz";

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

/**
 * Isolation multi-tenant (SECURITY.md section 1) : un ADMIN ne voit jamais que son
 * propre tenant ici, même si l'énoncé de la tâche parle de "lister les tenants" —
 * il n'existe aucun rôle plateforme/superadmin distinct de l'ADMIN d'un tenant dans
 * ce schéma (DOMAINRULES.md section 4, granularité des rôles À DÉCIDER). Un futur
 * rôle superadmin transverse devra être explicitement validé avant d'élargir ce GET.
 */
export async function GET() {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId } });

  return NextResponse.json({ tenants: tenant ? [tenant] : [] });
}

interface CreateTenantBody {
  name?: string;
  slug?: string;
}

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  let body: CreateTenantBody;
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
    const tenant = await prisma.tenant.create({ data: { name, slug } });
    return NextResponse.json({ tenant }, { status: 201 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json({ error: "Ce slug de tenant est déjà utilisé." }, { status: 409 });
    }

    console.error("Erreur lors de la création du tenant :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
