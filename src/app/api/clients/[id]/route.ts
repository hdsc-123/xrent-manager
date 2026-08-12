import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { getClientById, updateClient, deleteClient, ClientHasLocationsError } from "@/lib/clients";

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
  email?: string | null;
  phone?: string | null;
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

  const updated = await updateClient(user.tenantId, client.id, body);
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

  return NextResponse.json({ success: true });
}
