import { notFound } from "next/navigation";
import Link from "next/link";
import { FileText, Download } from "lucide-react";
import { getSessionUser, canAccessAgency, canAccessLocationAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getLocationById } from "@/lib/locations";
import { getLocationChain } from "@/lib/location-chains";
import { getLocationUpgradeByLocationId } from "@/lib/location-upgrades";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/format";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Icon } from "@/components/ui";
import { LocationActions } from "./LocationActions";
import { CreateExtensionButton } from "./CreateExtensionButton";
import { ContractChainSection } from "./ContractChainSection";

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

// Mêmes libellés que UPGRADE_TYPE_OPTIONS (ConvertReservationForm.tsx), raccourcis pour
// l'affichage en lecture seule (contexte déjà donné par le titre de la carte).
const UPGRADE_TYPE_LABELS: Record<string, string> = {
  CUSTOMER_REQUEST: "Demande du client",
  UNAVAILABILITY: "Indisponibilité de la catégorie réservée",
  COMMERCIAL_GESTURE: "Geste commercial",
};

export default async function LocationDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  // Sprint technique 2 : gate manquant découvert en préparant l'affichage de la chaîne
  // contractuelle — contrairement à GET /api/locations/[id] (route.ts, même dossier) et à
  // /dashboard/locations (liste), cette page ne vérifiait jusqu'ici que l'accès à l'agence
  // (canAccessLocationAgency ci-dessous), jamais locations.view : un MEMBER sans cette
  // permission mais avec accès à l'agence (UserAgency) pouvait consulter la fiche complète
  // d'un contrat malgré /dashboard/locations et l'API le lui refusant. Corrigé ici pour
  // rester cohérent avec les deux autres couches, notFound() plutôt qu'un message dédié pour
  // ne jamais distinguer « permission refusée » de « contrat introuvable » (même principe
  // IDOR que le reste de la page).
  if (!(await can(user, "locations.view"))) {
    notFound();
  }

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

  // Sprint 19 : une agence de retour (dropoffAgencyId) sans accès à l'agence de rattachement
  // du contrat ne peut que gérer la réception — voir PATCH /api/locations/[id] pour
  // l'équivalent serveur de cette restriction. La réception n'est jamais qu'une transition
  // vers COMPLETED : elle ne dépend donc que de locations.complete (Sprint 24).
  const hasPickupAccess = await canAccessAgency(user, location.agencyId);
  const canManageFullEdit =
    hasPickupAccess &&
    (hasLocationsEdit || hasLocationsConfirm || hasLocationsActivate || hasLocationsComplete || hasLocationsCancel);
  const canManageReturnOnly = !hasPickupAccess && hasLocationsComplete;

  const isAdmin = user.role === "ADMIN";

  // Sprint technique 1 (DOMAINRULES.md section 60, HANDOFF.md point 43), unique mécanisme
  // officiel depuis le Sprint technique 3 (retrait complet d'extendReturnDate, règle 11) :
  // « Créer une prolongation » — nouveau contrat lié, permission dédiée
  // locations.extension.create (distincte de locations.edit, jamais accordée par défaut).
  // Visible uniquement sur un contrat ACTIVE sans enfant direct déjà existant (chaîne
  // strictement linéaire, DOMAINRULES.md section 60 règle 3) — POST /api/locations/[id]/extend
  // revérifie de toute façon tout ceci côté serveur (src/lib/location-chains.ts), ce contrôle
  // d'affichage n'est qu'un confort.
  const hasExtensionCreate = await can(user, "locations.extension.create");
  const canCreateExtension =
    location.status === "ACTIVE" && hasPickupAccess && (isAdmin || hasExtensionCreate);

  const [vehicle, client, secondDriver, agency, dropoffAgency, invoice, existingChild, upgrade] =
    await Promise.all([
      prisma.vehicle.findUnique({ where: { id: location.vehicleId } }),
      prisma.client.findUnique({ where: { id: location.clientId } }),
      location.secondDriverId ? prisma.client.findUnique({ where: { id: location.secondDriverId } }) : null,
      prisma.agency.findUnique({ where: { id: location.agencyId }, select: { name: true } }),
      location.dropoffAgencyId
        ? prisma.agency.findUnique({ where: { id: location.dropoffAgencyId }, select: { name: true } })
        : null,
      prisma.invoice.findFirst({ where: { locationId: location.id }, orderBy: { createdAt: "desc" } }),
      prisma.location.findFirst({ where: { parentLocationId: location.id }, select: { id: true } }),
      getLocationUpgradeByLocationId(user.tenantId, location.id),
    ]);

  // Sprint technique 2 (DOMAINRULES.md section 60, règle 12) : chaîne contractuelle + soldes
  // (individuel par contrat + consolidé). Erreur contrôlée : une panne de ce bloc de lecture
  // seule (agrégation financière, plusieurs requêtes) ne doit jamais faire échouer l'affichage
  // du reste de la fiche contrat (actions, détails déjà chargés ci-dessus) — capturée ici et
  // journalisée côté serveur, jamais renvoyée telle quelle à l'utilisateur (SECURITY.md section
  // 18), une carte de repli est affichée à la place de la section.
  let chain: Awaited<ReturnType<typeof getLocationChain>> | null = null;
  let chainLoadFailed = false;
  try {
    chain = await getLocationChain(user.tenantId, user, location);
  } catch (error) {
    console.error("Erreur lors du chargement de la chaîne contractuelle :", error);
    chainLoadFailed = true;
  }

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
          {/* Sprint technique 1 (DOMAINRULES.md section 60) — voir CreateExtensionButton.tsx.
              Unique action de prolongation depuis le Sprint technique 3 (extendReturnDate/
              ExtendLocationDialog.tsx retirés). Masqué si une prolongation directe existe déjà
              (chaîne linéaire, POST .../extend revérifie de toute façon
              @@unique(parentLocationId) côté serveur). */}
          {canCreateExtension && !existingChild && (
            <CreateExtensionButton
              parentLocationId={location.id}
              parentEndDate={location.endDate.toISOString()}
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

      {upgrade && (
        <Card>
          <CardHeader>
            <CardTitle>Surclassement</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 text-sm">
            <div className="col-span-2">
              <p className="text-xs font-medium text-muted-foreground">Type</p>
              <p>{UPGRADE_TYPE_LABELS[upgrade.type] ?? upgrade.type}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Catégorie réservée</p>
              <p>{upgrade.reservedCategory}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Catégorie attribuée</p>
              <p>{upgrade.assignedCategory}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Supplément / jour</p>
              <p>{formatMoney(upgrade.dailySupplement, upgrade.currency)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Jours concernés</p>
              <p>{upgrade.daysCount}</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs font-medium text-muted-foreground">Total du supplément</p>
              <p className="font-medium">{formatMoney(upgrade.totalSupplement, upgrade.currency)}</p>
              <p className="text-xs text-muted-foreground">Déjà inclus dans le Total ci-dessus.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {chain ? (
        <ContractChainSection chain={chain} />
      ) : chainLoadFailed ? (
        <Card>
          <CardHeader>
            <CardTitle>Chaîne contractuelle</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Impossible d&apos;afficher la chaîne contractuelle pour le moment. Réessayez plus tard.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <LocationActions
        id={location.id}
        status={location.status}
        notes={location.notes}
        startOdometer={location.startOdometer}
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
        // Sprint technique 3 (DOMAINRULES.md section 60, règle 11) : contrat parent (a un
        // enfant, `existingChild`) ou enfant (`parentLocationId` non nul) d'une chaîne de
        // prolongations — ses dates ne sont plus modifiables via le formulaire administrateur
        // générique (PATCH /api/locations/[id] les refuse désormais sans exception, voir
        // LocationHasExtensionChainError, src/lib/locations.ts) ; ce booléen ne fait que masquer
        // le formulaire côté interface pour éviter l'ambiguïté, jamais la seule protection.
        hasExtensionChain={Boolean(location.parentLocationId) || Boolean(existingChild)}
      />
    </div>
  );
}
