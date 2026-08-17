import { notFound } from "next/navigation";
import Link from "next/link";
import { FileText } from "lucide-react";
import { getSessionUser, canAccessReservationAgencies, canEditReservationAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getReservationById, canTransition } from "@/lib/reservations";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/format";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Icon } from "@/components/ui";
import { ReservationActions } from "./ReservationActions";

interface PageProps {
  params: Promise<{ id: string }>;
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  CONFIRMED: "Confirmée",
  CONVERTED: "Convertie",
  CANCELLED: "Annulée",
};

// Sprint 15 : source est du texte libre (voir prisma/schema.prisma) — ces libellés ne sont
// qu'un affichage plus lisible pour les valeurs connues, avec repli sur la valeur brute pour
// tout autre code broker (ex. non listé ici).
const SOURCE_LABELS: Record<string, string> = {
  BROKER: "Broker",
  DIRECT: "Direct",
  TJS: "TJS",
  DCH: "DCH",
  CT: "CT",
};

const EDITABLE_STATUSES = new Set(["PENDING", "CONFIRMED"]);

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
  if (!reservation || !(await canAccessReservationAgencies(user, reservation))) {
    notFound();
  }

  // Sprint 19 (DOMAINRULES.md section 37) : seule l'agence de départ peut modifier/convertir/
  // annuler — une agence qui ne voit cette réservation que via dropoffAgencyId (ci-dessus) ne
  // peut que la consulter.
  const canEditThisAgency = await canEditReservationAgency(user, reservation);
  const canEdit = (await can(user, "reservations.edit")) && reservation.status !== "CONVERTED" && canEditThisAgency;
  const canEditReservation = canEdit && EDITABLE_STATUSES.has(reservation.status);
  // Sprint 24 : confirmer/annuler/marquer No Show ne sont plus couvertes par reservations.edit
  // ci-dessus — clés dédiées (voir src/lib/permissions.ts, PATCH /api/reservations/[id]).
  const canConfirm = (await can(user, "reservations.confirm")) && canEditThisAgency;
  const canCancel = (await can(user, "reservations.cancel")) && canEditThisAgency;
  const canNoShow = (await can(user, "reservations.no_show")) && canEditThisAgency;
  // Sprint 22 : reservations.convert est une permission distincte de reservations.edit (déjà
  // séparée dans le catalogue, src/lib/permissions.ts) — le bouton doit suivre exactement la
  // machine à états (canTransition, qui autorise PENDING → CONVERTED directement, pas seulement
  // depuis CONFIRMED) plutôt qu'un statut figé en dur, sinon un user n'ayant que .convert (pas
  // .edit) ne peut jamais faire passer une réservation PENDING à CONFIRMED pour débloquer le
  // bouton — la conversion se retrouvait de fait liée à la permission de modification.
  const canConvert =
    (await can(user, "reservations.convert")) && canTransition(reservation.status, "CONVERTED") && canEditThisAgency;

  const optionsSum =
    (reservation.gpsPrice ?? 0) + (reservation.babySeatPrice ?? 0) + (reservation.extraDriverPrice ?? 0);
  const finalPriceDisplay =
    reservation.totalPrice === null
      ? "—"
      : optionsSum === 0 || reservation.optionsCurrency === reservation.currency
        ? formatMoney(reservation.totalPrice + optionsSum, reservation.currency)
        : `${formatMoney(reservation.totalPrice, reservation.currency)} + ${formatMoney(optionsSum, reservation.optionsCurrency)}`;

  // Invoice la plus récente du contrat issu de cette réservation, pour le téléchargement
  // immédiat du PDF (Sprint 13D, section 5) — même requête que /dashboard/locations/[id].
  const invoice =
    reservation.status === "CONVERTED" && reservation.convertedLocationId
      ? await prisma.invoice.findFirst({
          where: { locationId: reservation.convertedLocationId },
          orderBy: { createdAt: "desc" },
        })
      : null;

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

      <div className="flex flex-wrap gap-2">
        {canEditReservation && (
          <Button variant="outline" render={<Link href={`/dashboard/reservations/${reservation.id}/edit`} />}>
            Modifier
          </Button>
        )}
        {canConvert && (
          <Button render={<Link href={`/dashboard/reservations/${reservation.id}/convert`} />}>
            Convertir en contrat
          </Button>
        )}
        {reservation.status === "CONVERTED" && reservation.convertedLocationId && (
          <>
            <Button
              variant="outline"
              render={<Link href={`/dashboard/locations/${reservation.convertedLocationId}`} />}
            >
              Voir le contrat
            </Button>
            {invoice && (
              <Button
                variant="outline"
                render={<a href={`/api/invoices/${invoice.id}/pdf`} target="_blank" rel="noreferrer" />}
              >
                <Icon icon={FileText} className="size-4" />
                Télécharger le contrat PDF
              </Button>
            )}
          </>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Détails</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <span className="text-muted-foreground">N° confirmation</span>
          <span>{reservation.confirmationNumber ?? "—"}</span>

          <span className="text-muted-foreground">Source</span>
          <span>{reservation.source ? (SOURCE_LABELS[reservation.source] ?? reservation.source) : "—"}</span>

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
            {optionsSum > 0 ? ` (${formatMoney(optionsSum, reservation.optionsCurrency)})` : ""}
          </span>

          <span className="text-muted-foreground">Prix final</span>
          <span>{finalPriceDisplay}</span>

          <span className="text-muted-foreground">Kilométrage / inclus</span>
          <span>
            {reservation.mileage ?? "—"} / {reservation.includedKm ?? "—"}
          </span>

          <span className="text-muted-foreground">Remarques</span>
          <span>{reservation.notes ?? "—"}</span>
        </CardContent>
      </Card>

      <ReservationActions
        id={reservation.id}
        status={reservation.status}
        notes={reservation.notes}
        canEdit={canEdit}
        canConfirm={canConfirm}
        canCancel={canCancel}
        canNoShow={canNoShow}
      />
    </div>
  );
}
