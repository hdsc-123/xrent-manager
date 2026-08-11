import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

interface RegisterBody {
  tenantName?: string;
  tenantSlug?: string;
  name?: string;
  email?: string;
  password?: string;
}

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
 * Crée un tenant et son premier utilisateur, ADMIN par défaut (voir décision Sprint 3).
 * Aucune invitation / auto-inscription supplémentaire n'est gérée ici — le cycle de vie
 * complet du tenant reste À DÉCIDER (DOMAINRULES.md section 1).
 */
export async function POST(request: Request) {
  let body: RegisterBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { tenantName, name, email, password } = body;
  const tenantSlug = body.tenantSlug
    ? slugify(body.tenantSlug)
    : tenantName
      ? slugify(tenantName)
      : "";

  if (!tenantName || !tenantSlug || !name || !email || !password) {
    return NextResponse.json(
      { error: "tenantName, name, email et password sont requis." },
      { status: 400 }
    );
  }

  if (password.length < 8) {
    return NextResponse.json(
      { error: "Le mot de passe doit contenir au moins 8 caractères." },
      { status: 400 }
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const { tenant, user } = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: tenantName, slug: tenantSlug },
      });

      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email,
          name,
          passwordHash,
          role: "ADMIN",
        },
      });

      return { tenant, user };
    });

    return NextResponse.json(
      {
        tenant,
        user: {
          id: user.id,
          tenantId: user.tenantId,
          email: user.email,
          name: user.name,
          role: user.role,
          createdAt: user.createdAt,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "Ce tenant ou cet email est déjà utilisé." },
        { status: 409 }
      );
    }

    console.error("Erreur lors de l'inscription :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
