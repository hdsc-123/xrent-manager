import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { updateCashEntry, deleteCashEntry, InvalidCashEntryAmountError, CashEntryNotEditableError } from "@/lib/cash-register";
import { logAction } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface UpdateCashEntryBody {
  category?: string;
  amount?: number;
  description?: string;
}

/** Sprint 19 : modification d'une écriture de caisse MANUELLE uniquement (voir
 * src/lib/cash-register.ts, updateCashEntry) — une écriture issue d'un paiement
 * (contractId renseigné) reste immuable, 409 CashEntryNotEditableError sinon. */
export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "cash_register.edit"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;

  let body: UpdateCashEntryBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  try {
    const entry = await updateCashEntry(user.tenantId, id, {
      category: body.category,
      amount: body.amount,
      description: body.description,
    });

    if (!entry) {
      return NextResponse.json({ error: "Écriture introuvable." }, { status: 404 });
    }

    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "cashEntry.updated",
      resource: "CashEntry",
      resourceId: entry.id,
      metadata: { changes: body } as unknown as Prisma.InputJsonValue,
    });

    return NextResponse.json({ entry });
  } catch (error) {
    if (error instanceof InvalidCashEntryAmountError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof CashEntryNotEditableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la modification de l'écriture de caisse :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}

/** Sprint 19 : suppression d'une écriture de caisse MANUELLE uniquement — voir PATCH ci-dessus. */
export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "cash_register.delete"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;

  try {
    const deleted = await deleteCashEntry(user.tenantId, id);
    if (!deleted) {
      return NextResponse.json({ error: "Écriture introuvable." }, { status: 404 });
    }
  } catch (error) {
    if (error instanceof CashEntryNotEditableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Erreur lors de la suppression de l'écriture de caisse :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }

  await logAction({
    tenantId: user.tenantId,
    userId: user.id,
    action: "cashEntry.deleted",
    resource: "CashEntry",
    resourceId: id,
  });

  return NextResponse.json({ success: true });
}
