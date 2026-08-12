import { NextResponse } from "next/server";
import { declineInvitation, InvitationExpiredError, InvitationNotPendingError } from "@/lib/invitations";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Publique, comme /accept : l'invité n'a pas encore de session dans ce tenant. */
export async function POST(_request: Request, { params }: RouteParams) {
  const { id } = await params;

  try {
    const invitation = await declineInvitation(id);
    if (!invitation) {
      return NextResponse.json({ error: "Invitation introuvable." }, { status: 404 });
    }

    await logAction({
      tenantId: invitation.tenantId,
      userId: null,
      action: "invitation.declined",
      resource: "Invitation",
      resourceId: id,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof InvitationNotPendingError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvitationExpiredError) {
      return NextResponse.json({ error: error.message }, { status: 410 });
    }
    throw error;
  }
}
