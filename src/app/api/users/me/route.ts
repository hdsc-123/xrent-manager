import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_AUTHENTICATED_JSON_BODY_BYTES } from "@/lib/request-guards";
import {
  getUserById,
  updateUserProfile,
  EmailAlreadyInUseError,
  InvalidCurrentPasswordError,
} from "@/lib/users";
import { validatePassword } from "@/lib/password-policy";
import { logAction } from "@/lib/audit";
import { createSecurityNotification } from "@/lib/security-notifications";

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
      phone: current.phone,
      avatar: current.avatar,
      role: current.role,
      createdAt: current.createdAt,
    },
  });
}

interface PatchProfileBody {
  name?: string;
  email?: string;
  phone?: string | null;
  avatar?: string | null;
  currentPassword?: string;
  newPassword?: string;
}

export async function PATCH(request: Request) {
  if (isRequestBodyTooLarge(request, MAX_AUTHENTICATED_JSON_BODY_BYTES)) {
    return requestBodyTooLargeResponse(MAX_AUTHENTICATED_JSON_BODY_BYTES);
  }

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

  if (body.avatar !== undefined && body.avatar !== null && body.avatar !== "" && !/^https?:\/\//.test(body.avatar)) {
    return NextResponse.json({ error: "avatar doit être une URL http(s) valide." }, { status: 400 });
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
    const result = await updateUserProfile(user.tenantId, user.id, {
      name: body.name,
      email: body.email,
      phone: body.phone === "" ? null : body.phone,
      avatar: body.avatar === "" ? null : body.avatar,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });

    if (!result) {
      return NextResponse.json({ error: "Utilisateur introuvable." }, { status: 404 });
    }

    const { user: updated, emailChanged, passwordChanged } = result;

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "user.profile_updated",
      resource: "User",
      resourceId: user.id,
      metadata: {
        nameChanged: body.name !== undefined,
        emailChanged,
        phoneChanged: body.phone !== undefined,
        avatarChanged: body.avatar !== undefined,
        passwordChanged,
      },
    });

    // Politique MFA (2026-08-30) : notification de sécurité in-app sur un changement réel
    // d'email/mot de passe — jamais sur la simple présence du champ dans la requête (voir
    // UpdateUserProfileResult, src/lib/users.ts). Les sessions actives ont déjà été révoquées
    // par updateUserProfile lui-même (sessionRevokedAt), y compris celle de cette requête.
    if (emailChanged) {
      await createSecurityNotification({ tenantId: user.tenantId, userId: user.id, type: "EMAIL_CHANGED" });
    }
    if (passwordChanged) {
      await createSecurityNotification({ tenantId: user.tenantId, userId: user.id, type: "PASSWORD_CHANGED" });
    }

    return NextResponse.json({
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        phone: updated.phone,
        avatar: updated.avatar,
        role: updated.role,
      },
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
