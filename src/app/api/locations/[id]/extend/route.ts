import { NextResponse } from "next/server";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { VehicleDeactivatedError } from "@/lib/vehicle-status";
import {
  getLocationById,
  InvalidDateRangeError,
  ClientNotFoundError,
  VehicleNotFoundError,
  VehicleNotAvailableError,
  VehicleUnavailableForLocationError,
  VehicleMaintenanceConflictError,
  MissingPriceError,
  InvalidFuelLevelError,
  MissingDriverLicenseExpiryError,
  DriverLicenseExpiredError,
} from "@/lib/locations";
import {
  createLocationExtension,
  LocationExtensionParentNotFoundError,
  LocationExtensionParentNotActiveError,
  LocationExtensionParentHasChildError,
} from "@/lib/location-chains";
import { InvalidInvoiceAmountError } from "@/lib/invoices";

/**
 * Sprint technique 1 (DOMAINRULES.md section 60, HANDOFF.md point 43) : création d'une
 * prolongation comme nouveau contrat indépendant — nouvelle route, distincte de
 * PATCH /api/locations/[id] (extendReturnDate, non modifiée, non utilisée par ce parcours).
 */

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface CreateExtensionBody {
  endDate?: string;
  /** Nouvelle agence de référence (DOMAINRULES.md section 60, règle 5) — omise = celle du
   * contrat parent. */
  agencyId?: string;
  /** Nouveau véhicule (règle 4) — omis = celui du contrat parent. */
  vehicleId?: string;
  notes?: string;
  startOdometer?: number;
  endOdometer?: number;
  startFuelLevel?: number;
  endFuelLevel?: number;
  deposit?: number;
  pricePerDay?: number;
  totalPrice?: number;
  discountAmount?: number;
  taxRate?: number;
}

export async function POST(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  // Étape 4 : permission dédiée, distincte de locations.create (DOMAINRULES.md section 60,
  // règle 10) — refusée par défaut à tout groupe, y compris MEMBER (src/lib/permissions.ts).
  if (!(await can(user, "locations.extension.create"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const parent = await getLocationById(user.tenantId, id);
  // Étapes 2/3 : tenant (getLocationById déjà scopé) + agence autorisée. Accès à l'agence de
  // départ du contrat parent uniquement (pas la seule agence de retour, canAccessLocationAgency)
  // : créer une prolongation est assimilé à créer un contrat, pas à gérer une réception.
  if (!parent || !(await canAccessAgency(user, parent.agencyId))) {
    return NextResponse.json({ error: "Contrat introuvable." }, { status: 404 });
  }

  let body: CreateExtensionBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (!body.endDate) {
    return NextResponse.json({ error: "endDate est requis." }, { status: 400 });
  }
  const endDate = new Date(body.endDate);
  if (Number.isNaN(endDate.getTime())) {
    return NextResponse.json({ error: "endDate doit être une date ISO valide." }, { status: 400 });
  }

  // Changement d'agence (règle 5) : la nouvelle agence doit elle aussi être autorisée pour cet
  // utilisateur, indépendamment de l'agence du contrat parent déjà vérifiée ci-dessus.
  if (body.agencyId && !(await canAccessAgency(user, body.agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  for (const field of ["startOdometer", "endOdometer", "deposit"] as const) {
    const fieldValue = body[field];
    if (fieldValue !== undefined && (!Number.isInteger(fieldValue) || fieldValue < 0)) {
      return NextResponse.json({ error: `${field} doit être un entier positif ou nul.` }, { status: 400 });
    }
  }

  // Sprint technique 1 (DOMAINRULES.md section 60, règle 7) : une prolongation gratuite ou
  // partiellement gratuite est explicitement autorisée — contrairement à POST /api/locations
  // (pricePerDay strictement positif), 0 est accepté ici ; seule une valeur négative ou non
  // entière est refusée. Même principe pour totalPrice/discountAmount/taxRate ci-dessous.
  if (body.pricePerDay !== undefined && (!Number.isInteger(body.pricePerDay) || body.pricePerDay < 0)) {
    return NextResponse.json({ error: "pricePerDay doit être un entier positif ou nul (centimes)." }, { status: 400 });
  }
  if (body.totalPrice !== undefined && (!Number.isInteger(body.totalPrice) || body.totalPrice < 0)) {
    return NextResponse.json({ error: "totalPrice doit être un entier positif ou nul (centimes)." }, { status: 400 });
  }
  if (body.discountAmount !== undefined && (!Number.isInteger(body.discountAmount) || body.discountAmount < 0)) {
    return NextResponse.json({ error: "discountAmount doit être un entier positif ou nul." }, { status: 400 });
  }
  if (body.taxRate !== undefined && (!Number.isInteger(body.taxRate) || body.taxRate < 0)) {
    return NextResponse.json({ error: "taxRate doit être un entier positif ou nul (points de base)." }, { status: 400 });
  }

  try {
    // Étapes 5 à 15 : transaction atomique unique (verrou parent, vérifications, numérotation,
    // création du contrat + de sa facture + de l'audit) — voir src/lib/location-chains.ts.
    // Idempotence (contrainte du sprint) : une nouvelle tentative sur un parent déjà prolongé
    // échoue proprement (LocationExtensionParentHasChildError, 409, garanti en dernier ressort
    // par @@unique(parentLocationId)) plutôt que de créer un doublon.
    const { location, invoice } = await createLocationExtension({
      tenantId: user.tenantId,
      userId: user.id,
      parentLocationId: parent.id,
      agencyId: body.agencyId,
      vehicleId: body.vehicleId,
      endDate,
      notes: body.notes,
      startOdometer: body.startOdometer,
      endOdometer: body.endOdometer,
      startFuelLevel: body.startFuelLevel,
      endFuelLevel: body.endFuelLevel,
      deposit: body.deposit,
      pricePerDay: body.pricePerDay,
      totalPrice: body.totalPrice,
      discountAmount: body.discountAmount,
      taxRate: body.taxRate,
    });

    return NextResponse.json({ location, invoice }, { status: 201 });
  } catch (error) {
    if (error instanceof LocationExtensionParentNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (
      error instanceof LocationExtensionParentNotActiveError ||
      error instanceof LocationExtensionParentHasChildError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidDateRangeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ClientNotFoundError || error instanceof VehicleNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof VehicleNotAvailableError) {
      return NextResponse.json(
        { error: error.message, conflictingLocations: error.conflictingLocations },
        { status: 409 }
      );
    }
    if (error instanceof VehicleUnavailableForLocationError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof VehicleDeactivatedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof VehicleMaintenanceConflictError) {
      return NextResponse.json(
        { error: error.message, conflictingMaintenances: error.conflictingMaintenances },
        { status: 409 }
      );
    }
    if (error instanceof MissingPriceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof MissingDriverLicenseExpiryError || error instanceof DriverLicenseExpiredError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidFuelLevelError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Remise/TVA dépassant le sous-total de la prolongation (computeInvoiceTotals,
    // src/lib/invoices.ts) — la transaction entière est déjà annulée à ce stade (rollback
    // complet garanti par prisma.$transaction dans createLocationExtension), rien à nettoyer ici.
    if (error instanceof InvalidInvoiceAmountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("Erreur lors de la création de la prolongation :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
