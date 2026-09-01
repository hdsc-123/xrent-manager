import { NextResponse } from "next/server";
import {
  acceptInvitation,
  InvitationExpiredError,
  InvitationNotPendingError,
  UserAlreadyExistsError,
} from "@/lib/invitations";
import { validatePassword } from "@/lib/password-policy";
import { logAction } from "@/lib/audit";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_PUBLIC_JSON_BODY_BYTES } from "@/lib/request-guards";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface AcceptBody {
  name?: string;
  password?: string;
}

/** Publique : pas de session possible avant l'acceptation (le user n'existe pas encore). */
export async function POST(request: Request, { params }: RouteParams) {
  if (isRequestBodyTooLarge(request, MAX_PUBLIC_JSON_BODY_BYTES)) {
    return requestBodyTooLargeResponse(MAX_PUBLIC_JSON_BODY_BYTES);
  }

  const { id } = await params;

  let body: AcceptBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  const { name, password } = body;
  if (!name || !password) {
    return NextResponse.json({ error: "name et password sont requis." }, { status: 400 });
  }

  const passwordErrors = validatePassword(password);
  if (passwordErrors.length > 0) {
    return NextResponse.json({ error: passwordErrors[0], errors: passwordErrors }, { status: 400 });
  }

  try {
    const result = await acceptInvitation(id, { name, password });
    if (!result) {
      return NextResponse.json({ error: "Invitation introuvable." }, { status: 404 });
    }

    await logAction({
      tenantId: result.invitation.tenantId,
      userId: result.user.id,
      action: "invitation.accepted",
      resource: "Invitation",
      resourceId: id,
    });

    await logAction({
      tenantId: result.user.tenantId,
      userId: result.user.id,
      action: "user.created",
      resource: "User",
      resourceId: result.user.id,
      metadata: { email: result.user.email, role: result.user.role },
    });

    return NextResponse.json({
      user: { id: result.user.id, email: result.user.email, tenantId: result.user.tenantId },
    });
  } catch (error) {
    if (error instanceof InvitationNotPendingError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvitationExpiredError) {
      return NextResponse.json({ error: error.message }, { status: 410 });
    }
    if (error instanceof UserAlreadyExistsError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
