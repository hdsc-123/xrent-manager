import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getDamageInvoiceWithDetails } from "@/lib/damage-invoices";
import { prisma } from "@/lib/prisma";
import { DamageInvoicePdf } from "@/components/damage-invoices/DamageInvoicePdf";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Sprint 33 (DOMAINRULES.md section 48) — PDF privé d'une facture de dégâts, même patron que
 * GET /api/invoices/[id]/pdf : authentifié, gated par une permission dédiée
 * (`damage_invoices.export`, distincte de `.view` — décision explicite du propriétaire du
 * projet pour ce module), scopé tenant + agence (canAccessAgency) — jamais exposé publiquement
 * (SECURITY.md section 9 « ne jamais exposer les PDF publiquement »).
 */
export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "damage_invoices.export"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const invoice = await getDamageInvoiceWithDetails(user.tenantId, id);

  if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) {
    return NextResponse.json({ error: "Facture de dégâts introuvable." }, { status: 404 });
  }

  const [tenant, agency, location, client] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: invoice.tenantId }, select: { name: true } }),
    prisma.agency.findUnique({ where: { id: invoice.agencyId }, select: { name: true } }),
    prisma.location.findUnique({ where: { id: invoice.locationId }, include: { vehicle: true } }),
    prisma.client.findUnique({ where: { id: invoice.clientId } }),
  ]);

  if (!tenant || !agency || !location || !client) {
    return NextResponse.json({ error: "Données de facture incomplètes." }, { status: 500 });
  }

  const buffer = await renderToBuffer(
    <DamageInvoicePdf
      tenantName={tenant.name}
      agencyName={agency.name}
      invoiceNumber={invoice.number}
      contractNumber={location.contractNumber}
      status={invoice.status}
      issuedAt={invoice.issuedAt}
      clientName={client.name}
      clientEmail={client.email}
      clientPhone={client.phone}
      vehicleName={location.vehicle.name}
      vehicleLicensePlate={location.vehicle.licensePlate}
      lines={invoice.lines.map((line) => ({
        nature: line.nature,
        description: line.description,
        billableAmount: line.billableAmount,
      }))}
      subtotal={invoice.subtotal}
      totalAmount={invoice.totalAmount}
      amountPaid={invoice.amountPaid}
      currency={invoice.currency}
      notes={invoice.notes}
    />
  );

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${invoice.number.replace(/\//g, "-")}.pdf"`,
    },
  });
}
