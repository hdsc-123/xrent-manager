"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPatch, apiPost, ApiError } from "@/lib/api";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@/components/ui";
import { FuelLevelSelect } from "@/components/ui/fuel-level-select";

type LocationStatus = "PENDING" | "CONFIRMED" | "ACTIVE" | "COMPLETED" | "CANCELLED";

/** Miroir client de la machine à états de src/lib/locations.ts (ALLOWED_TRANSITIONS). */
const ALLOWED_TRANSITIONS: Record<LocationStatus, LocationStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

const STATUS_LABELS: Record<LocationStatus, string> = {
  PENDING: "En attente",
  CONFIRMED: "Confirmée",
  ACTIVE: "En cours",
  COMPLETED: "Terminée",
  CANCELLED: "Annulée",
};

interface LocationActionsProps {
  id: string;
  status: LocationStatus;
  notes: string | null;
  /** BUG-005 (INCIDENTS.md) — sert de borne minimale/message pour endOdometer ci-dessous ;
   * `null` si jamais renseigné (aucune borne applicable, voir assertValidReturnOdometer,
   * src/lib/locations.ts). */
  startOdometer: number | null;
  endOdometer: number | null;
  /** Sprint 23 — carburant retour actuel (0-100), null si jamais renseigné. */
  endFuelLevel: number | null;
  /** Sprint 19 — dates actuelles (YYYY-MM-DD), pour le formulaire de modification réservé
   * ADMIN ci-dessous — seul point d'accès UI à adminOverride pour les dates, voir
   * PATCH /api/locations/[id]/route.ts. */
  startDate: string;
  endDate: string;
  /** Sprint 19 — second conducteur actuel (Location.secondDriverId), null si aucun. */
  secondDriver: { id: string; name: string } | null;
  /** locations.edit ET accès à l'agence de rattachement (pas seulement l'agence de retour) —
   * gate les notes/dates/second conducteur, calculé côté serveur par la page appelante.
   * Même pattern que ReservationActions. */
  canEdit: boolean;
  /** Sprint 24 — locations.confirm ET accès à l'agence de rattachement, distincte de
   * canEdit : PENDING → CONFIRMED. */
  canConfirm: boolean;
  /** Sprint 24 — locations.activate ET accès à l'agence de rattachement : CONFIRMED → ACTIVE. */
  canActivate: boolean;
  /** Sprint 24 — locations.complete ET accès à l'agence de rattachement : → COMPLETED. */
  canComplete: boolean;
  /** Sprint 24 — locations.cancel ET accès à l'agence de rattachement : PENDING → CANCELLED
   * (seule transition CANCELLED encore atteignable via cette route, voir
   * LocationCancellationRequiresAdminError). */
  canCancel: boolean;
  /** Sprint 19 (DOMAINRULES.md section 37) : accès uniquement via l'agence de retour
   * (dropoffAgencyId) — ne peut que "gérer la réception" (statut → Terminée, kilométrage
   * retour), jamais les dates/prix/notes/second conducteur. Mutuellement exclusif avec
   * canEdit (jamais les deux à true en même temps). */
  canManageReturnOnly: boolean;
  /** Sprint 19 — role ADMIN : tous les statuts deviennent sélectionnables (pas seulement les
   * transitions autorisées) et les dates redeviennent modifiables à tout statut (override
   * serveur, systématiquement journalisé — voir DOMAINRULES.md section 37). */
  isAdmin: boolean;
  /** Sprint technique 3 (DOMAINRULES.md section 60, règle 11) : ce contrat fait partie d'une
   * chaîne de prolongations (a un enfant direct, ou a lui-même un parent) — ses dates ne sont
   * plus modifiables via le formulaire administrateur générique ci-dessous, quel que soit le
   * rôle (PATCH /api/locations/[id] les refuse désormais sans exception, voir
   * LocationHasExtensionChainError, src/lib/locations.ts). Masque le formulaire au profit d'une
   * explication, plutôt que de laisser l'utilisateur découvrir le refus après soumission. */
  hasExtensionChain: boolean;
}

