import { notFound, redirect } from "next/navigation";
import { getSessionUser, getAccessibleAgencyIds, canAccessReservationAgencies, canEditReservationAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getReservationById } from "@/lib/reservations";
import { prisma } from "@/lib/prisma";
import { ConvertReservationForm } from "./ConvertReservationForm";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Formulaire de conversion réservation → contrat (Sprint 13D, remplace l'ancienne boîte de
 * dialogue ConvertReservationCard). Accessible pour PENDING/CONFIRMED (même portée que
 * canTransition(..., "CONVERTED"), src/lib/reservations.ts) même si le bouton "Convertir en
 * contrat" de la page de détail n'est proposé que pour CONFIRMED (voir page.tsx du dossier
 * parent) — un accès direct par URL sur une réservation encore PENDING reste fonctionnel.
 */
export default async function ConvertReservationPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "reservations.convert"))) {
    notFound();
  }

  const reservation = await getReservationById(user.tenantId, id);
  if (!reservation || !(await canAccessReservationAgencies(user, reservation))) {
    notFound();
  }

  // Sprint 19 (DOMAINRULES.md section 37) : seule l'agence de départ peut convertir.
  if (!(await canEditReservationAgency(user, reservation))) {
    notFound();
  }

  if (reservation.status !== "PENDING" && reservation.status !== "CONFIRMED") {
    redirect(`/dashboard/reservations/${id}`);
  }

  // Campagne QA (2026-08-27, passe de correction obligatoire) : le type COMMERCIAL_GESTURE
  // nécessite une permission dédiée côté serveur (locations.upgrade.commercial_gesture, voir
  // POST /api/reservations/[id]/convert) — l'option n'est proposée dans le formulaire que si
  // l'utilisateur la possède réellement (l'interface reflète la règle serveur sans jamais la
  // remplacer : même sans cette permission, un ADMIN ou une tentative directe sur l'API reste
  // soumise au même contrôle serveur).
  const canCommercialGesture = await can(user, "locations.upgrade.commercial_gesture");

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const allAgencies = await prisma.agency.findMany({
    where: { tenantId: user.tenantId },
    orderBy: { name: "asc" },
  });
  const agencies =
    accessibleAgencyIds === null
      ? allAgencies
      : allAgencies.filter((agency) => accessibleAgencyIds.includes(agency.id));

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Convertir la réservation {reservation.voucherNumber}</h1>
        <p className="text-sm text-muted-foreground">
          Vérifiez les informations du client, choisissez le véhicule et l&apos;agence réels, puis validez pour
          générer le contrat.
        </p>
      </div>

      <ConvertReservationForm
        reservation={{
          id: reservation.id,
          voucherNumber: reservation.voucherNumber,
          clientFirstName: reservation.clientFirstName,
          clientLastName: reservation.clientLastName,
          clientPhone: reservation.clientPhone,
          startDate: reservation.startDate.toISOString(),
          startTime: reservation.startTime,
          endDate: reservation.endDate.toISOString(),
          endTime: reservation.endTime,
          pricePerDay: reservation.pricePerDay,
          totalPrice: reservation.totalPrice,
          currency: reservation.currency,
          vehicleCategory: reservation.vehicleCategory,
          notes: reservation.notes,
          // Sprint 19 (DOMAINRULES.md section 37) : nécessaires pour reprendre le vrai montant
          // réservation + options au lieu d'un recalcul silencieux pricePerDay × jours.
          hasGps: reservation.hasGps,
          gpsPrice: reservation.gpsPrice,
          hasBabySeat: reservation.hasBabySeat,
          babySeatPrice: reservation.babySeatPrice,
          hasExtraDriver: reservation.hasExtraDriver,
          extraDriverPrice: reservation.extraDriverPrice,
          optionsCurrency: reservation.optionsCurrency,
        }}
        agencies={agencies.map((agency) => ({ id: agency.id, name: agency.name }))}
        canCommercialGesture={canCommercialGesture}
      />
    </div>
  );
}
