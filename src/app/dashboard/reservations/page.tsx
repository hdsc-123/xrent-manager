import Link from "next/link";
import { Plus, Upload } from "lucide-react";
import type { ReservationStatus } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getReservations } from "@/lib/reservations";
import { prisma } from "@/lib/prisma";
import { Button, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { ReservationsTable, type ReservationRow } from "./ReservationsTable";

const STATUS_OPTIONS: { value: ReservationStatus; label: string }[] = [
  { value: "PENDING", label: "En attente" },
  { value: "CONFIRMED", label: "Confirmée" },
  { value: "CONVERTED", label: "Convertie" },
  { value: "CANCELLED", label: "Annulée" },
  { value: "NO_SHOW", label: "No show" },
];

// Sprint 15 : source est désormais du texte libre (voir prisma/schema.prisma) — ces valeurs
// ne sont que des suggestions (<datalist>), pas une liste fermée, pour ne jamais perdre un
// code broker réel (TJS/DCH/CT...) qui ne figurerait pas ici.
const SOURCE_SUGGESTIONS = ["TJS", "DCH", "CT", "DIRECT", "BROKER"];

interface PageProps {
  searchParams: Promise<{
    status?: string;
    source?: string;
    search?: string;
    from?: string;
    to?: string;
    pickupAgency?: string;
    dropoffAgency?: string;
    vehicleCategory?: string;
  }>;
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
  const canDelete = await can(user, "reservations.delete");
  const canEdit = await can(user, "reservations.edit");
  // Sprint 23 : action rapide « Valider » (renvoie vers le formulaire de contrat) — distincte
  // de reservations.edit, catalogue depuis le Sprint 12C (DOMAINRULES.md section 22).
  const canConvert = await can(user, "reservations.convert");
  // Sprint 24 : Annuler/No Show désormais gatées par leurs propres clés, distinctes de
  // reservations.edit (voir src/lib/permissions.ts, PATCH /api/reservations/[id]).
  const canCancel = await can(user, "reservations.cancel");
  const canNoShow = await can(user, "reservations.no_show");
  // Réinitialiser à zéro (section 39) : réservé ADMIN, jamais une permission granulaire —
  // même principe que l'admin override des contrats (DOMAINRULES.md section 37).
  const isAdmin = user.role === "ADMIN";

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const reservations = await getReservations(user.tenantId, {
    ...(params.status ? { status: params.status as ReservationStatus } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(params.search ? { search: params.search } : {}),
    ...(params.from ? { from: new Date(params.from) } : {}),
    ...(params.to ? { to: new Date(params.to) } : {}),
    ...(params.pickupAgency ? { pickupAgency: params.pickupAgency } : {}),
    ...(params.dropoffAgency ? { dropoffAgency: params.dropoffAgency } : {}),
    ...(params.vehicleCategory ? { vehicleCategory: params.vehicleCategory } : {}),
    // Sprint 19 (DOMAINRULES.md section 37) : visibilité scopée par agence de départ/retour.
    accessibleAgencyIds,
  });

  // Villes/agences (Sprint 14A) : mêmes options que le formulaire de création (ville si
  // renseignée, sinon nom), pour filtrer sur les mêmes valeurs que celles saisissables.
  const agencies = await prisma.agency.findMany({ where: { tenantId: user.tenantId }, select: { name: true, city: true } });
  const agencyOptions = Array.from(new Set(agencies.map((agency) => agency.city?.trim() || agency.name))).sort(
    (a, b) => a.localeCompare(b)
  );

  // Sprint 19 (DOMAINRULES.md section 37) : seule l'agence de départ peut modifier/annuler —
  // calculé par ligne plutôt qu'un booléen global unique, `null` (ADMIN) = aucune restriction.
  const canEditRow = (pickupAgencyId: string | null) =>
    accessibleAgencyIds === null || pickupAgencyId === null || accessibleAgencyIds.includes(pickupAgencyId);

  const rows: ReservationRow[] = reservations.map((reservation) => ({
    id: reservation.id,
    voucherNumber: reservation.voucherNumber,
    canEditAgency: canEditRow(reservation.pickupAgencyId),
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

  return (
    <div className="flex flex-col gap-4">
      {/* Sprint 18 : flex-wrap ajouté — seule page de liste avec 2 boutons d'en-tête (les
          autres n'en ont qu'un), le groupe droit ("Importer (Excel)" + "Créer une réservation")
          était rogné en dur sur un viewport mobile (390px, aucun scroll possible) plutôt que
          de passer sur une seconde ligne. */}
      <div className="flex flex-wrap items-center justify-between gap-4">
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
          <input
            id="source"
            type="text"
            name="source"
            list="source-suggestions"
            placeholder="Toutes"
            defaultValue={params.source ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
          <datalist id="source-suggestions">
            {SOURCE_SUGGESTIONS.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
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

        <div className="flex flex-col gap-1.5">
          <label htmlFor="pickupAgency" className="text-xs font-medium text-muted-foreground">
            Ville de départ
          </label>
          <select
            id="pickupAgency"
            name="pickupAgency"
            defaultValue={params.pickupAgency ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Toutes</option>
            {agencyOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="dropoffAgency" className="text-xs font-medium text-muted-foreground">
            Ville de retour
          </label>
          <select
            id="dropoffAgency"
            name="dropoffAgency"
            defaultValue={params.dropoffAgency ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Toutes</option>
            {agencyOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="vehicleCategory" className="text-xs font-medium text-muted-foreground">
            Catégorie
          </label>
          <input
            id="vehicleCategory"
            type="text"
            name="vehicleCategory"
            placeholder="Citadine, SUV..."
            defaultValue={params.vehicleCategory ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {(params.status ||
          params.source ||
          params.search ||
          params.from ||
          params.to ||
          params.pickupAgency ||
          params.dropoffAgency ||
          params.vehicleCategory) && (
          <Button render={<Link href="/dashboard/reservations" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <ReservationsTable
        reservations={rows}
        canDelete={canDelete}
        canEdit={canEdit}
        canConvert={canConvert}
        canCancel={canCancel}
        canNoShow={canNoShow}
        isAdmin={isAdmin}
      />
    </div>
  );
}
