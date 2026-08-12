import { NextResponse } from "next/server";
import type { MaintenanceStatus, Prisma } from "@prisma/client";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import {
  getMaintenanceById,
  updateMaintenance,
  deleteMaintenance,
  InvalidMaintenanceCostError,
  InvalidMaintenanceStatusTransitionError,
  MaintenanceNotEditableError,
  MaintenanceNotDeletableError,
} from "@/lib/maintenances";
import { logAction } from "@/lib/audit";

const MAINTENANCE_STATUSES: MaintenanceStatus[] = ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const maintenance = await getMaintenanceById(user.tenantId, id);

  if (!maintenance || !(await canAccessAgency(user, maintenance.agencyId))) {
    return NextResponse.json({ error: "Maintenance introuvable." }, { status: 404 });
  }

  return NextResponse.json({ maintenance });
}

interface UpdateMaintenanceBody {
  status?: MaintenanceStatus;
  scheduledDate?: string;
  completedDate?: string;
  cost?: number;
  notes?: string;
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const maintenance = await getMaintenanceById(user.tenantId, id);

  if (!maintenance || !(await canAccessAgency(user, maintenance.agencyId))) {
    return NextResponse.json({ error: "Maintenance introuvable." }, { status: 404 });
  }

  let body: UpdateMaintenanceBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.status && !MAINTENANCE_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400 });
  }

  const scheduledDate = body.scheduledDate ? new Date(body.scheduledDate) : undefined;
  const completedDate = body.completedDate ? new Date(body.completedDate) : undefined;
  if (
    (scheduledDate && Number.isNaN(scheduledDate.getTime())) ||
    (completedDate && Number.isNaN(completedDate.getTime()))
  ) {
    return NextResponse.json(
      { error: "scheduledDate/completedDate doivent être des dates ISO valides." },
      { status: 400 }
    );
  }

  try {
    const updated = await updateMaintenance(user.tenantId, maintenance.id, {
      status: body.status,
      scheduledDate,
      completedDate,
      cost: body.cost,
      notes: body.notes,
    });
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: body.status && body.status !== maintenance.status ? "maintenance.status_changed" : "maintenance.updated",
      resource: "Maintenance",
      resourceId: maintenance.id,
      metadata: { from: maintenance.status, changes: body } as unknown as Prisma.InputJsonValue,
    });
    return NextResponse.json({ maintenance: updated });
  } catch (error) {
    if (error instanceof InvalidMaintenanceCostError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidMaintenanceStatusTransitionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof MaintenanceNotEditableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    console.error("Erreur lors de la modification de la maintenance :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const maintenance = await getMaintenanceById(user.tenantId, id);

  if (!maintenance || !(await canAccessAgency(user, maintenance.agencyId))) {
    return NextResponse.json({ error: "Maintenance introuvable." }, { status: 404 });
  }

  try {
    await deleteMaintenance(user.tenantId, maintenance.id);
  } catch (error) {
    if (error instanceof MaintenanceNotDeletableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "maintenance.deleted",
    resource: "Maintenance",
    resourceId: maintenance.id,
    metadata: { vehicleId: maintenance.vehicleId, type: maintenance.type },
  });

  return NextResponse.json({ success: true });
}
