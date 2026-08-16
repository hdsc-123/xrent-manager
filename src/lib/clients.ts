import type { Client, IdType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Client = locataire externe (voir prisma/schema.prisma), toujours scopé tenantId,
 * sans notion d'agence (DOMAINRULES.md section 9). Module dédié depuis Sprint 8
 * (page dashboard + CRUD complet), en plus de la sélection/création inline déjà
 * utilisée par le formulaire de location depuis Sprint 5.
 */

export class ClientHasLocationsError extends Error {
  constructor() {
    super("Impossible de supprimer un client ayant des locations.");
    this.name = "ClientHasLocationsError";
  }
}

export async function getClients(tenantId: string, search?: string): Promise<Client[]> {
  return prisma.client.findMany({
    where: {
      tenantId,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { name: "asc" },
  });
}

/** `tx` optionnel (Sprint 26A, Finding A) — voir le commentaire équivalent sur
 * `getReservationById`, src/lib/reservations.ts. */
export async function getClientById(
  tenantId: string,
  clientId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<Client | null> {
  return tx.client.findFirst({ where: { id: clientId, tenantId } });
}

export interface CreateClientInput {
  tenantId: string;
  name: string;
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
  licenseIssueDate?: Date;
  licenseExpiryDate?: Date;
  /** Sprint 30 (DOMAINRULES.md section 45) — âge réel, distinct de licenseExpiryDate ci-dessus.
   * Optionnelle ici : un client de moins de 21 ans (ou sans date de naissance connue) peut
   * toujours être enregistré, seule sa désignation comme conducteur d'un contrat est bloquée
   * (voir assertClientMeetsMinimumAge, src/lib/locations.ts). */
  birthDate?: Date;
  notes?: string;
}

export async function createClient(
  data: CreateClientInput,
  tx: Prisma.TransactionClient = prisma
): Promise<Client> {
  return tx.client.create({ data });
}

export interface UpdateClientInput {
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
  licenseIssueDate?: Date | null;
  licenseExpiryDate?: Date | null;
  birthDate?: Date | null;
  notes?: string | null;
}

export async function updateClient(
  tenantId: string,
  clientId: string,
  data: UpdateClientInput,
  tx: Prisma.TransactionClient = prisma
): Promise<Client | null> {
  const existing = await getClientById(tenantId, clientId, tx);
  if (!existing) {
    return null;
  }

  return tx.client.update({ where: { id: clientId }, data });
}

/** Même principe que deleteVehicle (src/lib/vehicles.ts) : historique de location jamais perdu par une suppression de client. */
export async function deleteClient(tenantId: string, clientId: string): Promise<boolean> {
  const existing = await getClientById(tenantId, clientId);
  if (!existing) {
    return false;
  }

  const locationCount = await prisma.location.count({ where: { clientId } });
  if (locationCount > 0) {
    throw new ClientHasLocationsError();
  }

  await prisma.client.delete({ where: { id: clientId } });
  return true;
}

/**
 * Détection de doublons (Sprint 12C, DOMAINRULES.md section 9). Contrôles exacts d'abord
 * (email/téléphone normalisé/CIN-passeport/permis — "doublon certain"), puis, à défaut,
 * une passe floue sur le nom complet par distance de Levenshtein < 3 ("doublon probable").
 * Utilisée par POST /api/clients et par la conversion réservation → contrat
 * (POST /api/reservations/[id]/convert). Scanne tous les clients du tenant pour la passe
 * floue (pas d'index applicable à une distance d'édition) — acceptable à l'échelle d'un
 * tenant PME, à revoir si le volume de clients par tenant devient significatif.
 */
export type ClientDuplicateMatchType = "exact" | "fuzzy";
export type ClientDuplicateMatchField = "email" | "phone" | "idNumber" | "licenseNumber" | "name";

export interface ClientDuplicateMatch {
  client: Client;
  matchType: ClientDuplicateMatchType;
  field: ClientDuplicateMatchField;
}

export interface FindDuplicateClientInput {
  email?: string;
  phone?: string;
  idNumber?: string;
  licenseNumber?: string;
  firstName?: string;
  lastName?: string;
}

function normalizePhone(phone: string): string {
  return phone.replace(/[\s.\-()]/g, "");
}

/** Distance de Levenshtein (programmation dynamique classique). */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

export async function findDuplicateClient(
  tenantId: string,
  input: FindDuplicateClientInput,
  tx: Prisma.TransactionClient = prisma
): Promise<ClientDuplicateMatch | null> {
  if (input.email) {
    const match = await tx.client.findFirst({
      where: { tenantId, email: { equals: input.email, mode: "insensitive" } },
    });
    if (match) {
      return { client: match, matchType: "exact", field: "email" };
    }
  }

  if (input.phone) {
    const normalized = normalizePhone(input.phone);
    const candidates = await tx.client.findMany({
      where: { tenantId, OR: [{ phone: { not: null } }, { altPhone: { not: null } }] },
    });
    const match = candidates.find(
      (candidate) =>
        (candidate.phone && normalizePhone(candidate.phone) === normalized) ||
        (candidate.altPhone && normalizePhone(candidate.altPhone) === normalized)
    );
    if (match) {
      return { client: match, matchType: "exact", field: "phone" };
    }
  }

  if (input.idNumber) {
    const match = await tx.client.findFirst({ where: { tenantId, idNumber: input.idNumber } });
    if (match) {
      return { client: match, matchType: "exact", field: "idNumber" };
    }
  }

  if (input.licenseNumber) {
    const match = await tx.client.findFirst({ where: { tenantId, licenseNumber: input.licenseNumber } });
    if (match) {
      return { client: match, matchType: "exact", field: "licenseNumber" };
    }
  }

  if (input.firstName && input.lastName) {
    const fullName = `${input.firstName} ${input.lastName}`.trim().toLowerCase();
    const candidates = await tx.client.findMany({ where: { tenantId } });
    for (const candidate of candidates) {
      const candidateName = (
        candidate.firstName && candidate.lastName
          ? `${candidate.firstName} ${candidate.lastName}`
          : candidate.name
      )
        .trim()
        .toLowerCase();
      if (candidateName && levenshteinDistance(fullName, candidateName) < 3) {
        return { client: candidate, matchType: "fuzzy", field: "name" };
      }
    }
  }

  return null;
}
