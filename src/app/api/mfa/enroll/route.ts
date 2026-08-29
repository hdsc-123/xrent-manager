import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { generateTotpSecret, buildOtpauthUri } from "@/lib/mfa";
import { encryptMfaSecret } from "@/lib/mfa-encryption";
import { logAction } from "@/lib/audit";

/**
 * Phase 3B MFA (2026-08-29, AGENTS.md brief) : démarre (ou remplace) un enrôlement MFA en
 * attente pour l'utilisateur de la session — jamais un autre utilisateur, `getSessionUser()` est
 * l'unique source de l'identité (aucun id cible n'est jamais accepté depuis le client, même
 * principe que PATCH /api/users/me). Un enrôlement déjà confirmé (`mfaEnabled: true`) doit être
 * désactivé avant d'en recommencer un nouveau — hors périmètre de cette phase (voir
 * AGENTS.md, "Ne crée pas encore : ... suppression MFA").
 *
 * Chaque appel remplace tout enrôlement non confirmé précédent (nouveau secret, nouvel IV,
 * `mfaLastUsedStep` réinitialisé) : c'est la mesure d'expiration/remplacement demandée — un
 * secret en attente jamais confirmé n'a aucune valeur propre tant que `mfaSecretConfirmedAt`
 * reste `null`, il n'y a donc rien à "expirer" explicitement au-delà de son remplacement pur et
 * simple par le prochain appel.
 */
export async function POST() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const current = await prisma.user.findUnique({
    where: { id: user.id },
    select: { mfaEnabled: true, tenantId: true, email: true },
  });
  if (!current) {
    return NextResponse.json({ error: "Utilisateur introuvable." }, { status: 404 });
  }

  if (current.mfaEnabled) {
    return NextResponse.json({ error: "MFA déjà activée sur ce compte." }, { status: 409 });
  }

  const secretBase32 = generateTotpSecret();
  const ciphertext = encryptMfaSecret(secretBase32);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      mfaSecretCiphertext: ciphertext,
      mfaSecretConfirmedAt: null,
      mfaLastUsedStep: null,
    },
  });

  await logAction({
    tenantId: current.tenantId,
    userId: user.id,
    action: "mfa.enroll.started",
    resource: "User",
    resourceId: user.id,
  });

  const otpauthUri = buildOtpauthUri({
    secretBase32,
    accountEmail: current.email,
    issuer: "XRent Manager",
  });

  // Le secret Base32/l'URI otpauth:// ne sont retournés qu'une seule fois, à cet instant précis
  // (jamais relisibles ensuite via aucune API, voir GET /api/mfa/status) — jamais journalisés
  // ci-dessus (logAction ne reçoit ni l'un ni l'autre).
  return NextResponse.json({ secretBase32, otpauthUri });
}
