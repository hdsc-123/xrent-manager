import { NextResponse } from "next/server";
import type { VehicleStatus, TransmissionType, FuelType } from "@prisma/client";
import { getSessionUser, canAccessAgency, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehicles, createVehicle, type VehicleFilters } from "@/lib/vehicles";
import { logAction } from "@/lib/audit";

const VEHICLE_STATUSES: VehicleStatus[] = ["AVAILABLE", "RENTED", "MAINTENANCE", "TRANSFERRING", "ON_TRIP"];
const TRANSMISSION_TYPES: TransmissionType[] = ["MANUELLE", "AUTOMATIQUE"];
const FUEL_TYPES: FuelType[] = ["ESSENCE", "DIESEL", "HYBRIDE", "ELECTRIQUE"];

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export async function GET(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "vehicles.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const agencyIdParam = searchParams.get("agencyId") ?? undefined;
  const statusParam = searchParams.get("status") ?? undefined;
  const categoryParam = searchParams.get("category") ?? undefined;
  const searchParam = searchParams.get("search") ?? undefined;
  const excludeDeactivatedParam = searchParams.get("excludeDeactivated") === "true";

  if (statusParam && !VEHICLE_STATUSES.includes(statusParam as VehicleStatus)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);

  if (agencyIdParam && !(await canAccessAgency(user, agencyIdParam))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  const filters: VehicleFilters = {
    agencyId: agencyIdParam,
    status: statusParam as VehicleStatus | undefined,
    category: categoryParam,
    search: searchParam,
    excludeDeactivated: excludeDeactivatedParam,
  };

  const vehicles = await getVehicles(user.tenantId, filters);

  // Un MEMBER ne voit que les véhicules des agences auxquelles il est rattaché
  // (SECURITY.md section 2) — filtrage supplémentaire si aucune agence précise n'a été demandée.
  const visibleVehicles =
    accessibleAgencyIds === null || agencyIdParam
      ? vehicles
      : vehicles.filter((vehicle) => accessibleAgencyIds.includes(vehicle.agencyId));

  return NextResponse.json({ vehicles: visibleVehicles });
}

interface CreateVehicleBody {
  agencyId?: string;
  name?: string;
  licensePlate?: string;
  make?: string;
  model?: string;
  year?: number;
  category?: string;
  // `status` volontairement absent (sprint "statut opérationnel automatique", 2026-08-28) :
  // toute valeur envoyée par le client est explicitement rejetée ci-dessous plutôt qu'ignorée
  // silencieusement, pour signaler clairement à tout appelant API que ce champ n'est plus
  // saisissable — le statut initial est toujours AVAILABLE (défaut du schéma).
  status?: unknown;
  pricePerDay?: number;
  // Sprint technique 5 (audit de sécurité) : `currency` retiré de ce type — jamais exposé par le
  // formulaire dashboard, jamais validé côté serveur (aucune liste blanche, contrairement à
  // status/transmission/fuel ci-dessus), et propagé sans contrôle à toute Location créée depuis
  // ce véhicule (`currency: vehicle.currency`, src/lib/locations.ts) puis à l'Invoice/Payment/
  // CashEntry associés — un simple appel API sans passer par l'interface pouvait ainsi introduire
  // une devise arbitraire non gardée, faussant silencieusement les agrégats financiers
  // (src/lib/reports.ts, getVehiclePerformanceReport) qui additionnent des montants sans jamais
  // les regrouper par devise. Toute nouvelle Vehicle reçoit désormais systématiquement la valeur
  // par défaut du schéma ("MAD", seule devise réellement en usage — voir HANDOFF.md point 22).
  ww?: string;
  chassisNumber?: string;
  color?: string;
  doors?: number;
  seats?: number;
  transmission?: TransmissionType;
  fuel?: FuelType;
  horsepower?: number;
  powerKW?: number;
  engineSize?: number;
  ac?: boolean;
  gps?: boolean;
  imageUrl?: string;
  /** Sprint 24 — kilométrage/carburant actuels à la création. */
  currentOdometer?: number;
  currentFuelLevel?: number;
  /** Sprint 19 (DOMAINRULES.md section 37) — alertes proactives, dates ISO. */
  insuranceExpiryDate?: string;
  vignetteExpiryDate?: string;
  technicalInspectionExpiryDate?: string;
  nextOilChangeDate?: string;
  nextOilChangeKm?: number;
}

const OPTIONAL_DATE_FIELDS = [
  "insuranceExpiryDate",
  "vignetteExpiryDate",
  "technicalInspectionExpiryDate",
  "nextOilChangeDate",
] as const;

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "vehicles.create"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  let body: CreateVehicleBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { agencyId, name, licensePlate, make, model, year, category, pricePerDay } = body;

  if (!agencyId || !name || !licensePlate || !make || !model || !year || !category) {
    return NextResponse.json(
      { error: "agencyId, name, licensePlate, make, model, year et category sont requis." },
      { status: 400 }
    );
  }

  // Sprint 24-2 (brief explicite du propriétaire du projet, revient sur la décision Sprint 24-1
  // ci-dessus, qui avait délibérément écarté un rejet serveur strict pour ne pas casser le
  // contrat API Sprint 12A) : ces 7 champs de fiche technique deviennent obligatoires côté API,
  // à la création comme en modification — absents/null/vides refusés explicitement, jamais
  // remplacés par une valeur par défaut. `pricePerDay` reste volontairement en dehors de cette
  // liste (DOMAINRULES.md section 5 : purement informatif, jamais requis). Voir DOMAINRULES.md
  // section 42 pour le détail complet de ce revirement assumé.
  if (typeof body.chassisNumber !== "string" || body.chassisNumber.trim() === "") {
    return NextResponse.json({ error: "chassisNumber est requis." }, { status: 400 });
  }
  if (typeof body.color !== "string" || body.color.trim() === "") {
    return NextResponse.json({ error: "color est requis." }, { status: 400 });
  }
  for (const field of ["doors", "seats", "horsepower", "powerKW"] as const) {
    const fieldValue = body[field];
    if (fieldValue === undefined || fieldValue === null || !Number.isInteger(fieldValue) || fieldValue <= 0) {
      return NextResponse.json(
        { error: `${field} est requis et doit être un entier positif.` },
        { status: 400 }
      );
    }
  }
  if (
    body.engineSize === undefined ||
    body.engineSize === null ||
    !Number.isFinite(body.engineSize) ||
    body.engineSize <= 0
  ) {
    return NextResponse.json(
      { error: "engineSize est requis et doit être un nombre positif." },
      { status: 400 }
    );
  }

  // pricePerDay est optionnel depuis le Sprint 14A (purement informatif, voir
  // DOMAINRULES.md section 5/7) — validé uniquement s'il est fourni.
  if (pricePerDay !== undefined && (!Number.isInteger(pricePerDay) || pricePerDay <= 0)) {
    return NextResponse.json(
      { error: "pricePerDay doit être un entier positif (centimes)." },
      { status: 400 }
    );
  }

  // Sprint 18 : plafond haut ajouté (aucune borne supérieure jusqu'ici — une faute de frappe
  // plausible, ex. "2205" au lieu de "2025", passait sans erreur). +1 an tolère un millésime
  // commercial déjà annoncé avant le changement d'année civile.
  if (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear() + 1) {
    return NextResponse.json({ error: "year invalide." }, { status: 400 });
  }

  if (body.status !== undefined) {
    return NextResponse.json(
      { error: "Le statut opérationnel d'un véhicule est toujours calculé automatiquement par le serveur — il ne peut pas être choisi à la création." },
      { status: 400 }
    );
  }

  if (body.transmission && !TRANSMISSION_TYPES.includes(body.transmission)) {
    return NextResponse.json({ error: "transmission invalide." }, { status: 400 });
  }

  if (body.fuel && !FUEL_TYPES.includes(body.fuel)) {
    return NextResponse.json({ error: "fuel invalide." }, { status: 400 });
  }

  if (
    body.nextOilChangeKm !== undefined &&
    (!Number.isInteger(body.nextOilChangeKm) || body.nextOilChangeKm < 0)
  ) {
    return NextResponse.json({ error: "nextOilChangeKm doit être un entier positif ou nul." }, { status: 400 });
  }

  // Sprint 24 : kilométrage/carburant actuels — mêmes bornes que les champs équivalents des
  // transferts/bons de déplacement (src/lib/vehicle-transfers.ts, src/lib/vehicle-trips.ts).
  if (
    body.currentOdometer !== undefined &&
    (!Number.isInteger(body.currentOdometer) || body.currentOdometer < 0)
  ) {
    return NextResponse.json({ error: "currentOdometer doit être un entier positif ou nul." }, { status: 400 });
  }
  if (
    body.currentFuelLevel !== undefined &&
    (!Number.isInteger(body.currentFuelLevel) || body.currentFuelLevel < 0 || body.currentFuelLevel > 100)
  ) {
    return NextResponse.json(
      { error: "currentFuelLevel doit être un entier entre 0 et 100." },
      { status: 400 }
    );
  }

  // Sprint 19 (DOMAINRULES.md section 37) : dates optionnelles des alertes proactives.
  const parsedDates: Partial<Record<(typeof OPTIONAL_DATE_FIELDS)[number], Date>> = {};
  for (const field of OPTIONAL_DATE_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: `${field} doit être une date ISO valide.` }, { status: 400 });
    }
    parsedDates[field] = parsed;
  }

  if (!(await canAccessAgency(user, agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  try {
    const vehicle = await createVehicle({
      tenantId: user.tenantId,
      agencyId,
      name,
      licensePlate,
      make,
      model,
      year,
      category,
      pricePerDay,
      ww: body.ww,
      chassisNumber: body.chassisNumber,
      color: body.color,
      doors: body.doors,
      seats: body.seats,
      transmission: body.transmission,
      fuel: body.fuel,
      horsepower: body.horsepower,
      powerKW: body.powerKW,
      engineSize: body.engineSize,
      ac: body.ac,
      gps: body.gps,
      imageUrl: body.imageUrl,
      currentOdometer: body.currentOdometer,
      currentFuelLevel: body.currentFuelLevel,
      nextOilChangeKm: body.nextOilChangeKm,
      ...parsedDates,
    });
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "vehicle.created",
      resource: "Vehicle",
      resourceId: vehicle.id,
      metadata: { licensePlate: vehicle.licensePlate, agencyId: vehicle.agencyId },
    });
    return NextResponse.json({ vehicle }, { status: 201 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "Cette immatriculation est déjà utilisée pour ce tenant." },
        { status: 409 }
      );
    }

    console.error("Erreur lors de la création du véhicule :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
