import { NextResponse } from "next/server";
import type { VehicleStatus, TransmissionType, FuelType } from "@prisma/client";
import { getSessionUser, canAccessAgency, getAccessibleAgencyIds } from "@/lib/authz";
import { getVehicles, createVehicle, type VehicleFilters } from "@/lib/vehicles";
import { logAction } from "@/lib/audit";

const VEHICLE_STATUSES: VehicleStatus[] = ["AVAILABLE", "RENTED", "MAINTENANCE", "INACTIVE"];
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

  const { searchParams } = new URL(request.url);
  const agencyIdParam = searchParams.get("agencyId") ?? undefined;
  const statusParam = searchParams.get("status") ?? undefined;
  const categoryParam = searchParams.get("category") ?? undefined;
  const searchParam = searchParams.get("search") ?? undefined;

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
  status?: VehicleStatus;
  pricePerDay?: number;
  currency?: string;
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
}

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
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

  // pricePerDay est optionnel depuis le Sprint 14A (purement informatif, voir
  // DOMAINRULES.md section 5/7) — validé uniquement s'il est fourni.
  if (pricePerDay !== undefined && (!Number.isInteger(pricePerDay) || pricePerDay <= 0)) {
    return NextResponse.json(
      { error: "pricePerDay doit être un entier positif (centimes)." },
      { status: 400 }
    );
  }

  if (!Number.isInteger(year) || year < 1900) {
    return NextResponse.json({ error: "year invalide." }, { status: 400 });
  }

  if (body.status && !VEHICLE_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }

  if (body.transmission && !TRANSMISSION_TYPES.includes(body.transmission)) {
    return NextResponse.json({ error: "transmission invalide." }, { status: 400 });
  }

  if (body.fuel && !FUEL_TYPES.includes(body.fuel)) {
    return NextResponse.json({ error: "fuel invalide." }, { status: 400 });
  }

  for (const field of ["doors", "seats", "horsepower", "powerKW"] as const) {
    const fieldValue = body[field];
    if (fieldValue !== undefined && (!Number.isInteger(fieldValue) || fieldValue <= 0)) {
      return NextResponse.json({ error: `${field} doit être un entier positif.` }, { status: 400 });
    }
  }

  if (body.engineSize !== undefined && (!Number.isFinite(body.engineSize) || body.engineSize <= 0)) {
    return NextResponse.json({ error: "engineSize doit être un nombre positif." }, { status: 400 });
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
      status: body.status,
      pricePerDay,
      currency: body.currency,
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
