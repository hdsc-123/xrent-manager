import { NextResponse } from "next/server";
import { AuthError } from "next-auth";
import { signIn, resolveLoginTenants } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface LoginBody {
  email?: string;
  password?: string;
  tenantId?: string;
  rememberMe?: boolean;
}

/**
 * Résolution du tenant à la connexion (Sprint 9, Option B — HANDOFF.md point 16) :
 * si l'email + mot de passe correspondent à plusieurs tenants, ne crée aucune session
 * et renvoie la liste pour sélection explicite côté client. Le mot de passe est
 * toujours vérifié avant de révéler cette liste (voir resolveLoginTenants).
 */
export async function POST(request: Request) {
  let body: LoginBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { email, password, tenantId, rememberMe = true } = body;
  if (!email || !password) {
    return NextResponse.json({ error: "email et password sont requis." }, { status: 400 });
  }

  if (!tenantId) {
    const matches = await resolveLoginTenants(email, password);

    if (matches.length === 0) {
      return NextResponse.json({ error: "Identifiants invalides." }, { status: 401 });
    }

    if (matches.length > 1) {
      return NextResponse.json({ requiresTenantSelection: true, tenants: matches });
    }
  }

  try {
    // Ne jamais passer tenantId: undefined ici — signIn() sérialise les options via
    // URLSearchParams, qui coerce `undefined` en la chaîne littérale "undefined"
    // (piège découvert pendant ce sprint), ce qui casserait le lookup tenant-scopé.
    await signIn("credentials", {
      email,
      password,
      rememberMe: String(rememberMe),
      ...(tenantId ? { tenantId } : {}),
      redirect: false,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      // Ne jamais distinguer "compte inexistant" de "mot de passe invalide" (SECURITY.md section 3).
      return NextResponse.json({ error: "Identifiants invalides." }, { status: 401 });
    }
    throw error;
  }

  const user = tenantId
    ? await prisma.user.findUnique({ where: { tenantId_email: { tenantId, email } } })
    : await prisma.user.findFirst({ where: { email } });
  if (!user) {
    return NextResponse.json({ error: "Identifiants invalides." }, { status: 401 });
  }

  return NextResponse.json({
    user: {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  });
}
