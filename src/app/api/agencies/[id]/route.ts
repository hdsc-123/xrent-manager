import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAgencyById } from "@/lib/db";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { logAction } from "@/lib/audit";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_AUTHENTICATED_JSON_BODY_BYTES } from "@/lib/request-guards";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Correction QA 2026-09-01 (anomalie confirmée en Phase 4) : la contrainte FK violée en base
 * (P2003) peut provenir de n'importe quel modèle rattaché à une agence (voir prisma/schema.prisma
 * — Vehicle, Location, Invoice, DamageInvoice, Maintenance, VehicleTransfer, VehicleTrip, Alert,
 * CashEntry, Reservation, UserAgency), pas seulement des utilisateurs — le message générique
 * précédent ("utilisateurs rattachés") affichait donc systématiquement une cause incorrecte dès
 * qu'un véhicule, une location ou toute autre donnée bloquait la suppression. Le nom de la
 * contrainte Postgres générée par Prisma suit la convention `<Table>_<colonne>_fkey` : on en
 * extrait le nom de table pour donner un message fidèle à la cause réelle, sans changer la règle
 * de sécurité elle-même (la suppression reste refusée dans tous les cas).
 */
const AGENCY_FK_BLOCKER_LABELS: Record<string, string> = {
  UserAgency: "un ou plusieurs utilisateurs sont rattachés à cette agence",
  Vehicle: "un ou plusieurs véhicules sont rattachés à cette agence",
  Location: "des contrats de location existent pour cette agence",
  Invoice: "des factures existent pour cette agence",
  DamageInvoice: "des factures de dégâts existent pour cette agence",
  Maintenance: "des maintenances existent pour cette agence",
  VehicleTransfer: "des transferts de véhicule existent pour cette agence",
  VehicleTrip: "des bons de déplacement existent pour cette agence",
  Alert: "des alertes existent pour cette agence",
  CashEntry: "des écritures de caisse existent pour cette agence",
  Reservation: "des réservations existent pour cette agence",
};

function describeAgencyDeletionBlocker(error: unknown): string {
  // Vérifié empiriquement (2026-09-01) contre le driver Postgres de Prisma : le nom de
  // constraint se trouve dans `error.meta.constraint` (ex. "Vehicle_agencyId_fkey"), pas
  // `field_name` — corrigé après un premier essai qui retombait systématiquement sur le message
  // de repli générique ci-dessous.
  const constraintName =
    typeof error === "object" && error !== null && "meta" in error
      ? (error as { meta?: { constraint?: unknown } }).meta?.constraint
      : undefined;
  if (typeof constraintName === "string") {
    const tableName = constraintName.split("_")[0];
    const label = AGENCY_FK_BLOCKER_LABELS[tableName];
    if (label) {
      return `Impossible de supprimer cette agence : ${label}.`;
    }
  }
  return "Impossible de supprimer cette agence : des données y sont encore rattachées.";
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (!(await can(user, "agencies.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const agency = await getAgencyById(user.tenantId, id);

  if (!agency) {
    return NextResponse.json({ error: "Agence introuvable." }, { status: 404 });
  }

  if (!(await canAccessAgency(user, agency.id))) {
    return NextResponse.json({ error: "Agence introuvable." }, { status: 404 });
  }

  return NextResponse.json({ agency });
}

interface UpdateAgencyBody {
  name?: string;
  city?: string;
  address?: string;
  phone?: string;
  email?: string;
  managerName?: string;
  managerPhone?: string;
  contractNumberPrefix?: string;
  lastContractNumber?: number;
  /** Sprint 19 — solde de départ de caisse (centimes), purement informatif (voir
   * prisma/schema.prisma, Agency.cashStartingBalance et DOMAINRULES.md section 37). */
  cashStartingBalance?: number;
}

export async function PATCH(request: Request, { params }: RouteParams) {
  if (isRequestBodyTooLarge(request, MAX_AUTHENTICATED_JSON_BODY_BYTES)) {
    return requestBodyTooLargeResponse(MAX_AUTHENTICATED_JSON_BODY_BYTES);
  }

  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (!(await can(user, "agencies.edit"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const agency = await getAgencyById(user.tenantId, id);

  if (!agency) {
    return NextResponse.json({ error: "Agence introuvable." }, { status: 404 });
  }

  if (!(await canAccessAgency(user, agency.id))) {
    return NextResponse.json({ error: "Agence introuvable." }, { status: 404 });
  }

  let body: UpdateAgencyBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.name !== undefined && !body.name) {
    return NextResponse.json({ error: "name ne peut pas être vide." }, { status: 400 });
  }

  if (
    body.lastContractNumber !== undefined &&
    (!Number.isInteger(body.lastContractNumber) || body.lastContractNumber < 0)
  ) {
    return NextResponse.json(
      { error: "lastContractNumber doit être un entier positif ou nul." },
      { status: 400 }
    );
  }

  if (
    body.cashStartingBalance !== undefined &&
    (!Number.isInteger(body.cashStartingBalance) || body.cashStartingBalance < 0)
  ) {
    return NextResponse.json(
      { error: "cashStartingBalance doit être un entier positif ou nul (centimes)." },
      { status: 400 }
    );
  }

  const numberingChanged = body.contractNumberPrefix !== undefined || body.lastContractNumber !== undefined;

  const updated = await prisma.agency.update({
    where: { id: agency.id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.city !== undefined ? { city: body.city } : {}),
      ...(body.address !== undefined ? { address: body.address } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.managerName !== undefined ? { managerName: body.managerName } : {}),
      ...(body.managerPhone !== undefined ? { managerPhone: body.managerPhone } : {}),
      ...(body.contractNumberPrefix !== undefined
        ? { contractNumberPrefix: body.contractNumberPrefix.trim() }
        : {}),
      ...(body.lastContractNumber !== undefined ? { lastContractNumber: body.lastContractNumber } : {}),
      ...(body.cashStartingBalance !== undefined ? { cashStartingBalance: body.cashStartingBalance } : {}),
    },
  });

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "agency.updated",
    resource: "Agency",
    resourceId: agency.id,
    metadata: {
      changes: body,
      ...(numberingChanged
        ? {
            previousNumbering: {
              contractNumberPrefix: agency.contractNumberPrefix,
              lastContractNumber: agency.lastContractNumber,
            },
          }
        : {}),
    } as unknown as Prisma.InputJsonValue,
  });

  return NextResponse.json({ agency: updated });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  if (!(await can(user, "agencies.delete"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const agency = await getAgencyById(user.tenantId, id);

  if (!agency) {
    return NextResponse.json({ error: "Agence introuvable." }, { status: 404 });
  }

  if (!(await canAccessAgency(user, agency.id))) {
    return NextResponse.json({ error: "Agence introuvable." }, { status: 404 });
  }

  try {
    await prisma.agency.delete({ where: { id: agency.id } });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2003"
    ) {
      return NextResponse.json({ error: describeAgencyDeletionBlocker(error) }, { status: 409 });
    }
    throw error;
  }

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "agency.deleted",
    resource: "Agency",
    resourceId: agency.id,
    metadata: { name: agency.name },
  });

  return NextResponse.json({ success: true });
}
