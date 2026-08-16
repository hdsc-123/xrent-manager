import { NextResponse } from "next/server";
import type { DamageInvoiceStatus } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getDamageInvoices } from "@/lib/damage-invoices";

/**
 * Sprint 33 (DOMAINRULES.md section 48) — liste des factures de dégâts, scopée tenant + agences
 * accessibles (même principe que GET /api/invoices) : `getAccessibleAgencyIds` retourne `null`
 * pour un ADMIN (aucune restriction), sinon la liste des agences réellement accessibles à
 * l'appelant (`UserAgency`) — jamais un filtre appliqué côté client seul. Aucune route POST ici :
 * une DamageInvoice n'est jamais créée manuellement, uniquement de façon automatique (retour
 * d'un contrat ou déclaration d'un dégât facturable, voir POST /api/locations/[id]/return et
 * POST /api/damages).
 */
const DAMAGE_INVOICE_STATUSES: DamageInvoiceStatus[] = ["DRAFT", "SENT", "PARTIALLY_PAID", "PAID", "CANCELLED"];

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "damage_invoices.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get("status");
  const status =
    statusParam && DAMAGE_INVOICE_STATUSES.includes(statusParam as DamageInvoiceStatus)
      ? (statusParam as DamageInvoiceStatus)
      : undefined;
  const locationId = searchParams.get("locationId") ?? undefined;
  const clientId = searchParams.get("clientId") ?? undefined;
  const from = searchParams.get("from") ? new Date(searchParams.get("from") as string) : undefined;
  const to = searchParams.get("to") ? new Date(searchParams.get("to") as string) : undefined;

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);

  const damageInvoices = await getDamageInvoices(user.tenantId, {
    agencyIds: accessibleAgencyIds,
    status,
    locationId,
    clientId,
    from,
    to,
  });

  return NextResponse.json({ damageInvoices });
}
