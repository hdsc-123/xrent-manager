import { NextResponse } from "next/server";
import type { Prisma, IdType } from "@prisma/client";
import { getSessionUser } from "@/lib/authz";
import { getClientById, updateClient, deleteClient, ClientHasLocationsError } from "@/lib/clients";
import { logAction } from "@/lib/audit";

const ID_TYPES: IdType[] = ["CIN", "PASSEPORT", "CARTE_SEJOUR"];

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const client = await getClientById(user.tenantId, id);

  if (!client) {
    return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
  }

  return NextResponse.json({ client });
}

interface UpdateClientBody {
  name?: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  altPhone?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  idNumber?: string | null;
  idType?: IdType | null;
  licenseNumber?: string | null;
  licenseIssueDate?: string | null;
  licenseExpiryDate?: string | null;
  notes?: string | null;
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const client = await getClientById(user.tenantId, id);

  if (!client) {
    return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
  }

  let body: UpdateClientBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.name !== undefined && !body.name) {
    return NextResponse.json({ error: "name ne peut pas être vide." }, { status: 400 });
  }

  if (body.idType && !ID_TYPES.includes(body.idType)) {
    return NextResponse.json({ error: "idType invalide." }, { status: 400 });
  }

  // Si firstName/lastName changent sans name explicite, on garde name synchronisé
  // (même dérivation qu'à la création, voir POST /api/clients).
  const derivedName =
    body.name === undefined && (body.firstName !== undefined || body.lastName !== undefined)
      ? [body.firstName ?? client.firstName, body.lastName ?? client.lastName]
          .filter(Boolean)
          .join(" ")
          .trim() || undefined
      : undefined;

  const updated = await updateClient(user.tenantId, client.id, {
    ...body,
    ...(derivedName ? { name: derivedName } : {}),
    licenseIssueDate:
      body.licenseIssueDate !== undefined
        ? body.licenseIssueDate === null
          ? null
          : new Date(body.licenseIssueDate)
        : undefined,
    licenseExpiryDate:
      body.licenseExpiryDate !== undefined
        ? body.licenseExpiryDate === null
          ? null
          : new Date(body.licenseExpiryDate)
        : undefined,
  });
  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "client.updated",
    resource: "Client",
    resourceId: client.id,
    metadata: { changes: body } as unknown as Prisma.InputJsonValue,
  });
  return NextResponse.json({ client: updated });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { id } = await params;
  const client = await getClientById(user.tenantId, id);

  if (!client) {
    return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
  }

  try {
    await deleteClient(user.tenantId, client.id);
  } catch (error) {
    if (error instanceof ClientHasLocationsError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "client.deleted",
    resource: "Client",
    resourceId: client.id,
    metadata: { name: client.name },
  });

  return NextResponse.json({ success: true });
}
