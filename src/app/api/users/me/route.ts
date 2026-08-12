import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import {
  getUserById,
  updateUserProfile,
  EmailAlreadyInUseError,
  InvalidCurrentPasswordError,
} from "@/lib/users";
import { validatePassword } from "@/lib/password-policy";
import { logAction } from "@/lib/audit";

/**
 * Profil de l'user connecté (Sprint 10) : GET (lecture directe en base, plus à jour que
 * la session JWT) et PATCH (nom/email/mot de passe). Toujours scopé à l'user de la
 * session — aucun id cible n'est jamais accepté depuis le client, donc un user ne peut
 * jamais modifier un autre user via cette route (distinct de PATCH /api/users/[id],
 * réservée ADMIN). Un changement de mot de passe exige la vérification du mot de passe
 * actuel (distinct de la réinitialisation par un ADMIN, qui ne la vérifie pas).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const current = await getUserById(user.tenantId, user.id);
  if (!current) {
    return NextResponse.json({ error: "Utilisateur introuvable." }, { status: 404 });
  }

  return NextResponse.json({
    user: {
      id: current.id,
      name: current.name,
      email: current.email,
      role: current.role,
      createdAt: current.createdAt,
    },
  });
}

interface PatchProfileBody {
  name?: string;
  email?: string;
  currentPassword?: string;
  newPassword?: string;
}

export async function PATCH(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  let body: PatchProfileBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (body.name !== undefined && !body.name.trim()) {
    return NextResponse.json({ error: "name ne peut pas être vide." }, { status: 400 });
  }

  if (body.email !== undefined && !body.email.trim()) {
    return NextResponse.json({ error: "email ne peut pas être vide." }, { status: 400 });
  }

  if (body.newPassword !== undefined) {
    if (!body.currentPassword) {
      return NextResponse.json(
        { error: "currentPassword est requis pour changer de mot de passe." },
        { status: 400 }
      );
    }

    const passwordErrors = validatePassword(body.newPassword);
    if (passwordErrors.length > 0) {
      return NextResponse.json({ error: passwordErrors[0], errors: passwordErrors }, { status: 400 });
    }
  }

  try {
    const updated = await updateUserProfile(user.tenantId, user.id, {
      name: body.name,
      email: body.email,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });

    if (!updated) {
      return NextResponse.json({ error: "Utilisateur introuvable." }, { status: 404 });
    }

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "user.profile_updated",
      resource: "User",
      resourceId: user.id,
      metadata: {
        nameChanged: body.name !== undefined,
        emailChanged: body.email !== undefined,
        passwordChanged: body.newPassword !== undefined,
      },
    });

    return NextResponse.json({
      user: { id: updated.id, name: updated.name, email: updated.email, role: updated.role },
    });
  } catch (error) {
    if (error instanceof EmailAlreadyInUseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidCurrentPasswordError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
