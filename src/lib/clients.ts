import type { Client } from "@prisma/client";
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

export async function getClientById(tenantId: string, clientId: string): Promise<Client | null> {
  return prisma.client.findFirst({ where: { id: clientId, tenantId } });
}

export interface CreateClientInput {
  tenantId: string;
  name: string;
  email?: string;
  phone?: string;
}

export async function createClient(data: CreateClientInput): Promise<Client> {
  return prisma.client.create({ data });
}

export interface UpdateClientInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
}

export async function updateClient(
  tenantId: string,
  clientId: string,
  data: UpdateClientInput
): Promise<Client | null> {
  const existing = await getClientById(tenantId, clientId);
  if (!existing) {
    return null;
  }

  return prisma.client.update({ where: { id: clientId }, data });
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
