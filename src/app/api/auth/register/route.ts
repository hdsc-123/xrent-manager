import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { validatePassword } from "@/lib/password-policy";
import { ensureDefaultGroups } from "@/lib/permissions";
import { BCRYPT_COST } from "@/lib/bcrypt-cost";

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

  const passwordErrors = validatePassword(password);
  if (passwordErrors.length > 0) {
    return NextResponse.json({ error: passwordErrors[0], errors: passwordErrors }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

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

    try {
      await ensureDefaultGroups(tenant.id);
    } catch (error) {
      // Résilient par choix, même principe que logAction (src/lib/audit.ts) : les groupes
      // de permissions par défaut ne doivent jamais faire échouer l'inscription — ils
      // restent créables a posteriori depuis /dashboard/permission-groups (backfill
      // paresseux, voir ensureDefaultGroups).
      console.error("Erreur lors de la création des groupes de permissions par défaut :", error);
    }

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
