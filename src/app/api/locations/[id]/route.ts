import { NextResponse } from "next/server";
import type { LocationStatus, Prisma } from "@prisma/client";
import { getSessionUser, canAccessAgency, canAccessLocationAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import {
  getLocationById,
  updateLocation,
  deleteLocation,
  canTransition,
  InvalidDateRangeError,
  VehicleNotAvailableError,
  VehicleUnavailableForLocationError,
  InvalidStatusTransitionError,
  LocationNotDeletableError,
  LocationHasInvoiceError,
  LocationLockedError,
  LocationCancellationRequiresAdminError,
  LocationStatusConflictError,
  InvalidFuelLevelError,
  SecondDriverNotFoundError,
} from "@/lib/locations";
import { logAction } from "@/lib/audit";

const LOCATION_STATUSES: LocationStatus[] = ["PENDING", "CONFIRMED", "ACTIVE", "COMPLETED", "CANCELLED"];

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "locations.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const location = await getLocationById(user.tenantId, id);

  // Sprint 19 (DOMAINRULES.md section 37) : visible aussi par l'agence de retour
  // (dropoffAgencyId), pas seulement l'agence de rattachement du contrat.
  if (!location || !(await canAccessLocationAgency(user, location))) {
    return NextResponse.json({ error: "Location introuvable." }, { status: 404 });
  }

  return NextResponse.json({ location });
}

interface UpdateLocationBody {
  status?: LocationStatus;
  startDate?: string;
  endDate?: string;
  notes?: string;
  startOdometer?: number | null;
  endOdometer?: number | null;
  /** Sprint 23 — jauge de carburant départ/retour (0-100). */
  startFuelLevel?: number | null;
  endFuelLevel?: number | null;
  deposit?: number | null;
  /** Sprint 19 — second conducteur (voir Location.secondDriverId). */
  secondDriverId?: string | null;
}

