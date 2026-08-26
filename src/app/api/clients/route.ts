import { NextResponse } from "next/server";
import type { IdType } from "@prisma/client";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import {
  getClients,
  createClient,
  getClientById,
  updateClient,
  findDuplicateClient,
  assertValidLicenseDates,
  InvalidLicenseDatesError,
} from "@/lib/clients";
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
  if (!(await can(user, "clients.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
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
  /** Sprint 30 (DOMAINRULES.md section 45) — jamais requise ici : un client de moins de 21 ans
   * ou sans date de naissance connue peut toujours être créé (CLAUDE.md section 2 point 7),
   * seule sa désignation comme conducteur d'un contrat est bloquée (src/lib/locations.ts). */
  birthDate?: string;
  notes?: string;
  /** Réutilise ce client existant au lieu d'en créer un nouveau (voir DuplicateCheck.tsx). */
  useExistingClientId?: string;
  /** Ignore un doublon détecté et force la création d'un nouveau client quand même. */
  forceCreate?: boolean;
}

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "clients.create"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  let body: CreateClientBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  // Trouvé en revue stricte (campagne QA 2026-08-26, partie 1) : une chaîne composée
  // uniquement d'espaces est truthy en JavaScript — sans ce contrôle individuel, un firstName
  // réel combiné à un lastName uniquement composé d'espaces (ou l'inverse) passait le contrôle
  // ci-dessous sur `name` (dérivé, non vide une fois l'espace superflu retiré par .trim()) tout
  // en persistant un `lastName` incohérent tel quel en base.
  if (body.firstName !== undefined && !body.firstName.trim()) {
    return NextResponse.json(
      { error: "firstName ne peut pas être vide ou composé uniquement d'espaces." },
      { status: 400 }
    );
  }
  if (body.lastName !== undefined && !body.lastName.trim()) {
    return NextResponse.json(
      { error: "lastName ne peut pas être vide ou composé uniquement d'espaces." },
      { status: 400 }
    );
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

  // Validation de format uniquement (date ISO parseable) — même principe que birthDate
  // ci-dessous. Sans ce contrôle, une valeur non parseable (ex. "not-a-date") produit un objet
  // Date invalide (NaN) : assertValidLicenseDates ne le détecte pas (une comparaison impliquant
  // NaN est toujours fausse, donc silencieusement acceptée) et l'écriture Prisma échoue plus
  // loin avec une erreur 500 non contrôlée (trouvé en revue, campagne QA 2026-08-26, partie 1).
  if (body.licenseIssueDate !== undefined) {
    const parsedLicenseIssueDate = new Date(body.licenseIssueDate);
    if (Number.isNaN(parsedLicenseIssueDate.getTime())) {
      return NextResponse.json({ error: "licenseIssueDate doit être une date ISO valide." }, { status: 400 });
    }
  }
  if (body.licenseExpiryDate !== undefined) {
    const parsedLicenseExpiryDate = new Date(body.licenseExpiryDate);
    if (Number.isNaN(parsedLicenseExpiryDate.getTime())) {
      return NextResponse.json({ error: "licenseExpiryDate doit être une date ISO valide." }, { status: 400 });
    }
  }

  try {
    assertValidLicenseDates(
      body.licenseIssueDate ? new Date(body.licenseIssueDate) : undefined,
      body.licenseExpiryDate ? new Date(body.licenseExpiryDate) : undefined
    );
  } catch (error) {
    if (error instanceof InvalidLicenseDatesError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  // Sprint 30 (DOMAINRULES.md section 45) : validation de format uniquement (date parseable,
  // pas future) — jamais un contrôle d'âge ici, birthDate reste optionnelle à ce niveau.
  if (body.birthDate !== undefined) {
    const parsedBirthDate = new Date(body.birthDate);
    if (Number.isNaN(parsedBirthDate.getTime())) {
      return NextResponse.json({ error: "birthDate doit être une date ISO valide." }, { status: 400 });
    }
    if (parsedBirthDate.getTime() > Date.now()) {
      return NextResponse.json({ error: "birthDate ne peut pas être une date future." }, { status: 400 });
    }
  }

  // Détection de doublons (DOMAINRULES.md section 9) : toujours exécutée (sauf choix déjà
  // fait via useExistingClientId) pour pouvoir tracer un forceCreate malgré un doublon
  // trouvé (note ajoutée au client créé, voir plus bas) ; ne bloque la création (409) que
  // si l'appelant n'a pas encore fait de choix explicite.
  const duplicate = body.useExistingClientId
    ? null
    : await findDuplicateClient(user.tenantId, {
        email: body.email,
        phone: body.phone,
        idNumber: body.idNumber,
        licenseNumber: body.licenseNumber,
        firstName: body.firstName,
        lastName: body.lastName,
      });

  if (duplicate && !body.forceCreate) {
    return NextResponse.json(
      { duplicate: { client: duplicate.client, matchType: duplicate.matchType, field: duplicate.field } },
      { status: 409 }
    );
  }

  if (body.useExistingClientId) {
    const existingClient = await getClientById(user.tenantId, body.useExistingClientId);
    if (!existingClient) {
      return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
    }

    // Mise à jour automatique (spec section 2) : complète le téléphone/email/permis si le
    // client existant ne les avait pas encore ou s'ils ont changé, sans écraser le reste.
    const updates: { phone?: string; email?: string; licenseNumber?: string } = {};
    if (body.phone && body.phone !== existingClient.phone) updates.phone = body.phone;
    if (body.email && body.email !== existingClient.email) updates.email = body.email;
    if (body.licenseNumber && body.licenseNumber !== existingClient.licenseNumber) {
      updates.licenseNumber = body.licenseNumber;
    }

    const client =
      Object.keys(updates).length > 0
        ? await updateClient(user.tenantId, existingClient.id, updates)
        : existingClient;

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "client.duplicate_reused",
      resource: "Client",
      resourceId: existingClient.id,
      metadata: { updates },
    });

    return NextResponse.json({ client });
  }

  const notes = duplicate
    ? [body.notes, `Créé malgré une correspondance possible avec ${duplicate.client.name}.`]
        .filter(Boolean)
        .join(" — ")
    : body.notes;

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
    birthDate: body.birthDate ? new Date(body.birthDate) : undefined,
    notes,
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
