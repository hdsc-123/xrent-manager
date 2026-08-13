import { getSessionUser } from "@/lib/authz";
import { getCashEntries, getExpenseCategories } from "@/lib/cash-register";
import { ExpensesTable, type ExpenseRow } from "./ExpensesTable";
import { NewExpenseForm } from "./NewExpenseForm";

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function CashExpensesPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

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
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Dépenses de caisse</h1>
        <p className="text-sm text-muted-foreground">Dépenses enregistrées manuellement, par catégorie.</p>
      </div>

      <NewExpenseForm categories={categories.map((category) => ({ id: category.id, name: category.name }))} />

      <ExpensesTable expenses={rows} />
    </div>
  );
}
