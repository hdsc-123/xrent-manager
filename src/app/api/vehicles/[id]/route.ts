import { NextResponse } from "next/server";
import type { VehicleStatus, TransmissionType, FuelType, Prisma } from "@prisma/client";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import {
  getVehicleById,
  updateVehicle,
  deleteVehicle,
  VehicleHasLocationsError,
  type UpdateVehicleInput,
} from "@/lib/vehicles";
import { logAction } from "@/lib/audit";

const VEHICLE_STATUSES: VehicleStatus[] = [
  "AVAILABLE",
  "RENTED",
  "MAINTENANCE",
  "INACTIVE",
  "TRANSFERRING",
  "ON_TRIP",
];
// TRANSFERRING/ON_TRIP sont gérés automatiquement par les modules Transfert/Bon de déplacement
// (src/lib/vehicle-transfers.ts, src/lib/vehicle-trips.ts, Sprint 14C) — jamais assignables
// manuellement via PATCH, pour ne jamais désynchroniser Vehicle.status d'un transfert/
// déplacement réellement en cours.
const MANUALLY_ASSIGNABLE_STATUSES: VehicleStatus[] = ["AVAILABLE", "RENTED", "MAINTENANCE", "INACTIVE"];
const TRANSMISSION_TYPES: TransmissionType[] = ["MANUELLE", "AUTOMATIQUE"];
const FUEL_TYPES: FuelType[] = ["ESSENCE", "DIESEL", "HYBRIDE", "ELECTRIQUE"];

interface RouteParams {
  params: Promise<{ id: string }>;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "vehicles.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const vehicle = await getVehicleById(user.tenantId, id);

  if (!vehicle || !(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }

  return NextResponse.json({ vehicle });
}

interface UpdateVehicleBody {
  agencyId?: string;
  name?: string;
  licensePlate?: string;
  make?: string;
  model?: string;
  year?: number;
  category?: string;
  status?: VehicleStatus;
  pricePerDay?: number | null;
  // Sprint technique 5 : `currency` retiré de ce type — jamais exposé par le formulaire
  // dashboard, jamais validé côté serveur ; un client ne doit plus pouvoir le modifier via
  // cette route (voir le commentaire sur `updateData` plus bas).
  ww?: string | null;
  chassisNumber?: string | null;
  color?: string | null;
  doors?: number | null;
  seats?: number | null;
  transmission?: TransmissionType;
  fuel?: FuelType;
  horsepower?: number | null;
  powerKW?: number | null;
  engineSize?: number | null;
  ac?: boolean;
  gps?: boolean;
  imageUrl?: string | null;
  /** Sprint 24-1 — kilométrage/carburant actuels, désormais modifiables après création (jusqu'ici
   * uniquement capturables à la création du véhicule, voir CreateVehicleInput). */
  currentOdometer?: number | null;
  currentFuelLevel?: number | null;
  /** Sprint 19 (DOMAINRULES.md section 37) — alertes proactives, dates ISO (voir parseOptionalDate ci-dessous). */
  insuranceExpiryDate?: string | null;
  vignetteExpiryDate?: string | null;
  technicalInspectionExpiryDate?: string | null;
  nextOilChangeDate?: string | null;
  nextOilChangeKm?: number | null;
}

const OPTIONAL_DATE_FIELDS = [
  "insuranceExpiryDate",
  "vignetteExpiryDate",
  "technicalInspectionExpiryDate",
  "nextOilChangeDate",
] as const;

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "vehicles.edit"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const vehicle = await getVehicleById(user.tenantId, id);

