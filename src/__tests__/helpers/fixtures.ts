import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { apiFetch, extractSessionCookie } from "./http";

export interface AuthenticatedTestUser {
  tenantId: string;
  userId: string;
  email: string;
  sessionCookie: string;
}

export async function registerTenantAdmin(params: {
  tenantName: string;
  tenantSlug: string;
  name: string;
  email: string;
  password: string;
}): Promise<AuthenticatedTestUser> {
  const registerResponse = await apiFetch("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(params),
  });

  if (registerResponse.status !== 201) {
    throw new Error(
      `Échec de l'inscription de test (${registerResponse.status}) : ${await registerResponse.text()}`
    );
  }

  const { tenant, user } = await registerResponse.json();

  const loginResponse = await apiFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: params.email, password: params.password }),
  });
  const sessionCookie = extractSessionCookie(loginResponse);

  if (!sessionCookie) {
    throw new Error("Échec de la connexion de test : aucun cookie de session reçu.");
  }

  return { tenantId: tenant.id, userId: user.id, email: params.email, sessionCookie };
}

export async function createAndLoginMember(params: {
  tenantId: string;
  name: string;
  email: string;
  password: string;
}): Promise<AuthenticatedTestUser> {
  const passwordHash = await bcrypt.hash(params.password, 12);
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
