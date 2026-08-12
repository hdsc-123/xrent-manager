import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createInvitation, getInvitations } from "@/lib/invitations";
import { logAction } from "@/lib/audit";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  const invitations = await getInvitations(user.tenantId);
  return NextResponse.json({ invitations });
}

interface CreateInvitationBody {
  email?: string;
  role?: string;
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Accès réservé aux administrateurs." }, { status: 403 });
  }

  let body: CreateInvitationBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { email, role = "MEMBER" } = body;
  if (!email) {
    return NextResponse.json({ error: "email est requis." }, { status: 400 });
  }
  if (role !== "ADMIN" && role !== "MEMBER") {
    return NextResponse.json({ error: "role doit être ADMIN ou MEMBER." }, { status: 400 });
  }

  const existingUser = await prisma.user.findUnique({
    where: { tenantId_email: { tenantId: user.tenantId, email } },
  });
  if (existingUser) {
    return NextResponse.json({ error: "Un utilisateur existe déjà avec cet email." }, { status: 409 });
  }

  const invitation = await createInvitation({
    tenantId: user.tenantId,
    invitedByUserId: user.id,
    email,
    role,
  });

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "invitation.created",
    resource: "Invitation",
    resourceId: invitation.id,
    metadata: { email, role },
  });

  return NextResponse.json({ invitation }, { status: 201 });
}
