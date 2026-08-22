import { notFound } from "next/navigation";
import Link from "next/link";
import { FileText, Download } from "lucide-react";
import { getSessionUser, canAccessAgency, canAccessLocationAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getLocationById } from "@/lib/locations";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/format";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Icon } from "@/components/ui";
import { LocationActions } from "./LocationActions";
import { ExtendLocationDialog } from "./ExtendLocationDialog";

interface PageProps {
  params: Promise<{ id: string }>;
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  CONFIRMED: "Confirmée",
  ACTIVE: "En cours",
  COMPLETED: "Terminée",
  CANCELLED: "Annulée",
};

export default async function LocationDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  const location = await getLocationById(user.tenantId, id);
  // Sprint 19 (DOMAINRULES.md section 37) : visible aussi par l'agence de retour.
  if (!location || !(await canAccessLocationAgency(user, location))) {
    notFound();
  }

  const hasLocationsEdit = await can(user, "locations.edit");
  // Sprint 24 : Confirmer/Activer/Terminer/Annuler ne sont plus couvertes par locations.edit —
  // clés dédiées, vérifiées par transition cible (voir PATCH /api/locations/[id]/route.ts).
  const hasLocationsConfirm = await can(user, "locations.confirm");
  const hasLocationsActivate = await can(user, "locations.activate");
  const hasLocationsComplete = await can(user, "locations.complete");
  const hasLocationsCancel = await can(user, "locations.cancel");
  // Sprint 13E tâche 2 (DOMAINRULES.md section 52) — voir ExtendLocationDialog.tsx : la
  // permission granulaire n'est requise que pour confirmer explicitement une prolongation
  // malgré un conflit de maintenance réel, jamais pour l'acte de prolonger lui-même (voir le
  // libellé du catalogue, src/lib/permissions.ts) — cohérent avec le contournement de verrou
  // dédié ajouté côté service (updateLocation, `extendReturnDate`).
  const hasMaintenanceConflictOverride = await can(user, "locations.maintenance_conflict.override");

  // Sprint 19 : une agence de retour (dropoffAgencyId) sans accès à l'agence de rattachement
  // du contrat ne peut que gérer la réception — voir PATCH /api/locations/[id] pour
  // l'équivalent serveur de cette restriction. La réception n'est jamais qu'une transition
  // vers COMPLETED : elle ne dépend donc que de locations.complete (Sprint 24).
  const hasPickupAccess = await canAccessAgency(user, location.agencyId);
  const canManageFullEdit =
    hasPickupAccess &&
    (hasLocationsEdit || hasLocationsConfirm || hasLocationsActivate || hasLocationsComplete || hasLocationsCancel);
  const canManageReturnOnly = !hasPickupAccess && hasLocationsComplete;

  // Sprint 13E tâche 2 (DOMAINRULES.md section 52) : « Prolonger la location » — visible
  // seulement pour un contrat ACTIVE (parcours utilisateur demandé), avec le même droit de base
  // qu'une modification de contrat normale (locations.edit + accès agence de rattachement, ou
  // ADMIN). Masqué en interface sans cette base, mais PATCH /api/locations/[id] revérifie de
  // toute façon tout ceci côté serveur (locations.edit) — voir requiredPermissionForLocation
  // StatusChange, src/app/api/locations/[id]/route.ts.
  const isAdmin = user.role === "ADMIN";
  const canExtend = location.status === "ACTIVE" && (isAdmin || (canManageFullEdit && hasLocationsEdit));
  const canConfirmMaintenanceConflict = isAdmin || hasMaintenanceConflictOverride;

  const [vehicle, client, secondDriver, agency, dropoffAgency, invoice] = await Promise.all([
    prisma.vehicle.findUnique({ where: { id: location.vehicleId } }),
    prisma.client.findUnique({ where: { id: location.clientId } }),
    location.secondDriverId ? prisma.client.findUnique({ where: { id: location.secondDriverId } }) : null,
    prisma.agency.findUnique({ where: { id: location.agencyId }, select: { name: true } }),
    location.dropoffAgencyId
      ? prisma.agency.findUnique({ where: { id: location.dropoffAgencyId }, select: { name: true } })
      : null,
    prisma.invoice.findFirst({ where: { locationId: location.id }, orderBy: { createdAt: "desc" } }),
  ]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">
            {location.contractNumber ?? `Location #${location.id.slice(-8)}`}
          </h1>
          <p className="text-sm text-muted-foreground">
            Agence : {agency?.name ?? "—"}
            {dropoffAgency ? ` (retour : ${dropoffAgency.name})` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{STATUS_LABELS[location.status] ?? location.status}</Badge>
          {location.contractNumber && (
            <Button
              render={<a href={`/api/locations/${location.id}/pdf`} target="_blank" rel="noreferrer" />}
              variant="outline"
              size="sm"
            >
              <Icon icon={Download} className="size-4" />
              Contrat PDF
            </Button>
          )}
          {invoice && (
            <Button render={<Link href={`/dashboard/invoices/${invoice.id}`} />} variant="outline" size="sm">
              <Icon icon={FileText} className="size-4" />
              Voir facture
            </Button>
          )}
          {/* Sprint 13E tâche 2 (DOMAINRULES.md section 52) — voir ExtendLocationDialog.tsx. */}
          {canExtend && (
            <ExtendLocationDialog
              id={location.id}
              startDate={location.startDate.toISOString()}
              endDate={location.endDate.toISOString()}
              pricePerDay={location.pricePerDay}
              currency={location.currency}
              totalPrice={location.totalPrice}
              invoice={invoice ? { totalAmount: invoice.totalAmount, amountPaid: invoice.amountPaid } : null}
              canConfirmMaintenanceConflict={canConfirmMaintenanceConflict}
            />
          )}
          {/* Sprint 32 (DOMAINRULES.md section 32) : écran de retour dédié — même condition que
              le bouton "Terminée" de LocationActions.tsx (locations.complete + accès agence,
              départ ou retour). N'existe que pour un contrat ACTIVE ; POST
              /api/locations/[id]/return revérifie de toute façon tout ceci côté serveur. */}
          {location.status === "ACTIVE" && (canManageFullEdit ? hasLocationsComplete : canManageReturnOnly) && (
            <Button render={<Link href={`/dashboard/locations/${location.id}/return`} />} size="sm">
              Retourner le contrat
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Détails</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm">
          {location.contractNumber && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">N° contrat</p>
              <p className="font-medium">{location.contractNumber}</p>
            </div>
          )}
          <div>
            <p className="text-xs font-medium text-muted-foreground">Client</p>
            <p>{client?.name ?? "—"}</p>
          </div>
          {secondDriver && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">2e conducteur</p>
              <p>{secondDriver.name}</p>
            </div>
          )}
          <div>
            <p className="text-xs font-medium text-muted-foreground">Véhicule</p>
            <p>
              {vehicle ? (
                <Link href={`/dashboard/vehicles/${vehicle.id}`} className="text-primary hover:underline">
                  {vehicle.name} ({vehicle.licensePlate})
                </Link>
              ) : (
                "—"
              )}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Période</p>
            <p>
              {location.startDate.toLocaleString("fr-FR")} → {location.endDate.toLocaleString("fr-FR")}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Prix / jour</p>
            <p>{formatMoney(location.pricePerDay, location.currency)}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Total</p>
            <p className="font-medium">{formatMoney(location.totalPrice, location.currency)}</p>
          </div>
          {location.deposit !== null && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Caution</p>
              <p>{formatMoney(location.deposit, location.currency)}</p>
            </div>
          )}
          {(location.startOdometer !== null || location.endOdometer !== null) && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Kilométrage</p>
              <p>
                {location.startOdometer ?? "—"} km → {location.endOdometer ?? "—"} km
              </p>
            </div>
          )}
          {location.notes && (
            <div className="col-span-2">
              <p className="text-xs font-medium text-muted-foreground">Notes</p>
              <p>{location.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <LocationActions
        id={location.id}
        status={location.status}
        notes={location.notes}
        endOdometer={location.endOdometer}
        endFuelLevel={location.endFuelLevel}
        startDate={location.startDate.toISOString().slice(0, 10)}
        endDate={location.endDate.toISOString().slice(0, 10)}
        secondDriver={secondDriver ? { id: secondDriver.id, name: secondDriver.name } : null}
        canEdit={canManageFullEdit && hasLocationsEdit}
        canConfirm={canManageFullEdit && hasLocationsConfirm}
        canActivate={canManageFullEdit && hasLocationsActivate}
        canComplete={canManageFullEdit && hasLocationsComplete}
        canCancel={canManageFullEdit && hasLocationsCancel}
        canManageReturnOnly={canManageReturnOnly}
        isAdmin={isAdmin}
      />
    </div>
  );
}
