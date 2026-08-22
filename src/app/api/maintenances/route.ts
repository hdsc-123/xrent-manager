import { NextResponse } from "next/server";
import type { MaintenanceStatus, MaintenanceType } from "@prisma/client";
import { getSessionUser, canAccessAgency, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import {
  getMaintenances,
  createMaintenance,
  type MaintenanceFilters,
  MaintenanceVehicleNotFoundError,
  InvalidMaintenanceCostError,
  InvalidMaintenancePeriodError,
  VehicleUnavailableForMaintenanceError,
} from "@/lib/maintenances";
import { getVehicleById } from "@/lib/vehicles";
import { logAction } from "@/lib/audit";

const MAINTENANCE_STATUSES: MaintenanceStatus[] = ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];
const MAINTENANCE_TYPES: MaintenanceType[] = ["OIL_CHANGE", "TIRE_CHANGE", "INSPECTION", "REPAIR", "OTHER"];

export async function GET(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "maintenances.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const agencyIdParam = searchParams.get("agencyId") ?? undefined;
  const vehicleIdParam = searchParams.get("vehicleId") ?? undefined;
  const statusParam = searchParams.get("status") ?? undefined;
  const typeParam = searchParams.get("type") ?? undefined;
  const fromParam = searchParams.get("from") ?? undefined;
  const toParam = searchParams.get("to") ?? undefined;

  if (statusParam && !MAINTENANCE_STATUSES.includes(statusParam as MaintenanceStatus)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }
  if (typeParam && !MAINTENANCE_TYPES.includes(typeParam as MaintenanceType)) {
    return NextResponse.json({ error: "type invalide." }, { status: 400 });
  }
  if (agencyIdParam && !(await canAccessAgency(user, agencyIdParam))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  const filters: MaintenanceFilters = {
    agencyId: agencyIdParam,
    vehicleId: vehicleIdParam,
    status: statusParam as MaintenanceStatus | undefined,
    type: typeParam as MaintenanceType | undefined,
    from: fromParam ? new Date(fromParam) : undefined,
    to: toParam ? new Date(toParam) : undefined,
  };

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const maintenances = await getMaintenances(user.tenantId, filters);

  const visibleMaintenances =
    accessibleAgencyIds === null || agencyIdParam
      ? maintenances
      : maintenances.filter((maintenance) => accessibleAgencyIds.includes(maintenance.agencyId));

  return NextResponse.json({ maintenances: visibleMaintenances });
}

interface CreateMaintenanceBody {
  vehicleId?: string;
  type?: MaintenanceType;
  scheduledDate?: string;
  /** Sprint 34 étape 3 — fin de la période bloquante (voir DOMAINRULES.md section 50). */
  scheduledEndDate?: string;
  cost?: number;
  notes?: string;
}

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "maintenances.create"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  let body: CreateMaintenanceBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { vehicleId, type, scheduledDate } = body;

  if (!vehicleId || !type || !scheduledDate) {
    return NextResponse.json(
      { error: "vehicleId, type et scheduledDate sont requis." },
      { status: 400 }
    );
  }

  if (!MAINTENANCE_TYPES.includes(type)) {
    return NextResponse.json({ error: "type invalide." }, { status: 400 });
  }

  const parsedDate = new Date(scheduledDate);
  if (Number.isNaN(parsedDate.getTime())) {
    return NextResponse.json({ error: "scheduledDate doit être une date ISO valide." }, { status: 400 });
  }

  let parsedEndDate: Date | undefined;
  if (body.scheduledEndDate !== undefined) {
    parsedEndDate = new Date(body.scheduledEndDate);
    if (Number.isNaN(parsedEndDate.getTime())) {
      return NextResponse.json({ error: "scheduledEndDate doit être une date ISO valide." }, { status: 400 });
    }
  }

  // L'agence de la maintenance est dérivée du véhicule côté serveur, jamais fournie par
  // le client (même principe que Location.agencyId, SECURITY.md section 4).
  const vehicle = await getVehicleById(user.tenantId, vehicleId);
  if (!vehicle) {
    return NextResponse.json({ error: "Véhicule introuvable." }, { status: 404 });
  }

  if (!(await canAccessAgency(user, vehicle.agencyId))) {
    return NextResponse.json({ error: "Accès refusé à cette agence." }, { status: 403 });
  }

  try {
    const maintenance = await createMaintenance({
      tenantId: user.tenantId,
      vehicleId,
      type,
      scheduledDate: parsedDate,
      scheduledEndDate: parsedEndDate,
      cost: body.cost,
      notes: body.notes,
    });
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "maintenance.created",
      resource: "Maintenance",
      resourceId: maintenance.id,
      metadata: { vehicleId: maintenance.vehicleId, type: maintenance.type },
    });
    return NextResponse.json({ maintenance }, { status: 201 });
  } catch (error) {
    if (error instanceof MaintenanceVehicleNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof InvalidMaintenanceCostError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidMaintenancePeriodError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Sprint 34 étape 3 (DOMAINRULES.md section 50, règle 1) : véhicule loué/réservé sur une
    // période chevauchant la maintenance demandée — blocage strict, sans exception ADMIN.
    if (error instanceof VehicleUnavailableForMaintenanceError) {
      return NextResponse.json(
        { error: error.message, conflictingLocations: error.conflictingLocations },
        { status: 409 }
      );
    }

    console.error("Erreur lors de la création de la maintenance :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
