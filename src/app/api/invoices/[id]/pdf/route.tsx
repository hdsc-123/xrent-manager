import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getInvoiceById, getInvoiceNetAmounts, getCreditNoteRefundableAmount } from "@/lib/invoices";
import { prisma } from "@/lib/prisma";
import { InvoicePdf } from "@/components/invoices/InvoicePdf";
import { CreditNotePdf } from "@/components/invoices/CreditNotePdf";

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

  // Sous-phase 2c2-D : un avoir (CREDIT_NOTE) ne doit jamais être rendu avec le gabarit facture
  // ordinaire ci-dessous (InvoicePdf) — il n'a ni jours de location, ni prix/jour, ni "solde dû"
  // au sens d'une facture à encaisser. Gabarit dédié (CreditNotePdf), tous les montants dérivés
  // recalculés en lecture seule via les mêmes fonctions que le reste du module (jamais une
  // formule réimplémentée ici) — cette route ne mute jamais rien (aucun tx.invoice.update,
  // aucune CashEntry, aucun remboursement déclenché par un simple téléchargement de PDF).
  if (invoice.type === "CREDIT_NOTE") {
    if (!invoice.originalInvoiceId) {
      return NextResponse.json({ error: "Facture source de l'avoir introuvable." }, { status: 500 });
    }
    const source = await prisma.invoice.findUnique({ where: { id: invoice.originalInvoiceId } });
    if (!source) {
      return NextResponse.json({ error: "Facture source de l'avoir introuvable." }, { status: 500 });
    }

    const [tenant, agency, location, client, { refundableAmount, totalRefundedForCreditNote }, sourceNetAmounts] =
      await Promise.all([
        prisma.tenant.findUnique({ where: { id: invoice.tenantId }, select: { name: true } }),
        prisma.agency.findUnique({ where: { id: invoice.agencyId }, select: { name: true } }),
        prisma.location.findUnique({ where: { id: invoice.locationId } }),
        prisma.client.findUnique({ where: { id: invoice.clientId } }),
        getCreditNoteRefundableAmount(invoice, source),
        getInvoiceNetAmounts(source),
      ]);

    if (!tenant || !agency || !location || !client) {
      return NextResponse.json({ error: "Données de facture incomplètes." }, { status: 500 });
    }

    const buffer = await renderToBuffer(
      <CreditNotePdf
        tenantName={tenant.name}
        agencyName={agency.name}
        creditNoteNumber={invoice.number}
        issuedAt={invoice.issuedAt}
        reason={invoice.reason}
        totalAmount={invoice.totalAmount}
        currency={invoice.currency}
        contractNumber={location.contractNumber}
        clientName={client.name}
        clientEmail={client.email}
        clientPhone={client.phone}
        sourceInvoiceNumber={source.number}
        sourceTotalAmount={source.totalAmount}
        sourceAmountPaid={source.amountPaid}
        sourceCreditedAmount={sourceNetAmounts.creditedAmount}
        sourceNetAmount={sourceNetAmounts.netAmount}
        refundedAmount={totalRefundedForCreditNote}
        refundableAmount={refundableAmount}
      />
    );

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${invoice.number}.pdf"`,
      },
    });
  }

  const [tenant, agency, location, client, replacedInvoice] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: invoice.tenantId }, select: { name: true } }),
    prisma.agency.findUnique({ where: { id: invoice.agencyId }, select: { name: true } }),
    prisma.location.findUnique({ where: { id: invoice.locationId }, include: { vehicle: true } }),
    prisma.client.findUnique({ where: { id: invoice.clientId } }),
    // Sprint 26E : numéro de la facture immédiatement remplacée par celle-ci (null sur une
    // facture jamais versionnée), affiché sur le PDF.
    invoice.replacesInvoiceId
      ? prisma.invoice.findUnique({ where: { id: invoice.replacesInvoiceId }, select: { number: true } })
      : Promise.resolve(null),
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
      versionNumber={invoice.versionNumber}
      replacesInvoiceNumber={replacedInvoice?.number ?? null}
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
