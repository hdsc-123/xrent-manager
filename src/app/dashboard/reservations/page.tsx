import Link from "next/link";
import { Plus, Upload } from "lucide-react";
import type { ReservationSource, ReservationStatus } from "@prisma/client";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getReservations } from "@/lib/reservations";
import { Button, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { ReservationsTable, type ReservationRow } from "./ReservationsTable";

const STATUS_OPTIONS: { value: ReservationStatus; label: string }[] = [
  { value: "PENDING", label: "En attente" },
  { value: "CONFIRMED", label: "Confirmée" },
  { value: "CONVERTED", label: "Convertie" },
  { value: "CANCELLED", label: "Annulée" },
];

const SOURCE_OPTIONS: { value: ReservationSource; label: string }[] = [
  { value: "BROKER", label: "Broker" },
  { value: "DIRECT", label: "Direct" },
];

interface PageProps {
  searchParams: Promise<{ status?: string; source?: string; search?: string; from?: string; to?: string }>;
}

export default async function ReservationsPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "reservations.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Réservations</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter les réservations.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const params = await searchParams;
  const canCreate = await can(user, "reservations.create");
  const canImport = await can(user, "reservations.import");

  const reservations = await getReservations(user.tenantId, {
    ...(params.status ? { status: params.status as ReservationStatus } : {}),
    ...(params.source ? { source: params.source as ReservationSource } : {}),
    ...(params.search ? { search: params.search } : {}),
    ...(params.from ? { from: new Date(params.from) } : {}),
    ...(params.to ? { to: new Date(params.to) } : {}),
  });

  const rows: ReservationRow[] = reservations.map((reservation) => ({
    id: reservation.id,
    voucherNumber: reservation.voucherNumber,
    source: reservation.source,
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Réservations</h1>
          <p className="text-sm text-muted-foreground">
            Réservations reçues (broker ou direct), en amont d&apos;un contrat de location.
          </p>
        </div>
        <div className="flex gap-2">
          {canImport && (
            <Button variant="outline" render={<Link href="/dashboard/reservations/import" />}>
              <Upload className="size-4" />
              Importer (Excel)
            </Button>
          )}
          {canCreate && (
            <Button render={<Link href="/dashboard/reservations/new" />}>
              <Plus className="size-4" />
              Créer une réservation
            </Button>
          )}
        </div>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3" method="get">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="status" className="text-xs font-medium text-muted-foreground">
            Statut
          </label>
          <select
            id="status"
            name="status"
            defaultValue={params.status ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Tous</option>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="source" className="text-xs font-medium text-muted-foreground">
            Source
          </label>
          <select
            id="source"
            name="source"
            defaultValue={params.source ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Toutes</option>
            {SOURCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
            Du
          </label>
          <input
            id="from"
            type="date"
            name="from"
            defaultValue={params.from ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="to" className="text-xs font-medium text-muted-foreground">
            Au
          </label>
          <input
            id="to"
            type="date"
            name="to"
            defaultValue={params.to ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="search" className="text-xs font-medium text-muted-foreground">
            Recherche
          </label>
          <input
            id="search"
            type="text"
            name="search"
            placeholder="Voucher, nom, prénom, n° vol..."
            defaultValue={params.search ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {(params.status || params.source || params.search || params.from || params.to) && (
          <Button render={<Link href="/dashboard/reservations" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <ReservationsTable reservations={rows} />
    </div>
  );
}
