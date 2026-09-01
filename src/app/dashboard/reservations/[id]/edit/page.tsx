import { notFound, redirect } from "next/navigation";
import { getSessionUser, canAccessReservationAgencies, canEditReservationAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getReservationById, getKnownAgencyNames } from "@/lib/reservations";
import { prisma } from "@/lib/prisma";
import { EditReservationForm } from "./EditReservationForm";

interface PageProps {
  params: Promise<{ id: string }>;
}

const EDITABLE_STATUSES = new Set(["PENDING", "CONFIRMED"]);

/**
 * Formulaire d'édition complet d'une réservation (Sprint 15 — jusqu'ici, seuls le statut et
 * les remarques étaient modifiables depuis l'interface, malgré une route PATCH acceptant déjà
 * la quasi-totalité des champs). Même découpage Server Component/Client Component que
 * convert/page.tsx (Sprint 13D). Réservé aux statuts non terminaux pour l'édition (CONVERTED/
 * CANCELLED sont terminaux — voir DOMAINRULES.md section 21) — un accès direct par URL sur une
 * réservation non éditable redirige vers la page de détail plutôt que d'échouer silencieusement.
 */
export default async function EditReservationPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "reservations.edit"))) {
    notFound();
  }

  const reservation = await getReservationById(user.tenantId, id);
  if (!reservation || !(await canAccessReservationAgencies(user, reservation))) {
    notFound();
  }

  // Sprint 19 (DOMAINRULES.md section 37) : seule l'agence de départ peut modifier — une
  // agence qui ne voit cette réservation que via dropoffAgencyId n'a pas accès à ce formulaire.
  if (!(await canEditReservationAgency(user, reservation))) {
    notFound();
  }

  if (!EDITABLE_STATUSES.has(reservation.status)) {
    redirect(`/dashboard/reservations/${id}`);
  }

  const [agencies, knownAgencyNames] = await Promise.all([
    prisma.agency.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: "asc" } }),
    getKnownAgencyNames(user.tenantId),
  ]);

  const agencyOptions = Array.from(
    new Set(agencies.map((agency) => agency.city?.trim() || agency.name))
  ).sort((a, b) => a.localeCompare(b));

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Modifier la réservation {reservation.voucherNumber}</h1>
        <p className="text-sm text-muted-foreground">
          Toutes les informations de la réservation peuvent être corrigées ici, qu&apos;elle ait été
          saisie manuellement ou importée depuis Excel.
        </p>
      </div>

      <EditReservationForm
        reservation={{
          id: reservation.id,
          voucherNumber: reservation.voucherNumber,
          reservationNumber: reservation.reservationNumber,
          confirmationNumber: reservation.confirmationNumber,
          source: reservation.source,
          clientFirstName: reservation.clientFirstName,
          clientLastName: reservation.clientLastName,
          clientPhone: reservation.clientPhone,
          startDate: reservation.startDate.toISOString().slice(0, 10),
          startTime: reservation.startTime,
          endDate: reservation.endDate.toISOString().slice(0, 10),
          endTime: reservation.endTime,
          flightNumber: reservation.flightNumber,
          vehicleCategory: reservation.vehicleCategory,
          pickupAgency: reservation.pickupAgency,
          dropoffAgency: reservation.dropoffAgency,
          currency: reservation.currency,
          totalPrice: reservation.totalPrice,
          pricePerDay: reservation.pricePerDay,
          hasGps: reservation.hasGps,
          gpsPrice: reservation.gpsPrice,
          hasBabySeat: reservation.hasBabySeat,
          babySeatPrice: reservation.babySeatPrice,
          hasExtraDriver: reservation.hasExtraDriver,
          extraDriverPrice: reservation.extraDriverPrice,
          optionsCurrency: reservation.optionsCurrency,
          mileage: reservation.mileage,
          includedKm: reservation.includedKm,
          notes: reservation.notes,
        }}
        agencyOptions={knownAgencyNames.size > 0 ? agencyOptions : []}
      />
    </div>
  );
}
