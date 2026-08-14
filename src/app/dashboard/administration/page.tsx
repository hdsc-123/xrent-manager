import Link from "next/link";
import { getSessionUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { getContractsOverview } from "@/lib/locations";
import { getCashBalanceByAgency } from "@/lib/cash-register";
import { getReservations } from "@/lib/reservations";
import { getVehicles } from "@/lib/vehicles";
import { formatMoney } from "@/lib/format";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { ContractsOverviewTable, type ContractOverviewRow } from "../contracts/ContractsOverviewTable";
import { PaymentsTable, type PaymentRow } from "../payments/PaymentsTable";
import { ReservationsTable, type ReservationRow } from "../reservations/ReservationsTable";
import { VehiclesTable, type VehicleRow } from "../vehicles/VehiclesTable";

const SECTIONS = [
  { value: "contracts", label: "Contrats" },
  { value: "cash", label: "Caisse" },
  { value: "payments", label: "Paiements" },
  { value: "reservations", label: "Réservations" },
  { value: "vehicles", label: "Véhicules" },
] as const;

type Section = (typeof SECTIONS)[number]["value"];

interface PageProps {
  searchParams: Promise<{ agencyId?: string; section?: string }>;
}

/**
 * Sprint 23 (DOMAINRULES.md section 39, point E de l'énoncé) — vue Administration filtrable
 * par ville/agence : un ADMIN choisit une station puis voit contrats/caisse/paiements/
 * réservations/véhicules de cette station uniquement (jamais toutes les données en bloc,
 * conformément à l'énoncé). Réservée ADMIN (contrôle de rôle strict, pas une permission
 * granulaire — même convention que /dashboard/audit, /dashboard/tenants, SECURITY.md section 4).
 * Chaque section réutilise une fonction de lecture déjà existante, simplement appelée avec
 * `agencyId` fixé à la station choisie — aucune nouvelle logique métier.
 */
export default async function AdministrationPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (user.role !== "ADMIN") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Administration</CardTitle>
          <CardDescription>Cette section est réservée aux administrateurs du tenant.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const params = await searchParams;
  const agencies = await prisma.agency.findMany({
    where: { tenantId: user.tenantId },
    select: { id: true, name: true, city: true },
    orderBy: { name: "asc" },
  });

  const selectedAgency = params.agencyId ? agencies.find((agency) => agency.id === params.agencyId) : undefined;
  const section: Section = SECTIONS.some((s) => s.value === params.section) ? (params.section as Section) : "contracts";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Administration</h1>
        <p className="text-sm text-muted-foreground">
          Choisissez une station pour consulter ses contrats, sa caisse, ses paiements, ses réservations et ses
          véhicules — jamais toutes les agences en bloc.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3" method="get">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="agencyId" className="text-xs font-medium text-muted-foreground">
            Station (agence)
          </label>
          <select
            id="agencyId"
            name="agencyId"
            defaultValue={params.agencyId ?? ""}
            className="h-9 min-w-52 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Choisir une station...</option>
            {agencies.map((agency) => (
              <option key={agency.id} value={agency.id}>
                {agency.city ? `${agency.name} (${agency.city})` : agency.name}
              </option>
            ))}
          </select>
        </div>
        <input type="hidden" name="section" value={section} />
        <Button type="submit" variant="outline" size="sm">
          Afficher
        </Button>
      </form>

      {!selectedAgency ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Choisissez une station ci-dessus pour afficher ses données.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {SECTIONS.map((s) => (
              <Button
                key={s.value}
                variant={s.value === section ? "default" : "outline"}
                size="sm"
                render={<Link href={`/dashboard/administration?agencyId=${selectedAgency.id}&section=${s.value}`} />}
              >
                {s.label}
              </Button>
            ))}
          </div>

          <AdministrationSection tenantId={user.tenantId} agencyId={selectedAgency.id} section={section} />
        </>
      )}
    </div>
  );
}

