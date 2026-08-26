import type { Invitation } from "@prisma/client";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { BCRYPT_COST } from "@/lib/bcrypt-cost";

/**
 * Invitation d'un nouvel utilisateur dans un tenant existant (Sprint 9). Pas d'envoi
 * d'email (décision Sprint 7 reconduite) : le lien /invitations/[id] est partagé
 * manuellement par l'ADMIN depuis /dashboard/invitations. `id` (cuid) sert directement
 * d'identifiant non-devinable, voir prisma/schema.prisma.
 */

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class InvitationNotPendingError extends Error {
  constructor() {
    super("Cette invitation n'est plus en attente.");
    this.name = "InvitationNotPendingError";
  }
}

export class InvitationExpiredError extends Error {
  constructor() {
    super("Cette invitation a expiré.");
    this.name = "InvitationExpiredError";
  }
}

export class UserAlreadyExistsError extends Error {
  constructor() {
    super("Un utilisateur existe déjà avec cet email pour ce tenant.");
    this.name = "UserAlreadyExistsError";
  }
}

export interface CreateInvitationInput {
  tenantId: string;
  invitedByUserId: string;
  email: string;
  role: "ADMIN" | "MEMBER";
}

export async function createInvitation(data: CreateInvitationInput): Promise<Invitation> {
  return prisma.invitation.create({
    data: {
      tenantId: data.tenantId,
      invitedByUserId: data.invitedByUserId,
      email: data.email,
      role: data.role,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    },
  });
}

export async function getInvitations(tenantId: string): Promise<Invitation[]> {
  return prisma.invitation.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getInvitationById(id: string): Promise<Invitation | null> {
  return prisma.invitation.findUnique({ where: { id } });
}

async function assertPendingAndNotExpired(invitation: Invitation): Promise<void> {
  if (invitation.status !== "PENDING") {
    throw new InvitationNotPendingError();
  }

  if (invitation.expiresAt < new Date()) {
    await prisma.invitation.update({ where: { id: invitation.id }, data: { status: "EXPIRED" } });
    throw new InvitationExpiredError();
  }
}

export interface AcceptInvitationInput {
  name: string;
  password: string;
}

/**
 * `email`/`role` toujours pris de l'invitation, jamais du client (SECURITY.md section 4) :
 * accepter une invitation ne peut créer qu'un user avec l'email invité et le rôle décidé
 * par l'ADMIN qui a envoyé l'invitation.
 */
export async function acceptInvitation(id: string, data: AcceptInvitationInput) {
  const invitation = await getInvitationById(id);
  if (!invitation) {
    return null;
  }

  await assertPendingAndNotExpired(invitation);

  const existing = await prisma.user.findUnique({
    where: { tenantId_email: { tenantId: invitation.tenantId, email: invitation.email } },
  });
  if (existing) {
    throw new UserAlreadyExistsError();
  }

  const passwordHash = await bcrypt.hash(data.password, BCRYPT_COST);

  let user;
  try {
    [, user] = await prisma.$transaction([
      prisma.invitation.update({ where: { id }, data: { status: "ACCEPTED" } }),
      prisma.user.create({
        data: {
          tenantId: invitation.tenantId,
          email: invitation.email,
          name: data.name,
          passwordHash,
          role: invitation.role,
        },
      }),
    ]);
  } catch (error) {
    // Sprint technique 4 : deux acceptations concurrentes de la même invitation passent
    // toutes deux la vérification PENDING ci-dessus (lue avant toute écriture) ; seule la
    // contrainte unique `tenantId_email` départage le gagnant. Sans ce filet, la perdante
    // remontait un P2002 brut (500) au lieu du 409 `UserAlreadyExistsError` déjà géré par
    // la route — le transaction array annule alors aussi la mise à jour du statut de
    // l'invitation, donc aucune incohérence de données n'en résultait, seulement une
    // erreur HTTP incorrecte.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new UserAlreadyExistsError();
    }
    throw error;
  }

  return { invitation, user };
}

export async function declineInvitation(id: string): Promise<Invitation | null> {
  const invitation = await getInvitationById(id);
  if (!invitation) {
    return null;
  }

  await assertPendingAndNotExpired(invitation);

  return prisma.invitation.update({ where: { id }, data: { status: "DECLINED" } });
}

export async function revokeInvitation(tenantId: string, id: string): Promise<boolean> {
  const invitation = await prisma.invitation.findFirst({ where: { id, tenantId } });
  if (!invitation || invitation.status !== "PENDING") {
    return false;
  }

  await prisma.invitation.delete({ where: { id } });
  return true;
}
