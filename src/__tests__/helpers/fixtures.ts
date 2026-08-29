import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { BCRYPT_COST } from "@/lib/bcrypt-cost";
import { ensureDefaultGroups } from "@/lib/permissions";
import { apiFetch, extractSessionCookie } from "./http";

export interface AuthenticatedTestUser {
  tenantId: string;
  userId: string;
  email: string;
  sessionCookie: string;
}

export interface CreatedTenantAdmin {
  tenantId: string;
  userId: string;
  email: string;
}

/**
 * Bootstrap de tenant pour les tests — création directe via Prisma, pas via HTTP, sans
 * connexion. Séparée de `registerTenantAdmin` ci-dessous pour les rares cas où la connexion
 * immédiate serait ambiguë (ex. deux tenants partageant volontairement le même email, voir
 * auth.test.ts « Résolution du tenant à la connexion »).
 *
 * Jusqu'au 2026-08-29, la création de tenant passait par `POST /api/auth/register` (auto-
 * inscription publique). Cette route a été retirée (DOMAINRULES.md, création de tenant réservée
 * au Super Admin plateforme, voir src/lib/super-admin.ts) : la création de tenant n'est plus un
 * parcours public à exercer depuis un test HTTP. Reproduit ici exactement ce que faisait
 * l'ancienne route (tenant + premier ADMIN + groupes de permissions par défaut), même précédent
 * que `createAndLoginMember` ci-dessous qui crée déjà un MEMBER directement via Prisma.
 */
export async function createTenantAdmin(params: {
  tenantName: string;
  tenantSlug: string;
  name: string;
  email: string;
  password: string;
}): Promise<CreatedTenantAdmin> {
  const passwordHash = await bcrypt.hash(params.password, BCRYPT_COST);

  const { tenant, user } = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: { name: params.tenantName, slug: params.tenantSlug },
    });
    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: params.email,
        name: params.name,
        passwordHash,
        role: "ADMIN",
      },
    });
    return { tenant, user };
  });

  await ensureDefaultGroups(tenant.id);

  return { tenantId: tenant.id, userId: user.id, email: params.email };
}

/** `createTenantAdmin` ci-dessus, suivi d'une vraie connexion HTTP (`/api/auth/login`) — pour
 * garder réaliste tout ce qui dépend du comportement de connexion (session, rate limiting,
 * etc.). Ne pas utiliser si l'email fourni existe déjà dans un autre tenant : la connexion
 * deviendrait ambiguë (voir `createTenantAdmin`). */
export async function registerTenantAdmin(params: {
  tenantName: string;
  tenantSlug: string;
  name: string;
  email: string;
  password: string;
}): Promise<AuthenticatedTestUser> {
  const created = await createTenantAdmin(params);

  const loginResponse = await apiFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: params.email, password: params.password }),
  });
  const sessionCookie = extractSessionCookie(loginResponse);

  if (!sessionCookie) {
    throw new Error("Échec de la connexion de test : aucun cookie de session reçu.");
  }

  return { ...created, sessionCookie };
}

export async function createAndLoginMember(params: {
  tenantId: string;
  name: string;
  email: string;
  password: string;
}): Promise<AuthenticatedTestUser> {
  const passwordHash = await bcrypt.hash(params.password, BCRYPT_COST);
  const user = await prisma.user.create({
    data: {
      tenantId: params.tenantId,
      email: params.email,
      name: params.name,
      passwordHash,
      role: "MEMBER",
    },
  });

  const loginResponse = await apiFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: params.email, password: params.password }),
  });
  const sessionCookie = extractSessionCookie(loginResponse);

  if (!sessionCookie) {
    throw new Error("Échec de la connexion du membre de test.");
  }

  return { tenantId: params.tenantId, userId: user.id, email: params.email, sessionCookie };
}
