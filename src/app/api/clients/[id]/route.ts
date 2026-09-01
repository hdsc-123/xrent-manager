import { NextResponse } from "next/server";
import type { Prisma, IdType } from "@prisma/client";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_AUTHENTICATED_JSON_BODY_BYTES } from "@/lib/request-guards";
import {
  getClientById,
  updateClient,
  deleteClient,
  ClientHasLocationsError,
  assertValidLicenseDates,
  InvalidLicenseDatesError,
} from "@/lib/clients";
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
  if (!(await can(user, "clients.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
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
  /** Sprint 30 (DOMAINRULES.md section 45) — jamais requise ici, voir POST /api/clients. */
  birthDate?: string | null;
  notes?: string | null;
}

export async function PATCH(request: Request, { params }: RouteParams) {
  if (isRequestBodyTooLarge(request, MAX_AUTHENTICATED_JSON_BODY_BYTES)) {
    return requestBodyTooLargeResponse(MAX_AUTHENTICATED_JSON_BODY_BYTES);
  }

  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "clients.edit"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
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

  // Trouvé en revue stricte (campagne QA 2026-08-26, partie 1) — voir POST /api/clients pour la
  // justification complète. `null` reste accepté (efface le champ), seule une chaîne non-null
  // composée uniquement d'espaces est refusée.
  if (body.firstName !== undefined && body.firstName !== null && !body.firstName.trim()) {
    return NextResponse.json(
      { error: "firstName ne peut pas être vide ou composé uniquement d'espaces." },
      { status: 400 }
    );
  }
  if (body.lastName !== undefined && body.lastName !== null && !body.lastName.trim()) {
    return NextResponse.json(
      { error: "lastName ne peut pas être vide ou composé uniquement d'espaces." },
      { status: 400 }
    );
  }

  if (body.idType && !ID_TYPES.includes(body.idType)) {
    return NextResponse.json({ error: "idType invalide." }, { status: 400 });
  }

  // Validation de format uniquement (date ISO parseable) — même principe que birthDate
  // ci-dessous ; voir POST /api/clients pour la justification complète (trouvé en revue,
  // campagne QA 2026-08-26, partie 1).
  if (body.licenseIssueDate !== undefined && body.licenseIssueDate !== null) {
    const parsedLicenseIssueDate = new Date(body.licenseIssueDate);
    if (Number.isNaN(parsedLicenseIssueDate.getTime())) {
      return NextResponse.json({ error: "licenseIssueDate doit être une date ISO valide." }, { status: 400 });
    }
  }
  if (body.licenseExpiryDate !== undefined && body.licenseExpiryDate !== null) {
    const parsedLicenseExpiryDate = new Date(body.licenseExpiryDate);
    if (Number.isNaN(parsedLicenseExpiryDate.getTime())) {
      return NextResponse.json({ error: "licenseExpiryDate doit être une date ISO valide." }, { status: 400 });
    }
  }

  // Résout contre la valeur déjà en base quand un seul des deux champs change (édition
  // partielle) — jamais valider uniquement les champs présents dans le corps de la requête.
  const resolvedLicenseIssueDate =
    body.licenseIssueDate !== undefined
      ? body.licenseIssueDate === null
        ? null
        : new Date(body.licenseIssueDate)
      : client.licenseIssueDate;
  const resolvedLicenseExpiryDate =
    body.licenseExpiryDate !== undefined
      ? body.licenseExpiryDate === null
        ? null
        : new Date(body.licenseExpiryDate)
      : client.licenseExpiryDate;
  try {
    assertValidLicenseDates(resolvedLicenseIssueDate, resolvedLicenseExpiryDate);
  } catch (error) {
    if (error instanceof InvalidLicenseDatesError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  // Sprint 30 (DOMAINRULES.md section 45) : validation de format uniquement, jamais un contrôle
  // d'âge ici — voir POST /api/clients.
  if (body.birthDate !== undefined && body.birthDate !== null) {
    const parsedBirthDate = new Date(body.birthDate);
    if (Number.isNaN(parsedBirthDate.getTime())) {
      return NextResponse.json({ error: "birthDate doit être une date ISO valide." }, { status: 400 });
    }
    if (parsedBirthDate.getTime() > Date.now()) {
      return NextResponse.json({ error: "birthDate ne peut pas être une date future." }, { status: 400 });
    }
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

  // Sprint technique 5 (audit de sécurité) : construction explicite champ par champ, jamais un
  // spread du corps brut de la requête (`...body`, retiré) — celui-ci transmettait tel quel tout
  // champ réellement présent dans le JSON reçu, y compris des colonnes jamais destinées à être
  // modifiables par le client (`tenantId`, `id`, `createdAt`, `updatedAt`), toutes acceptées sans
  // filtrage par `Prisma.ClientUncheckedUpdateInput` côté moteur Prisma — un appelant disposant
  // seulement de `clients.edit` pouvait ainsi rattacher silencieusement un client à un tenant
  // arbitraire en ajoutant `tenantId` au corps de la requête, en dehors de toute interface,
  // cassant l'isolation tenant (SECURITY.md section 1).
  const updated = await updateClient(user.tenantId, client.id, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
    ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
    ...(body.email !== undefined ? { email: body.email } : {}),
    ...(body.phone !== undefined ? { phone: body.phone } : {}),
    ...(body.altPhone !== undefined ? { altPhone: body.altPhone } : {}),
    ...(body.address !== undefined ? { address: body.address } : {}),
    ...(body.city !== undefined ? { city: body.city } : {}),
    ...(body.country !== undefined ? { country: body.country } : {}),
    ...(body.idNumber !== undefined ? { idNumber: body.idNumber } : {}),
    ...(body.idType !== undefined ? { idType: body.idType } : {}),
    ...(body.licenseNumber !== undefined ? { licenseNumber: body.licenseNumber } : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
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
    birthDate:
      body.birthDate !== undefined ? (body.birthDate === null ? null : new Date(body.birthDate)) : undefined,
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
  if (!(await can(user, "clients.delete"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
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
