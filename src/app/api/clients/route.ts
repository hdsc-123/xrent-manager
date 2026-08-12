import { NextResponse } from "next/server";
import type { IdType } from "@prisma/client";
import { getSessionUser } from "@/lib/authz";
import { getClients, createClient } from "@/lib/clients";
import { logAction } from "@/lib/audit";

const ID_TYPES: IdType[] = ["CIN", "PASSEPORT", "CARTE_SEJOUR"];

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
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  altPhone?: string;
  address?: string;
  city?: string;
  country?: string;
  idNumber?: string;
  idType?: IdType;
  licenseNumber?: string;
  licenseIssueDate?: string;
  licenseExpiryDate?: string;
  notes?: string;
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

  // `name` reste le libellé d'affichage utilisé par tout le code/tests existants
  // (voir prisma/schema.prisma) ; dérivé de firstName/lastName si non fourni
  // explicitement, pour le nouveau formulaire dashboard (Sprint 12A).
  const name = body.name || [body.firstName, body.lastName].filter(Boolean).join(" ").trim();

  if (!name) {
    return NextResponse.json({ error: "name (ou firstName/lastName) est requis." }, { status: 400 });
  }

  if (body.idType && !ID_TYPES.includes(body.idType)) {
    return NextResponse.json({ error: "idType invalide." }, { status: 400 });
  }

  const client = await createClient({
    tenantId: user.tenantId,
    name,
    firstName: body.firstName,
    lastName: body.lastName,
    email: body.email,
    phone: body.phone,
    altPhone: body.altPhone,
    address: body.address,
    city: body.city,
    country: body.country,
    idNumber: body.idNumber,
    idType: body.idType,
    licenseNumber: body.licenseNumber,
    licenseIssueDate: body.licenseIssueDate ? new Date(body.licenseIssueDate) : undefined,
    licenseExpiryDate: body.licenseExpiryDate ? new Date(body.licenseExpiryDate) : undefined,
    notes: body.notes,
  });

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "client.created",
    resource: "Client",
    resourceId: client.id,
    metadata: { name: client.name },
  });

  return NextResponse.json({ client }, { status: 201 });
}