  if (!vehicle || !(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }

  let body: UpdateVehicleBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (
    body.pricePerDay !== undefined &&
    body.pricePerDay !== null &&
    (!Number.isInteger(body.pricePerDay) || body.pricePerDay <= 0)
  ) {
    return NextResponse.json(
      { error: "pricePerDay doit être un entier positif (centimes)." },
      { status: 400 }
    );
  }

  // Sprint 18 : même plafond haut qu'à la création (POST /api/vehicles).
  if (
    body.year !== undefined &&
    (!Number.isInteger(body.year) || body.year < 1900 || body.year > new Date().getFullYear() + 1)
  ) {
    return NextResponse.json({ error: "year invalide." }, { status: 400 });
  }

  if (body.status && !VEHICLE_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }
  if (body.status && !MANUALLY_ASSIGNABLE_STATUSES.includes(body.status)) {
    return NextResponse.json(
      { error: "TRANSFERRING/ON_TRIP sont gérés automatiquement par un transfert/bon de déplacement en cours, non assignables manuellement." },
      { status: 400 }
    );
  }

  if (body.transmission && !TRANSMISSION_TYPES.includes(body.transmission)) {
    return NextResponse.json({ error: "transmission invalide." }, { status: 400 });
  }

  if (body.fuel && !FUEL_TYPES.includes(body.fuel)) {
    return NextResponse.json({ error: "fuel invalide." }, { status: 400 });
  }

  // Sprint 24-2 (brief explicite du propriétaire du projet, revient sur la décision Sprint 24-1
  // ci-dessus, qui avait délibérément écarté un rejet serveur strict sur un effacement explicite) :
  // ces 7 champs de fiche technique sont désormais obligatoires côté API — un champ **fourni**
  // (clé présente dans le corps de la requête) doit être valide et non vide/nul ; un champ **omis**
  // (absent du corps) laisse la valeur existante inchangée, sémantique PATCH standard déjà en
  // vigueur pour tous les autres champs de cette route. Voir DOMAINRULES.md section 42.
  if (
    body.chassisNumber !== undefined &&
    (typeof body.chassisNumber !== "string" || body.chassisNumber.trim() === "")
  ) {
    return NextResponse.json(
      { error: "chassisNumber est obligatoire et ne peut pas être vide ou effacé." },
      { status: 400 }
    );
  }
  if (body.color !== undefined && (typeof body.color !== "string" || body.color.trim() === "")) {
    return NextResponse.json(
      { error: "color est obligatoire et ne peut pas être vide ou effacé." },
      { status: 400 }
    );
  }
  for (const field of ["doors", "seats", "horsepower", "powerKW"] as const) {
    const fieldValue = body[field];
    if (fieldValue !== undefined && (fieldValue === null || !Number.isInteger(fieldValue) || fieldValue <= 0)) {
      return NextResponse.json(
        { error: `${field} est obligatoire et doit être un entier positif (ne peut pas être effacé).` },
        { status: 400 }
      );
    }
  }

  if (
    body.engineSize !== undefined &&
    (body.engineSize === null || !Number.isFinite(body.engineSize) || body.engineSize <= 0)
  ) {
    return NextResponse.json(
      { error: "engineSize est obligatoire et doit être un nombre positif (ne peut pas être effacé)." },
      { status: 400 }
    );
  }

  if (
    body.nextOilChangeKm !== undefined &&
    body.nextOilChangeKm !== null &&
    (!Number.isInteger(body.nextOilChangeKm) || body.nextOilChangeKm < 0)
  ) {
    return NextResponse.json({ error: "nextOilChangeKm doit être un entier positif ou nul." }, { status: 400 });
  }

  // Sprint 24-1 : mêmes bornes que POST /api/vehicles (création).
  if (
    body.currentOdometer !== undefined &&
    body.currentOdometer !== null &&
    (!Number.isInteger(body.currentOdometer) || body.currentOdometer < 0)
  ) {
    return NextResponse.json({ error: "currentOdometer doit être un entier positif ou nul." }, { status: 400 });
  }
  if (
    body.currentFuelLevel !== undefined &&
    body.currentFuelLevel !== null &&
    (!Number.isInteger(body.currentFuelLevel) || body.currentFuelLevel < 0 || body.currentFuelLevel > 100)
  ) {
    return NextResponse.json(
      { error: "currentFuelLevel doit être un entier entre 0 et 100." },
      { status: 400 }
    );
  }

  // Sprint 19 (DOMAINRULES.md section 37) : dates optionnelles/nullables des alertes proactives —
  // même convention que receivedAt (POST /api/reservations) : chaîne ISO parsée, `null` explicite
  // efface le champ, absence de clé le laisse inchangé.
  const parsedDates: Partial<Record<(typeof OPTIONAL_DATE_FIELDS)[number], Date | null>> = {};
  for (const field of OPTIONAL_DATE_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (value === null) {
      parsedDates[field] = null;
      continue;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: `${field} doit être une date ISO valide.` }, { status: 400 });
    }
    parsedDates[field] = parsed;
  }

  if (body.agencyId && !(await canAccessAgency(user, body.agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  // Sprint technique 5 (audit de sécurité) : construction explicite champ par champ, jamais un
  // spread du corps brut de la requête — `bodyWithoutDates` (retiré) transmettait tel quel tout
  // champ réellement présent dans le JSON reçu, y compris des colonnes jamais destinées à être
  // modifiables par le client (`tenantId`, `id`, `createdAt`, `updatedAt`), toutes acceptées sans
  // filtrage par `Prisma.VehicleUncheckedUpdateInput` côté moteur Prisma — un appelant disposant
  // seulement de `vehicles.edit` pouvait ainsi rattacher silencieusement un véhicule à un tenant
  // arbitraire en ajoutant `tenantId` au corps de la requête, en dehors de toute interface,
  // cassant l'isolation tenant (SECURITY.md section 1). `currency` est volontairement exclu de la
  // liste ci-dessous (jamais exposé par le formulaire dashboard, jamais validé jusqu'ici) : reste
  // à sa valeur existante, même principe que les champs dérivés côté serveur ailleurs dans le
  // projet (agencyId de Location, currency d'Invoice/Payment — jamais fournis par le client).
  const updateData: UpdateVehicleInput = {
    ...(body.agencyId !== undefined ? { agencyId: body.agencyId } : {}),
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.licensePlate !== undefined ? { licensePlate: body.licensePlate } : {}),
    ...(body.make !== undefined ? { make: body.make } : {}),
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.year !== undefined ? { year: body.year } : {}),
    ...(body.category !== undefined ? { category: body.category } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.pricePerDay !== undefined ? { pricePerDay: body.pricePerDay } : {}),
    ...(body.ww !== undefined ? { ww: body.ww } : {}),
    ...(body.chassisNumber !== undefined ? { chassisNumber: body.chassisNumber } : {}),
    ...(body.color !== undefined ? { color: body.color } : {}),
    ...(body.doors !== undefined ? { doors: body.doors } : {}),
    ...(body.seats !== undefined ? { seats: body.seats } : {}),
    ...(body.transmission !== undefined ? { transmission: body.transmission } : {}),
    ...(body.fuel !== undefined ? { fuel: body.fuel } : {}),
    ...(body.horsepower !== undefined ? { horsepower: body.horsepower } : {}),
    ...(body.powerKW !== undefined ? { powerKW: body.powerKW } : {}),
    ...(body.engineSize !== undefined ? { engineSize: body.engineSize } : {}),
    ...(body.ac !== undefined ? { ac: body.ac } : {}),
    ...(body.gps !== undefined ? { gps: body.gps } : {}),
    ...(body.imageUrl !== undefined ? { imageUrl: body.imageUrl } : {}),
    ...(body.currentOdometer !== undefined ? { currentOdometer: body.currentOdometer } : {}),
    ...(body.currentFuelLevel !== undefined ? { currentFuelLevel: body.currentFuelLevel } : {}),
    ...(body.nextOilChangeKm !== undefined ? { nextOilChangeKm: body.nextOilChangeKm } : {}),
    ...parsedDates,
  };

  try {
    const updated = await updateVehicle(user.tenantId, vehicle.id, updateData);
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "vehicle.updated",
      resource: "Vehicle",
      resourceId: vehicle.id,
      metadata: { changes: body } as unknown as Prisma.InputJsonValue,
    });
    return NextResponse.json({ vehicle: updated });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "Cette immatriculation est déjà utilisée pour ce tenant." },
        { status: 409 }
      );
    }

    console.error("Erreur lors de la modification du véhicule :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "vehicles.delete"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const vehicle = await getVehicleById(user.tenantId, id);

  if (!vehicle || !(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }

  try {
    await deleteVehicle(user.tenantId, vehicle.id);
  } catch (error) {
    if (error instanceof VehicleHasLocationsError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "vehicle.deleted",
    resource: "Vehicle",
    resourceId: vehicle.id,
    metadata: { licensePlate: vehicle.licensePlate },
  });

  return NextResponse.json({ success: true });
}