async function AdministrationSection({
  tenantId,
  agencyId,
  section,
}: {
  tenantId: string;
  agencyId: string;
  section: Section;
}) {
  if (section === "contracts") {
    const contracts = await getContractsOverview(tenantId, { agencyIds: [agencyId] });
    const rows: ContractOverviewRow[] = contracts.map((contract) => ({
      id: contract.id,
      contractNumber: contract.contractNumber,
      clientName: contract.clientName,
      source: contract.source,
      startDate: contract.startDate.toISOString(),
      endDate: contract.endDate.toISOString(),
      make: contract.make,
      licensePlate: contract.licensePlate,
      startOdometer: contract.startOdometer,
      endOdometer: contract.endOdometer,
      startFuelLevel: contract.startFuelLevel,
      endFuelLevel: contract.endFuelLevel,
      totalPrice: contract.totalPrice,
      currency: contract.currency,
      status: contract.status,
    }));
    return <ContractsOverviewTable contracts={rows} />;
  }

  if (section === "cash") {
    const [balance] = await getCashBalanceByAgency(tenantId, [agencyId]);
    if (!balance) {
      return <p className="text-sm text-muted-foreground">Aucune donnée de caisse pour cette agence.</p>;
    }
    const stats = [
      { label: "Solde de départ", value: balance.startingBalance },
      { label: "Entrées", value: balance.entries },
      { label: "Dépenses", value: balance.expenses },
      { label: "Solde réel", value: balance.balance },
    ];
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="pb-2">
              <CardDescription>{stat.label}</CardDescription>
              <CardTitle className="text-xl">{formatMoney(stat.value, balance.currency)}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
    );
  }

  if (section === "payments") {
    const payments = await prisma.payment.findMany({
      where: { tenantId, invoice: { agencyId } },
      include: {
        invoice: {
          select: { number: true, client: { select: { name: true } }, location: { select: { contractNumber: true } } },
        },
      },
      orderBy: { paidAt: "desc" },
    });
    const rows: PaymentRow[] = payments.map((payment) => ({
      id: payment.id,
      invoiceNumber: payment.invoice.number,
      contractNumber: payment.invoice.location.contractNumber,
      clientName: payment.invoice.client.name,
      method: payment.method,
      paidAt: payment.paidAt.toISOString(),
      amount: payment.amount,
      currency: payment.currency,
      reference: payment.reference,
    }));
    return <PaymentsTable payments={rows} />;
  }

  if (section === "reservations") {
    const reservations = await getReservations(tenantId, { accessibleAgencyIds: [agencyId] });
    const rows: ReservationRow[] = reservations.map((reservation) => ({
      id: reservation.id,
      voucherNumber: reservation.voucherNumber,
      canEditAgency: false,
      source: reservation.source,
      optionsCurrency: reservation.optionsCurrency,
      flightNumber: reservation.flightNumber,
      clientFirstName: reservation.clientFirstName,
      clientLastName: reservation.clientLastName,
      startDate: reservation.startDate.toISOString(),
      startTime: reservation.startTime,
      endDate: reservation.endDate.toISOString(),
      endTime: reservation.endTime,
      pickupAgency: reservation.pickupAgency,
      dropoffAgency: reservation.dropoffAgency,
      vehicleCategory: reservation.vehicleCategory,
      hasGps: reservation.hasGps,
      hasBabySeat: reservation.hasBabySeat,
      hasExtraDriver: reservation.hasExtraDriver,
      totalPrice: reservation.totalPrice,
      gpsPrice: reservation.gpsPrice,
      babySeatPrice: reservation.babySeatPrice,
      extraDriverPrice: reservation.extraDriverPrice,
      currency: reservation.currency,
      notes: reservation.notes,
      status: reservation.status,
    }));
    // Vue Administration : purement informative (consultation par station) — les actions
    // (Valider/Annuler/No Show/Réinitialiser/Modifier/Supprimer) restent réservées à
    // /dashboard/reservations, où le contexte d'agence de l'utilisateur agissant est vérifié.
    return <ReservationsTable reservations={rows} canDelete={false} canEdit={false} canConvert={false} isAdmin={false} />;
  }

  const vehicles = await getVehicles(tenantId, { agencyId });
  const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { name: true } });
  const vehicleRows: VehicleRow[] = vehicles.map((vehicle) => ({
    id: vehicle.id,
    name: vehicle.name,
    licensePlate: vehicle.licensePlate,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    category: vehicle.category,
    status: vehicle.status,
    pricePerDay: vehicle.pricePerDay,
    currency: vehicle.currency,
    agencyName: agency?.name ?? "",
  }));
  return <VehiclesTable vehicles={vehicleRows} canDelete={false} />;
}
