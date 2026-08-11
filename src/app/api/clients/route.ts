import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { getClients, createClient } from "@/lib/clients";

/**
 * Client = locataire externe, tenant-scopé mais pas agence-scopé (hypothèse de travail
 * DOMAINRULES.md section 9 : un client est propre à un tenant, sans notion d'agence).
 * Pas de page /dashboard/clients dédiée pour Sprint 5 — seulement le nécessaire pour
 * sélectionner/créer un client depuis le formulaire de création de location.
 */
export async function GET(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search") ?? undefined;

  const clients = await getClients(user.tenantId, search);

  return NextResponse.json({ clients });
}

interface CreateClientBody {
  name?: string;
  email?: string;
  phone?: string;
}

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  let body: CreateClientBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (!body.name) {
    return NextResponse.json({ error: "name est requis." }, { status: 400 });
  }

  const client = await createClient({
    tenantId: user.tenantId,
    name: body.name,
    email: body.email,
    phone: body.phone,
  });

  return NextResponse.json({ client }, { status: 201 });
}
