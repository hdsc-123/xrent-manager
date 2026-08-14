import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getExpenseCategories, createExpenseCategory, ExpenseCategoryNameInUseError } from "@/lib/cash-register";
import { logAction } from "@/lib/audit";

/**
 * CRUD minimal (GET/POST uniquement) — ajouté au-delà de la liste de fichiers du sprint :
 * le modèle ExpenseCategory ne serait sinon jamais accessible en écriture depuis l'UI
 * (le formulaire de dépense a besoin d'une liste de catégories à proposer/compléter).
 * Pas de PATCH/DELETE : renommer/supprimer une catégorie déjà utilisée par des CashEntry
 * existants romprait leur lisibilité historique, hors périmètre de ce sprint.
 */
export async function GET() {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "cash_register.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const categories = await getExpenseCategories(user.tenantId);
  return NextResponse.json({ categories });
}

interface CreateExpenseCategoryBody {
  name?: string;
  color?: string;
}

export async function POST(request: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "cash_register.manage_categories"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  let body: CreateExpenseCategoryBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (!body.name || !body.name.trim()) {
    return NextResponse.json({ error: "name est requis." }, { status: 400 });
  }

  try {
    const category = await createExpenseCategory({
      tenantId: user.tenantId,
      name: body.name.trim(),
      color: body.color,
    });
    await logAction({
      tenantId: user.tenantId,
      userId: user.id,
      action: "expenseCategory.created",
      resource: "ExpenseCategory",
      resourceId: category.id,
      metadata: { name: category.name },
    });
    return NextResponse.json({ category }, { status: 201 });
  } catch (error) {
    if (error instanceof ExpenseCategoryNameInUseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    console.error("Erreur lors de la création de la catégorie de dépense :", error);
    return NextResponse.json({ error: "Erreur interne." }, { status: 500 });
  }
}
