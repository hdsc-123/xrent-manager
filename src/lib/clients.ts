import type { Client } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Client = locataire externe (voir prisma/schema.prisma), toujours scopé tenantId.
 * Périmètre volontairement minimal pour Sprint 5 (pas de page dashboard dédiée) :
 * juste ce qu'il faut pour sélectionner/créer un client depuis le formulaire de location.
 */
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
