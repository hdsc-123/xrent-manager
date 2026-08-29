import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

/**
 * Phase 3B MFA (2026-08-29, AGENTS.md brief) : état MFA de l'utilisateur de la session — jamais
 * le secret, jamais l'URI otpauth://, jamais les codes de récupération (tous relisibles
 * uniquement au moment de leur génération, voir POST /api/mfa/enroll(/confirm)).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const current = await prisma.user.findUnique({
    where: { id: user.id },
    select: { mfaEnabled: true, mfaSecretCiphertext: true, mfaSecretConfirmedAt: true },
  });
  if (!current) {
    return NextResponse.json({ error: "Utilisateur introuvable." }, { status: 404 });
  }

  return NextResponse.json({
    mfaEnabled: current.mfaEnabled,
    hasPendingEnrollment: Boolean(current.mfaSecretCiphertext) && !current.mfaEnabled,
  });
}
