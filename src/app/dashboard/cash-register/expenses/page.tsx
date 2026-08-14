import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getCashEntries, getExpenseCategories } from "@/lib/cash-register";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { ExpensesTable, type ExpenseRow } from "./ExpensesTable";
import { NewExpenseForm } from "./NewExpenseForm";

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function CashExpensesPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "cash_register.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Dépenses de caisse</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter la caisse.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const canCreateExpense = await can(user, "cash_register.create_expense");
  const canManageCategories = await can(user, "cash_register.manage_categories");
  const canEdit = await can(user, "cash_register.edit");
  const canDelete = await can(user, "cash_register.delete");
  const params = await searchParams;
  const [expenses, categories] = await Promise.all([
    getCashEntries(user.tenantId, {
      type: "EXPENSE",
      from: params.from ? new Date(params.from) : undefined,
      to: params.to ? new Date(params.to) : undefined,
    }),
    getExpenseCategories(user.tenantId),
  ]);

  const rows: ExpenseRow[] = expenses.map((entry) => ({
    id: entry.id,
    category: entry.category,
    amount: entry.amount,
    currency: entry.currency,
    description: entry.description,
    createdAt: entry.createdAt.toISOString(),
    contractId: entry.contractId,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Dépenses de caisse</h1>
        <p className="text-sm text-muted-foreground">Dépenses enregistrées manuellement, par catégorie.</p>
      </div>

      {canCreateExpense && (
        <NewExpenseForm
          categories={categories.map((category) => ({ id: category.id, name: category.name }))}
          canManageCategories={canManageCategories}
        />
      )}

      <ExpensesTable
        expenses={rows}
        categories={categories.map((category) => ({ id: category.id, name: category.name }))}
        canEdit={canEdit}
        canDelete={canDelete}
      />
    </div>
  );
}
