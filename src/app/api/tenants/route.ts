import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/authz";

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
