import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getLocationById } from "@/lib/locations";
import { getLocationUpgradeByLocationId } from "@/lib/location-upgrades";
import { prisma } from "@/lib/prisma";
import { ContractPdf } from "@/components/contracts/ContractPdf";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Mêmes libellés que UPGRADE_TYPE_OPTIONS (ConvertReservationForm.tsx), raccourcis pour
// l'affichage en lecture seule (contexte déjà donné par la ligne "Surclassement" du PDF).
const UPGRADE_TYPE_LABELS: Record<string, string> = {
  CUSTOMER_REQUEST: "Demande du client",
  UNAVAILABILITY: "Indisponibilité de la catégorie réservée",
  COMMERCIAL_GESTURE: "Geste commercial",
};

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "locations.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const location = await getLocationById(user.tenantId, id);

  if (!location || !(await canAccessAgency(user, location.agencyId))) {
    return NextResponse.json({ error: "Location introuvable." }, { status: 404 });
  }

  // Une Location créée avant le Sprint 14B (migration) n'a pas de contractNumber (jamais
  // backfillé rétroactivement, voir schema.prisma) — le PDF contrat n'existe donc que pour
  // les contrats numérotés.
  if (!location.contractNumber) {
    return NextResponse.json(
      { error: "Ce contrat n'a pas de numéro (créé avant la mise en place de la numérotation)." },
      { status: 404 }
    );
  }

  const [tenant, agency, vehicle, client] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: location.tenantId }, select: { name: true } }),
    prisma.agency.findUnique({ where: { id: location.agencyId }, select: { name: true } }),
    prisma.vehicle.findUnique({ where: { id: location.vehicleId } }),
    prisma.client.findUnique({ where: { id: location.clientId } }),
  ]);

  if (!tenant || !agency || !vehicle || !client) {
    return NextResponse.json({ error: "Données de contrat incomplètes." }, { status: 500 });
  }

  const locationUpgrade = await getLocationUpgradeByLocationId(user.tenantId, location.id);
  const upgrade = locationUpgrade
    ? {
        typeLabel: UPGRADE_TYPE_LABELS[locationUpgrade.type] ?? locationUpgrade.type,
        reservedCategory: locationUpgrade.reservedCategory,
        assignedCategory: locationUpgrade.assignedCategory,
        dailySupplement: locationUpgrade.dailySupplement,
        daysCount: locationUpgrade.daysCount,
        totalSupplement: locationUpgrade.totalSupplement,
      }
    : null;

  const buffer = await renderToBuffer(
    <ContractPdf
      tenantName={tenant.name}
      agencyName={agency.name}
      contractNumber={location.contractNumber}
      status={location.status}
      createdAt={location.createdAt}
      clientName={client.name}
      clientEmail={client.email}
      clientPhone={client.phone}
      clientIdNumber={client.idNumber}
      clientLicenseNumber={client.licenseNumber}
      vehicleName={vehicle.name}
      vehicleLicensePlate={vehicle.licensePlate}
      locationStart={location.startDate}
      locationEnd={location.endDate}
      pricePerDay={location.pricePerDay}
      totalPrice={location.totalPrice}
      deposit={location.deposit}
      startOdometer={location.startOdometer}
      endOdometer={location.endOdometer}
      currency={location.currency}
      notes={location.notes}
      upgrade={upgrade}
    />
  );

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${location.contractNumber}.pdf"`,
    },
  });
}