export function LocationActions({
  id,
  status,
  notes: initialNotes,
  startOdometer,
  endOdometer: initialEndOdometer,
  endFuelLevel: initialEndFuelLevel,
  startDate: initialStartDate,
  endDate: initialEndDate,
  secondDriver,
  canEdit,
  canConfirm,
  canActivate,
  canComplete,
  canCancel,
  canManageReturnOnly,
  isAdmin,
  hasExtensionChain,
}: LocationActionsProps) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [endOdometer, setEndOdometer] = useState(
    initialEndOdometer !== null ? String(initialEndOdometer) : ""
  );
  const [endFuelLevel, setEndFuelLevel] = useState(
    initialEndFuelLevel !== null ? String(initialEndFuelLevel) : ""
  );
  // BUG-005 (INCIDENTS.md) — même règle que le serveur (assertValidReturnOdometer,
  // src/lib/locations.ts) : affichage immédiat, la validation qui compte reste côté serveur.
  const odometerError =
    startOdometer !== null && endOdometer !== "" && Number(endOdometer) <= startOdometer
      ? `Le kilométrage de retour doit être strictement supérieur au kilométrage de départ (${startOdometer} km).`
      : null;
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [isSavingNotes, setIsSavingNotes] = useState(false);
  const [showSecondDriverForm, setShowSecondDriverForm] = useState(false);
  const [secondDriverFirstName, setSecondDriverFirstName] = useState("");
  const [secondDriverLastName, setSecondDriverLastName] = useState("");
  const [secondDriverPhone, setSecondDriverPhone] = useState("");
  const [isSavingSecondDriver, setIsSavingSecondDriver] = useState(false);
  const [showAdminDatesForm, setShowAdminDatesForm] = useState(false);
  const [adminStartDate, setAdminStartDate] = useState(initialStartDate);
  const [adminEndDate, setAdminEndDate] = useState(initialEndDate);
  const [isSavingAdminDates, setIsSavingAdminDates] = useState(false);
  const [showAdminCancelDialog, setShowAdminCancelDialog] = useState(false);
  const [isAdminCancelling, setIsAdminCancelling] = useState(false);
  const [adminCancelReason, setAdminCancelReason] = useState("");
  const trimmedAdminCancelReason = adminCancelReason.trim();

  async function handleTransition(next: LocationStatus) {
    setIsChangingStatus(true);
    try {
      // Sprint 18 : inclut le kilométrage retour déjà saisi dans le champ juste en dessous —
      // jusqu'ici seul le bouton "Enregistrer" des Notes l'envoyait, alors que le geste naturel
      // pour clôturer un retour est de saisir le kilométrage puis de cliquer directement sur
      // "Terminée" : la valeur tapée était silencieusement perdue (aucun message d'erreur), le
      // contrat passait COMPLETED sans kilométrage de retour enregistré. Un champ inchangé
      // renvoie sa valeur déjà en base (no-op), jamais un effacement accidentel.
      await apiPatch(`/api/locations/${id}`, {
        status: next,
        endOdometer: endOdometer ? Number(endOdometer) : null,
        endFuelLevel: endFuelLevel ? Number(endFuelLevel) : null,
      });
      toast.success(`Statut mis à jour : ${STATUS_LABELS[next]}.`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors du changement de statut.");
    } finally {
      setIsChangingStatus(false);
    }
  }

  async function handleSaveNotes() {
    setIsSavingNotes(true);
    try {
      await apiPatch(`/api/locations/${id}`, {
        notes,
        endOdometer: endOdometer ? Number(endOdometer) : null,
        endFuelLevel: endFuelLevel ? Number(endFuelLevel) : null,
      });
      toast.success("Notes enregistrées.");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de l'enregistrement.");
    } finally {
      setIsSavingNotes(false);
    }
  }

  async function handleSaveSecondDriver() {
    if (!secondDriverFirstName || !secondDriverLastName) {
      toast.error("Le prénom et le nom du second conducteur sont requis.");
      return;
    }
    setIsSavingSecondDriver(true);
    try {
      const { client } = await apiPost<{ client: { id: string } }>("/api/clients", {
        name: `${secondDriverFirstName} ${secondDriverLastName}`.trim(),
        firstName: secondDriverFirstName,
        lastName: secondDriverLastName,
        phone: secondDriverPhone || undefined,
      });
      await apiPatch(`/api/locations/${id}`, { secondDriverId: client.id });
      toast.success("Second conducteur ajouté.");
      setShowSecondDriverForm(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de l'enregistrement.");
    } finally {
      setIsSavingSecondDriver(false);
    }
  }

  // Sprint 23 (DOMAINRULES.md section 39) — annulation d'un contrat validé avec réversibilité
  // financière complète (factures + caisse) : POST dédié, distinct de la transition PATCH
  // normale (toujours refusée pour un contrat validé, voir LocationCancellationRequiresAdminError,
  // src/lib/locations.ts).
  async function handleAdminCancel() {
    // Correction QA 2026-09-01 (INCIDENTS.md) — la route exige un motif non vide
    // (voir POST /api/locations/[id]/admin-cancel) ; ce bouton envoyait jusqu'ici un corps vide
    // et échouait systématiquement avec « Un motif est obligatoire... ». Le motif est désormais
    // saisi explicitement par l'utilisateur et validé côté client avant l'appel, en plus de la
    // validation serveur existante (conservée telle quelle, jamais contournée).
    if (!trimmedAdminCancelReason) {
      toast.error("Un motif est obligatoire pour annuler ce contrat.");
      return;
    }
    setIsAdminCancelling(true);
    try {
      await apiPost(`/api/locations/${id}/admin-cancel`, { reason: trimmedAdminCancelReason });
      toast.success("Contrat annulé (factures et caisse mises à jour).");
      setShowAdminCancelDialog(false);
      setAdminCancelReason("");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de l'annulation.");
    } finally {
      setIsAdminCancelling(false);
    }
  }

  async function handleSaveAdminDates() {
    setIsSavingAdminDates(true);
    try {
      await apiPatch(`/api/locations/${id}`, { startDate: adminStartDate, endDate: adminEndDate });
      toast.success("Dates modifiées (override administrateur).");
      setShowAdminDatesForm(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de l'enregistrement.");
    } finally {
      setIsSavingAdminDates(false);
    }
  }

  const hasAnyStatusPermission = canConfirm || canActivate || canComplete || canCancel;

  if (!canEdit && !hasAnyStatusPermission && !canManageReturnOnly) {
    return null;
  }

  // Sprint 19 (DOMAINRULES.md section 37) : l'agence de retour (dropoffAgencyId) sans accès à
  // l'agence de rattachement du contrat ne peut que gérer la réception — statut vers Terminée
  // et kilométrage retour, rien d'autre (PATCH /api/locations/[id] rejette le reste côté
  // serveur de toute façon, ce rendu évite juste de proposer des actions vouées à échouer).
  if (canManageReturnOnly) {
    const canComplete = status === "ACTIVE";
    return (
      <Card>
        <CardHeader>
          <CardTitle>Réception du véhicule</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Kilométrage retour</span>
            <Input
              type="number"
              min={startOdometer !== null ? startOdometer + 1 : 0}
              value={endOdometer}
              onChange={(e) => setEndOdometer(e.target.value)}
            />
            {odometerError && (
              <p role="alert" className="text-sm text-destructive">
                {odometerError}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="endFuelLevelReturn">Carburant retour</Label>
            <FuelLevelSelect id="endFuelLevelReturn" value={endFuelLevel} onChange={setEndFuelLevel} />
          </div>
          {canComplete ? (
            <Button type="button" disabled={isChangingStatus} onClick={() => handleTransition("COMPLETED")}>
              {isChangingStatus ? "Enregistrement..." : "Marquer Terminée"}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Statut actuel : {STATUS_LABELS[status]} — la réception ne s&apos;enregistre que sur un contrat en cours.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  const rawAllowedNextStatuses = ALLOWED_TRANSITIONS[status];
  // Sprint 23 (DOMAINRULES.md section 39) : un contrat déjà validé (sorti de PENDING) ne peut
  // plus être annulé via cette transition simple, même pour un ADMIN (PATCH le refuse
  // systématiquement, voir LocationCancellationRequiresAdminError) — retirée des transitions
  // proposées, remplacée par l'action dédiée « Annuler ce contrat (administrateur) » plus bas,
  // seule voie qui orchestre aussi la réversibilité financière (factures/caisse).
  const isValidatedContract = status !== "PENDING" && status !== "CANCELLED";
  // Sprint 24 : chaque transition croise désormais le statut (machine à états, inchangée) ET
  // sa propre permission (locations.confirm/activate/complete/cancel) — plus locations.edit.
  const permissionForTarget: Record<LocationStatus, boolean> = {
    PENDING: false,
    CONFIRMED: canConfirm,
    ACTIVE: canActivate,
    COMPLETED: canComplete,
    CANCELLED: canCancel,
  };
  const allowedNextStatuses = rawAllowedNextStatuses.filter(
    (candidate) => !(candidate === "CANCELLED" && isValidatedContract) && permissionForTarget[candidate]
  );
  const otherStatuses = (Object.keys(STATUS_LABELS) as LocationStatus[]).filter(
    (candidate) => candidate !== status && candidate !== "CANCELLED" && !rawAllowedNextStatuses.includes(candidate)
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {(hasAnyStatusPermission || isAdmin) && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Changer le statut</span>
          {allowedNextStatuses.length === 0 && !isAdmin ? (
            <p className="text-sm text-muted-foreground">
              Statut terminal ({STATUS_LABELS[status]}) — aucune transition possible.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {allowedNextStatuses.map((next) => (
                <Button
                  key={next}
                  type="button"
                  size="sm"
                  variant={next === "CANCELLED" ? "destructive" : "default"}
                  disabled={isChangingStatus}
                  onClick={() => handleTransition(next)}
                >
                  {STATUS_LABELS[next]}
                </Button>
              ))}
            </div>
          )}
          {/* Sprint 19 (DOMAINRULES.md section 37) : un ADMIN peut forcer n'importe quelle
              transition, pas seulement celles autorisées par la machine à états — contournement
              serveur systématiquement journalisé (location.admin_override), voir
              PATCH /api/locations/[id]/route.ts. Séparé visuellement des transitions normales
              pour ne jamais confondre une action standard avec un forçage. */}
          {isAdmin && otherStatuses.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-2">
              <span className="text-xs font-medium text-warning">Forcer un statut (action administrateur)</span>
              <div className="flex flex-wrap gap-2">
                {otherStatuses.map((next) => (
                  <Button
                    key={next}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isChangingStatus}
                    onClick={() => handleTransition(next)}
                  >
                    {STATUS_LABELS[next]}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {/* Sprint 23 (DOMAINRULES.md section 39) — annulation d'un contrat validé, réservée
              ADMIN : distincte des transitions ci-dessus, orchestre aussi l'annulation des
              factures et la réversibilité financière (écritures de caisse de compensation),
              voir POST /api/locations/[id]/admin-cancel. */}
          {isAdmin && isValidatedContract && (
            <div className="flex flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2">
              <span className="text-xs font-medium text-destructive">
                Annuler ce contrat (action administrateur)
              </span>
              <p className="text-xs text-muted-foreground">
                Annule le contrat, ses factures et compense les paiements déjà encaissés en caisse — sans jamais
                effacer l&apos;historique.
              </p>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                className="w-fit"
                onClick={() => setShowAdminCancelDialog(true)}
              >
                Annuler ce contrat
              </Button>
            </div>
          )}
        </div>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Kilométrage retour</span>
          <Input
            type="number"
            min={startOdometer !== null ? startOdometer + 1 : 0}
            value={endOdometer}
            onChange={(e) => setEndOdometer(e.target.value)}
          />
          {odometerError && (
            <p role="alert" className="text-sm text-destructive">
              {odometerError}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="endFuelLevelMain">Carburant retour</Label>
          <FuelLevelSelect id="endFuelLevelMain" value={endFuelLevel} onChange={setEndFuelLevel} />
        </div>

        {isAdmin && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Dates (action administrateur)</span>
            {hasExtensionChain ? (
              // Sprint technique 3 (DOMAINRULES.md section 60, règle 11) : contrat parent ou
              // enfant d'une chaîne de prolongations — le serveur refuse désormais toute
              // modification de dates ici, sans exception (LocationHasExtensionChainError) ;
              // formulaire masqué plutôt que de laisser échouer une soumission.
              <p className="text-sm text-muted-foreground">
                Ce contrat fait partie d&apos;une chaîne de prolongations : ses dates ne sont plus
                modifiables directement. Utilisez le mécanisme officiel de prolongation, plus haut
                sur cette fiche, pour l&apos;étendre.
              </p>
            ) : showAdminDatesForm ? (
              <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-2">
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="adminStartDate">Départ</Label>
                    <Input
                      id="adminStartDate"
                      type="date"
                      value={adminStartDate}
                      onChange={(e) => setAdminStartDate(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="adminEndDate">Retour</Label>
                    <Input
                      id="adminEndDate"
                      type="date"
                      value={adminEndDate}
                      onChange={(e) => setAdminEndDate(e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={isSavingAdminDates}
                    onClick={handleSaveAdminDates}
                    className="w-fit"
                  >
                    {isSavingAdminDates ? "Enregistrement..." : "Enregistrer"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setShowAdminDatesForm(false)}
                    className="w-fit"
                  >
                    Annuler
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-fit"
                onClick={() => setShowAdminDatesForm(true)}
              >
                Modifier les dates
              </Button>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Notes</span>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-fit"
            disabled={isSavingNotes}
            onClick={handleSaveNotes}
          >
            {isSavingNotes ? "Enregistrement..." : "Enregistrer"}
          </Button>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Second conducteur</span>
          {secondDriver ? (
            <p className="text-sm">{secondDriver.name}</p>
          ) : showSecondDriverForm ? (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="secondDriverFirstName" required>Prénom</Label>
                  <Input
                    id="secondDriverFirstName"
                    required
                    value={secondDriverFirstName}
                    onChange={(e) => setSecondDriverFirstName(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="secondDriverLastName" required>Nom</Label>
                  <Input
                    id="secondDriverLastName"
                    required
                    value={secondDriverLastName}
                    onChange={(e) => setSecondDriverLastName(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="secondDriverPhone">
                  Téléphone <span className="text-muted-foreground">— optionnel</span>
                </Label>
                <Input
                  id="secondDriverPhone"
                  value={secondDriverPhone}
                  onChange={(e) => setSecondDriverPhone(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={isSavingSecondDriver}
                  onClick={handleSaveSecondDriver}
                  className="w-fit"
                >
                  {isSavingSecondDriver ? "Enregistrement..." : "Ajouter"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setShowSecondDriverForm(false)}
                  className="w-fit"
                >
                  Annuler
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => setShowSecondDriverForm(true)}
            >
              Ajouter un second conducteur
            </Button>
          )}
        </div>
      </CardContent>

      <Dialog
        open={showAdminCancelDialog}
        onOpenChange={(open) => {
          setShowAdminCancelDialog(open);
          if (!open) {
            setAdminCancelReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Annuler ce contrat ?</DialogTitle>
            <DialogDescription>
              Le contrat sera marqué « Annulée » (conservé, jamais supprimé), ses factures seront annulées et
              chaque paiement déjà encaissé sera compensé par une écriture de caisse — sans jamais modifier
              l&apos;historique des paiements existants. Cette action est irréversible.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="adminCancelReason" required>
              Motif de l&apos;annulation
            </Label>
            <Input
              id="adminCancelReason"
              value={adminCancelReason}
              onChange={(e) => setAdminCancelReason(e.target.value)}
              placeholder="Ex. : erreur de saisie, demande client, doublon..."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdminCancelDialog(false)}>
              Retour
            </Button>
            <Button
              variant="destructive"
              onClick={handleAdminCancel}
              disabled={isAdminCancelling || !trimmedAdminCancelReason}
            >
              {isAdminCancelling ? "Annulation..." : "Annuler ce contrat"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
