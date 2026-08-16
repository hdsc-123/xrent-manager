import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getDamageInvoiceWithDetails } from "@/lib/damage-invoices";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Sprint 33 (DOMAINRULES.md section 48) — détail d'une facture de dégâts (lignes snapshot +
 * paiements), même principe de portée que GET /api/invoices/[id] : tenant-scopé
 * (getDamageInvoiceWithDetails filtre déjà tenantId), puis canAccessAgency sur agencyId,
 * jamais une seule vérification tenant sans l'agence (IDOR).
 */
export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "damage_invoices.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const damageInvoice = await getDamageInvoiceWithDetails(user.tenantId, id);
  if (!damageInvoice || !(await canAccessAgency(user, damageInvoice.agencyId))) {
    return NextResponse.json({ error: "Facture de dégâts introuvable." }, { status: 404 });
  }

  return NextResponse.json({ damageInvoice });
}
