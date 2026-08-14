import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getInvoiceById } from "@/lib/invoices";
import { prisma } from "@/lib/prisma";
import { InvoicePdf } from "@/components/invoices/InvoicePdf";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "invoices.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const invoice = await getInvoiceById(user.tenantId, id);

  if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) {
    return NextResponse.json({ error: "Facture introuvable." }, { status: 404 });
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
    <InvoicePdf
      tenantName={tenant.name}
      agencyName={agency.name}
      invoiceNumber={invoice.number}
      contractNumber={location.contractNumber}
      status={invoice.status}
      issuedAt={invoice.issuedAt}
      dueDate={invoice.dueDate}
      clientName={client.name}
      clientEmail={client.email}
      clientPhone={client.phone}
      vehicleName={location.vehicle.name}
      vehicleLicensePlate={location.vehicle.licensePlate}
      locationStart={location.startDate}
      locationEnd={location.endDate}
      pricePerDay={location.pricePerDay}
      subtotal={invoice.subtotal}
      taxRate={invoice.taxRate}
      taxAmount={invoice.taxAmount}
      discountAmount={invoice.discountAmount}
      totalAmount={invoice.totalAmount}
      amountPaid={invoice.amountPaid}
      currency={invoice.currency}
      notes={invoice.notes}
    />
  );

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${invoice.number}.pdf"`,
    },
  });
}
