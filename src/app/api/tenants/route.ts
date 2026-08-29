import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/authz";
import { isSuperAdminEmail } from "@/lib/super-admin";
import { validatePassword } from "@/lib/password-policy";
import { ensureDefaultGroups } from "@/lib/permissions";
import { BCRYPT_COST } from "@/lib/bcrypt-cost";
import { logAction } from "@/lib/audit";

/**
 * Isolation multi-tenant (SECURITY.md section 1) : un ADMIN ne voit jamais que son propre
 * tenant ici — même un Super Admin plateforme (voir POST ci-dessous) n'a par ce GET aucune
 * visibilité sur les tenants qu'il a créés au-delà du sien : la capacité Super Admin est
 * strictement la création (opération d'administration de plateforme, DOMAINRULES.md), jamais
 * un accès en lecture aux données d'un autre tenant (SECURITY.md section 1, inchangé).
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
 * Création d'un tenant — réservée au Super Admin plateforme (2026-08-29, révise la décision
 * antérieure d'auto-inscription publique, voir src/lib/super-admin.ts pour la justification
 * complète). Remplace l'ancien `POST /api/auth/register`, retiré : plus aucun visiteur non
 * authentifié ne peut créer un tenant. Double garde, même convention que `audit.delete`
 * (SECURITY.md section 13) : `role === "ADMIN"` **et** `isSuperAdminEmail(user.email)` —
 * jamais l'une sans l'autre. Un ADMIN de tenant ordinaire (non Super Admin) reçoit un 403,
 * identique à un MEMBER — la distinction n'est jamais révélée dans le message d'erreur.
 *
 * Crée le tenant et son premier utilisateur (ADMIN) atomiquement, exactement comme le faisait
 * l'ancien `POST /api/auth/register` — seule la garde d'accès change.
 */
export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (user.role !== "ADMIN" || !isSuperAdminEmail(user.email)) {
    return NextResponse.json(
      { error: "Accès réservé au Super Admin de la plateforme." },
      { status: 403 }
    );
  }

  let body: CreateTenantBody;
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
    const { tenant, newAdmin } = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: tenantName, slug: tenantSlug },
      });

      const newAdmin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email,
          name,
          passwordHash,
          role: "ADMIN",
        },
      });

      await logAction(
        {
          tenantId: tenant.id,
          userId: user.id,
          action: "tenant.created",
          resource: "tenant",
          resourceId: tenant.id,
          metadata: { createdBySuperAdminEmail: user.email, firstAdminEmail: newAdmin.email },
        },
        tx
      );

      return { tenant, newAdmin };
    });

    try {
      await ensureDefaultGroups(tenant.id);
    } catch (error) {
      // Résilient par choix, même principe que dans l'ancien /api/auth/register : les groupes
      // de permissions par défaut ne doivent jamais faire échouer la création du tenant.
      console.error("Erreur lors de la création des groupes de permissions par défaut :", error);
    }

    return NextResponse.json(
      {
        tenant,
        user: {
          id: newAdmin.id,
          tenantId: newAdmin.tenantId,
          email: newAdmin.email,
          name: newAdmin.name,
          role: newAdmin.role,
          createdAt: newAdmin.createdAt,
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

    console.error("Erreur lors de la création du tenant :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