/** Sprint 24 — voir le commentaire sur PATCH ci-dessous. */
function requiredPermissionForLocationStatusChange(status: LocationStatus | undefined): string {
  switch (status) {
    case "CONFIRMED":
      return "locations.confirm";
    case "ACTIVE":
      return "locations.activate";
    case "COMPLETED":
      return "locations.complete";
    case "CANCELLED":
      return "locations.cancel";
    default:
      return "locations.edit";
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  let body: UpdateLocationBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  // Sprint 24 : confirmer/activer/terminer/annuler un contrat ne sont plus couvertes par
  // locations.edit (la même clé que la modification de champ) — chaque transition de statut
  // vérifie désormais sa propre clé dédiée. Toute autre valeur (PENDING, ou aucun changement
  // de statut) retombe sur locations.edit, comportement antérieur conservé.
  const requiredPermission = requiredPermissionForLocationStatusChange(body.status);
  if (!(await can(user, requiredPermission))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const location = await getLocationById(user.tenantId, id);

  // Sprint 19 (DOMAINRULES.md section 37) : accessible aussi à l'agence de retour
  // (dropoffAgencyId), pas seulement l'agence de rattachement du contrat.
  if (!location || !(await canAccessLocationAgency(user, location))) {
    return NextResponse.json({ error: "Location introuvable." }, { status: 404 });
  }

  // Sprint 19 : une agence de retour (dropoffAgencyId) qui n'a pas accès à l'agence de
  // rattachement du contrat ne peut que "gérer la réception" — statut vers COMPLETED et
  // kilométrage de retour, rien d'autre (dates/prix/notes/second conducteur restent réservés
  // à l'agence de départ, voir DOMAINRULES.md section 37).
  const hasPickupAccess = await canAccessAgency(user, location.agencyId);
  if (!hasPickupAccess) {
    const allowedKeys = new Set(["status", "endOdometer", "endFuelLevel"]);
    const touchesDisallowedField = (Object.keys(body) as (keyof UpdateLocationBody)[]).some(
      (key) => !allowedKeys.has(key) && body[key] !== undefined
    );
    if (touchesDisallowedField || (body.status && body.status !== "COMPLETED")) {
      return NextResponse.json(
        { error: "L'agence de retour ne peut que gérer la réception du véhicule (statut Terminée, kilométrage retour)." },
        { status: 403 }
      );
    }
  }

  if (body.status && !LOCATION_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }

  const startDate = body.startDate ? new Date(body.startDate) : undefined;
  const endDate = body.endDate ? new Date(body.endDate) : undefined;

  if ((startDate && Number.isNaN(startDate.getTime())) || (endDate && Number.isNaN(endDate.getTime()))) {
    return NextResponse.json({ error: "startDate/endDate doivent être des dates ISO valides." }, { status: 400 });
  }

  for (const field of ["startOdometer", "endOdometer", "deposit"] as const) {
    const fieldValue = body[field];
    if (fieldValue !== undefined && fieldValue !== null && (!Number.isInteger(fieldValue) || fieldValue < 0)) {
      return NextResponse.json({ error: `${field} doit être un entier positif ou nul.` }, { status: 400 });
    }
  }

  // Sprint 19 (DOMAINRULES.md section 37) : un ADMIN peut forcer une transition de statut ou
  // modifier les dates d'un contrat verrouillé — jamais un champ de corps de requête, toujours
  // dérivé de user.role. `wouldOverride` détecte si le contournement est réellement exercé,
  // pour ne journaliser location.admin_override que lorsqu'il change effectivement le
  // comportement normal (jamais pour une modification qui aurait de toute façon été acceptée).
  const isAdmin = user.role === "ADMIN";
  const wouldOverride =
    isAdmin &&
    ((body.status !== undefined && body.status !== location.status && !canTransition(location.status, body.status)) ||
      ((startDate || endDate) && location.status !== "PENDING"));

  try {
    const updated = await updateLocation(user.tenantId, location.id, {
      status: body.status,
      startDate,
      endDate,
      notes: body.notes,
      startOdometer: body.startOdometer,
      endOdometer: body.endOdometer,
      startFuelLevel: body.startFuelLevel,
      endFuelLevel: body.endFuelLevel,
      deposit: body.deposit,
      secondDriverId: body.secondDriverId,
      adminOverride: isAdmin,
    });
    if (wouldOverride) {
      await logAction({
        tenantId: user.tenantId,
        userId: user.id,
        action: "location.admin_override",
        resource: "Location",
        resourceId: location.id,
        metadata: { from: location.status, changes: body } as unknown as Prisma.InputJsonValue,
      });
    }
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: body.status && body.status !== location.status ? "location.status_changed" : "location.updated",
      resource: "Location",
      resourceId: location.id,
      metadata: { from: location.status, changes: body } as unknown as Prisma.InputJsonValue,
    });
    return NextResponse.json({ location: updated });
  } catch (error) {
    if (error instanceof SecondDriverNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof InvalidDateRangeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidStatusTransitionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof LocationLockedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof LocationCancellationRequiresAdminError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof LocationStatusConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidFuelLevelError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof VehicleNotAvailableError) {
      return NextResponse.json(
        { error: error.message, conflictingLocations: error.conflictingLocations },
        { status: 409 }
      );
    }
    // Sprint 28 (Finding E) : véhicule MAINTENANCE/TRANSFERRING/ON_TRIP — s'applique à tout
    // appelant, y compris ADMIN via adminOverride (qui ne contourne que LocationLockedError).
    if (error instanceof VehicleUnavailableForLocationError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    console.error("Erreur lors de la modification de la location :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "locations.delete"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const location = await getLocationById(user.tenantId, id);

  if (!location || !(await canAccessAgency(user, location.agencyId))) {
    return NextResponse.json({ error: "Location introuvable." }, { status: 404 });
  }

  try {
    await deleteLocation(user.tenantId, location.id);
  } catch (error) {
    if (error instanceof LocationNotDeletableError || error instanceof LocationHasInvoiceError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "location.deleted",
    resource: "Location",
    resourceId: location.id,
    metadata: { status: location.status },
  });

  return NextResponse.json({ success: true });
}
