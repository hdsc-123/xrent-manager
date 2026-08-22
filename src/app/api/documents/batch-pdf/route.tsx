import { NextResponse } from "next/server";
import { Document, renderToBuffer } from "@react-pdf/renderer";
import { getSessionUser, getAccessibleAgencyIds, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { ContractPdfPage } from "@/components/contracts/ContractPdf";
import { InvoicePdfPage } from "@/components/invoices/InvoicePdf";

type BatchType = "CONTRACT" | "INVOICE";

interface BatchPdfBody {
  type?: BatchType;
  ids?: string[];
  from?: string;
  to?: string;
  contractNumberFrom?: number;
  contractNumberTo?: number;
  /** Sprint 15 : requis pour la sélection par plage de numéros — la numérotation
   * (préfixe + compteur) est désormais par agence (DOMAINRULES.md section 29), une plage
   * numérique seule n'est plus interprétable sans savoir de quelle agence elle provient. */
  agencyId?: string;
}

/**
 * Génère un unique PDF regroupant plusieurs contrats ou factures (Sprint 14B, DOMAINRULES.md
 * section 29) — sélection par identifiants explicites, par plage de dates, ou (contrats
 * uniquement) par plage de numéros de contrat. Exactement un mode de sélection à la fois.
 * Chaque document est une simple page @react-pdf/renderer (ContractPdfPage/InvoicePdfPage,
 * extraites de leur <Document> habituel) assemblée dans un seul <Document> — même rendu que
 * le PDF unitaire, juste concaténé. Portée : mêmes règles de visibilité que les pages de liste
 * /dashboard/locations et /dashboard/invoices — un MEMBER ne voit que les documents de ses
 * agences accessibles (`getAccessibleAgencyIds`/`canAccessAgency`).
 * Correctif Sprint 16 (audit sécurité) : `can(user, "locations.view")`/`can(user,
 * "invoices.view")` est désormais vérifié comme sur toutes les autres routes de ces modules
 * (`GET /api/locations`, `GET /api/invoices`, `GET /api/locations/[id]/pdf`, `GET
 * /api/invoices/[id]/pdf`) — ce commentaire affirmait auparavant à tort qu'aucune permission
 * granulaire ne s'appliquait à ces modules, une justification obsolète antérieure au retrofit
 * de portée du Sprint 15 (DOMAINRULES.md section 22), jamais mise à jour pour cette route.
 */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  let body: BatchPdfBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.type !== "CONTRACT" && body.type !== "INVOICE") {
    return NextResponse.json({ error: "type doit être CONTRACT ou INVOICE." }, { status: 400 });
  }

  const requiredPermission = body.type === "CONTRACT" ? "locations.view" : "invoices.view";
  if (!(await can(user, requiredPermission))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  // Sprint 16 (audit sécurité) : plafond partagé avec MAX_NUMBER_RANGE ci-dessous — les modes
  // "identifiants" et "plage de dates" n'avaient jusqu'ici aucune limite, contrairement au mode
  // "plage de numéros" (déjà plafonné), ouvrant un risque de génération PDF disproportionnée
  // (CPU/mémoire) par un seul appelant authentifié.
  const MAX_BATCH_SIZE = 500;

  const hasIds = Array.isArray(body.ids) && body.ids.length > 0;
  const hasDateRange = Boolean(body.from || body.to);
  const hasNumberRange = body.contractNumberFrom !== undefined || body.contractNumberTo !== undefined;

  if (hasIds && body.ids!.length > MAX_BATCH_SIZE) {
    return NextResponse.json(
      { error: `La sélection par identifiants ne peut pas dépasser ${MAX_BATCH_SIZE} documents.` },
      { status: 400 }
    );
  }

  if (hasNumberRange && body.type !== "CONTRACT") {
    return NextResponse.json(
      { error: "La sélection par plage de numéros n'est disponible que pour les contrats." },
      { status: 400 }
    );
  }

  const selectionModes = [hasIds, hasDateRange, hasNumberRange].filter(Boolean).length;
  if (selectionModes !== 1) {
    return NextResponse.json(
      {
        error:
          "Choisissez exactement un mode de sélection : identifiants, plage de dates, ou " +
          "(contrats uniquement) plage de numéros de contrat.",
      },
      { status: 400 }
    );
  }

  const from = body.from ? new Date(body.from) : undefined;
  const to = body.to ? new Date(body.to) : undefined;
  if ((body.from && Number.isNaN(from?.getTime())) || (body.to && Number.isNaN(to?.getTime()))) {
    return NextResponse.json({ error: "from/to doivent être des dates ISO valides." }, { status: 400 });
  }

  if (
    hasNumberRange &&
    (body.contractNumberFrom === undefined ||
      body.contractNumberTo === undefined ||
      !Number.isInteger(body.contractNumberFrom) ||
      !Number.isInteger(body.contractNumberTo) ||
      body.contractNumberFrom < 0 ||
      body.contractNumberTo < body.contractNumberFrom)
  ) {
    return NextResponse.json(
      { error: "contractNumberFrom/contractNumberTo doivent être des entiers valides (from <= to)." },
      { status: 400 }
    );
  }
  if (hasNumberRange && body.contractNumberTo! - body.contractNumberFrom! + 1 > MAX_BATCH_SIZE) {
    return NextResponse.json(
      { error: `La plage de numéros ne peut pas dépasser ${MAX_BATCH_SIZE} contrats.` },
      { status: 400 }
    );
  }

  if (hasNumberRange && !body.agencyId) {
    return NextResponse.json(
      { error: "agencyId est requis pour la sélection par plage de numéros de contrat." },
      { status: 400 }
    );
  }

  let numberRangeAgency: { id: string; contractNumberPrefix: string } | null = null;
  if (hasNumberRange) {
    if (!(await canAccessAgency(user, body.agencyId!))) {
      return NextResponse.json({ error: "Agence introuvable ou inaccessible." }, { status: 404 });
    }
    numberRangeAgency = await prisma.agency.findFirst({
      where: { id: body.agencyId, tenantId: user.tenantId },
      select: { id: true, contractNumberPrefix: true },
    });
    if (!numberRangeAgency) {
      return NextResponse.json({ error: "Agence introuvable ou inaccessible." }, { status: 404 });
    }
  }

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const agencyScope = accessibleAgencyIds ? { agencyId: { in: accessibleAgencyIds } } : {};

  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { name: true },
  });
  if (!tenant) {
    return NextResponse.json({ error: "Tenant introuvable." }, { status: 404 });
  }

  if (body.type === "CONTRACT") {
    let contractNumbers: string[] | undefined;
    if (hasNumberRange) {
      contractNumbers = [];
      for (let n = body.contractNumberFrom!; n <= body.contractNumberTo!; n++) {
        const padded = String(n).padStart(5, "0");
        contractNumbers.push(
          numberRangeAgency!.contractNumberPrefix
            ? `${numberRangeAgency!.contractNumberPrefix}-${padded}`
            : padded
        );
      }
    }

    const locations = await prisma.location.findMany({
      where: {
        tenantId: user.tenantId,
        ...agencyScope,
        ...(hasNumberRange ? { agencyId: numberRangeAgency!.id } : {}),
        contractNumber: { not: null },
        ...(hasIds ? { id: { in: body.ids } } : {}),
        ...(hasDateRange
          ? {
              ...(from ? { startDate: { gte: from } } : {}),
              ...(to ? { startDate: { lte: to } } : {}),
            }
          : {}),
        ...(contractNumbers ? { contractNumber: { in: contractNumbers } } : {}),
      },
      include: { vehicle: true, client: true },
      orderBy: { contractNumber: "asc" },
      take: MAX_BATCH_SIZE + 1,
    });

    if (locations.length === 0) {
      return NextResponse.json({ error: "Aucun contrat ne correspond à cette sélection." }, { status: 404 });
    }
    if (locations.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `Cette sélection dépasse ${MAX_BATCH_SIZE} contrats — affinez la plage de dates.` },
        { status: 400 }
      );
    }

    const agencies = await prisma.agency.findMany({
      where: { id: { in: [...new Set(locations.map((location) => location.agencyId))] } },
      select: { id: true, name: true },
    });
    const agencyNameById = new Map(agencies.map((agency) => [agency.id, agency.name]));

    const buffer = await renderToBuffer(
      <Document title={`Lot de contrats (${locations.length})`}>
        {locations.map((location) => (
          <ContractPdfPage
            key={location.id}
            tenantName={tenant.name}
            agencyName={agencyNameById.get(location.agencyId) ?? "—"}
            contractNumber={location.contractNumber as string}
            status={location.status}
            createdAt={location.createdAt}
            clientName={location.client.name}
            clientEmail={location.client.email}
            clientPhone={location.client.phone}
            clientIdNumber={location.client.idNumber}
            clientLicenseNumber={location.client.licenseNumber}
            vehicleName={location.vehicle.name}
            vehicleLicensePlate={location.vehicle.licensePlate}
            locationStart={location.startDate}
            locationEnd={location.endDate}
            pricePerDay={location.pricePerDay}
            totalPrice={location.totalPrice}
            deposit={location.deposit}
            startOdometer={location.startOdometer}
            endOdometer={location.endOdometer}
            currency={location.currency}
            notes={location.notes}
          />
        ))}
      </Document>
    );

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="lot-contrats.pdf"`,
      },
    });
  }

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId: user.tenantId,
      ...agencyScope,
      // Sous-phase 2c2-D : un avoir (CREDIT_NOTE) n'est jamais éligible au lot PDF, même fourni
      // explicitement par `ids` — InvoicePdfPage ci-dessous rend un gabarit "facture locative"
      // (jours × prix/jour, solde dû) qui n'a pas de sens pour un avoir (voir CreditNotePdf.tsx,
      // gabarit dédié, jamais assemblé dans un lot). Défense en profondeur : InvoicesTable.tsx
      // exclut déjà un avoir de la sélection côté client, mais le client n'est jamais la seule
      // barrière pour une décision de rendu.
      type: { not: "CREDIT_NOTE" },
      ...(hasIds ? { id: { in: body.ids } } : {}),
      ...(hasDateRange
        ? {
            ...(from ? { issuedAt: { gte: from } } : {}),
            ...(to ? { issuedAt: { lte: to } } : {}),
          }
        : {}),
    },
    include: { client: true, location: { include: { vehicle: true } } },
    orderBy: { number: "asc" },
    take: MAX_BATCH_SIZE + 1,
  });

  if (invoices.length === 0) {
    return NextResponse.json({ error: "Aucune facture ne correspond à cette sélection." }, { status: 404 });
  }
  if (invoices.length > MAX_BATCH_SIZE) {
    return NextResponse.json(
      { error: `Cette sélection dépasse ${MAX_BATCH_SIZE} factures — affinez la plage de dates.` },
      { status: 400 }
    );
  }

  const agencies = await prisma.agency.findMany({
    where: { id: { in: [...new Set(invoices.map((invoice) => invoice.agencyId))] } },
    select: { id: true, name: true },
  });
  const agencyNameById = new Map(agencies.map((agency) => [agency.id, agency.name]));

  // Sprint 26E : numéro de la facture immédiatement remplacée, pour chaque facture versionnée
  // du lot (affiché sur le PDF, InvoicePdfPage).
  const replacesInvoiceIds = [
    ...new Set(invoices.map((invoice) => invoice.replacesInvoiceId).filter((id): id is string => id !== null)),
  ];
  const replacedInvoices =
    replacesInvoiceIds.length > 0
      ? await prisma.invoice.findMany({ where: { id: { in: replacesInvoiceIds } }, select: { id: true, number: true } })
      : [];
  const replacedNumberById = new Map(replacedInvoices.map((invoice) => [invoice.id, invoice.number]));

  const buffer = await renderToBuffer(
    <Document title={`Lot de factures (${invoices.length})`}>
      {invoices.map((invoice) => (
        <InvoicePdfPage
          key={invoice.id}
          tenantName={tenant.name}
          agencyName={agencyNameById.get(invoice.agencyId) ?? "—"}
          invoiceNumber={invoice.number}
          contractNumber={invoice.location.contractNumber}
          status={invoice.status}
          versionNumber={invoice.versionNumber}
          replacesInvoiceNumber={invoice.replacesInvoiceId ? (replacedNumberById.get(invoice.replacesInvoiceId) ?? null) : null}
          issuedAt={invoice.issuedAt}
          dueDate={invoice.dueDate}
          clientName={invoice.client.name}
          clientEmail={invoice.client.email}
          clientPhone={invoice.client.phone}
          vehicleName={invoice.location.vehicle.name}
          vehicleLicensePlate={invoice.location.vehicle.licensePlate}
          locationStart={invoice.location.startDate}
          locationEnd={invoice.location.endDate}
          pricePerDay={invoice.location.pricePerDay}
          subtotal={invoice.subtotal}
          taxRate={invoice.taxRate}
          taxAmount={invoice.taxAmount}
          discountAmount={invoice.discountAmount}
          totalAmount={invoice.totalAmount}
          amountPaid={invoice.amountPaid}
          currency={invoice.currency}
          notes={invoice.notes}
        />
      ))}
    </Document>
  );

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="lot-factures.pdf"`,
    },
  });
}
