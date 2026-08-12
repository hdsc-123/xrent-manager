import { notFound } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getReservationById } from "@/lib/reservations";
import { formatMoney } from "@/lib/format";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { ReservationActions } from "./ReservationActions";
import { ConvertReservationCard } from "./ConvertReservationCard";

interface PageProps {
  params: Promise<{ id: string }>;
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  CONFIRMED: "Confirmée",
  CONVERTED: "Convertie",
  CANCELLED: "Annulée",
};

const SOURCE_LABELS: Record<string, string> = {
  BROKER: "Broker",
  DIRECT: "Direct",
};

function formatDate(date: Date): string {
  return date.toLocaleDateString("fr-FR");
}

export default async function ReservationDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "reservations.view"))) {
    notFound();
  }

  const reservation = await getReservationById(user.tenantId, id);
  if (!reservation) {
    notFound();
  }

  const canEdit = await can(user, "reservations.edit");
  const canConvert =
    (await can(user, "reservations.convert")) &&
    (reservation.status === "PENDING" || reservation.status === "CONFIRMED");

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Réservation {reservation.voucherNumber}</h1>
          <p className="text-sm text-muted-foreground">
            {reservation.clientFirstName} {reservation.clientLastName}
          </p>
        </div>
        <Badge variant="outline">{STATUS_LABELS[reservation.status] ?? reservation.status}</Badge>
      </div>

      {reservation.status === "CONVERTED" && reservation.convertedLocationId && (
        <Card>
          <CardContent className="py-4 text-sm">
            Cette réservation a été convertie en contrat.{" "}
            <Link href={`/dashboard/locations/${reservation.convertedLocationId}`} className="underline">
              Voir la location
            </Link>
            .
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Détails</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <span className="text-muted-foreground">N° confirmation</span>
          <span>{reservation.confirmationNumber ?? "—"}</span>

          <span className="text-muted-foreground">Source</span>
          <span>{reservation.source ? SOURCE_LABELS[reservation.source] : "—"}</span>

          <span className="text-muted-foreground">Téléphone client</span>
          <span>{reservation.clientPhone ?? "—"}</span>

          <span className="text-muted-foreground">Période</span>
          <span>
            {formatDate(reservation.startDate)}
            {reservation.startTime ? ` ${reservation.startTime}` : ""} → {formatDate(reservation.endDate)}
            {reservation.endTime ? ` ${reservation.endTime}` : ""}
          </span>

          <span className="text-muted-foreground">N° de vol</span>
          <span>{reservation.flightNumber ?? "—"}</span>

          <span className="text-muted-foreground">Catégorie véhicule</span>
          <span>{reservation.vehicleCategory ?? "—"}</span>

          <span className="text-muted-foreground">Agence départ / retour</span>
          <span>
            {reservation.pickupAgency ?? "—"} / {reservation.dropoffAgency ?? "—"}
          </span>

          <span className="text-muted-foreground">Prix / jour</span>
          <span>{reservation.pricePerDay !== null ? formatMoney(reservation.pricePerDay, reservation.currency) : "—"}</span>

          <span className="text-muted-foreground">Prix total</span>
          <span>{reservation.totalPrice !== null ? formatMoney(reservation.totalPrice, reservation.currency) : "—"}</span>

          <span className="text-muted-foreground">Options</span>
          <span>
            {[
              reservation.hasGps ? "GPS" : null,
              reservation.hasBabySeat ? "Siège bébé" : null,
              reservation.hasExtraDriver ? "Conducteur supp." : null,
            ]
              .filter(Boolean)
              .join(", ") || "Aucune"}
          </span>

          <span className="text-muted-foreground">Kilométrage / inclus</span>
          <span>
            {reservation.mileage ?? "—"} / {reservation.includedKm ?? "—"}
          </span>

          <span className="text-muted-foreground">Remarques</span>
          <span>{reservation.notes ?? "—"}</span>
        </CardContent>
      </Card>

      <ConvertReservationCard
        reservationId={reservation.id}
        voucherNumber={reservation.voucherNumber}
        canConvert={canConvert}
      />

      <ReservationActions
        id={reservation.id}
        status={reservation.status}
        notes={reservation.notes}
        canEdit={canEdit && reservation.status !== "CONVERTED"}
      />
    </div>
  );
}
