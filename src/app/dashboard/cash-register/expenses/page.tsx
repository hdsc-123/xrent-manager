import Link from "next/link";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getCashEntries, getExpenseCategories } from "@/lib/cash-register";
import { prisma } from "@/lib/prisma";
import { Button, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
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
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const [expenses, categories, agencies] = await Promise.all([
    getCashEntries(user.tenantId, {
      type: "EXPENSE",
      from: params.from ? new Date(params.from) : undefined,
      to: params.to ? new Date(params.to) : undefined,
      // Sprint 24 (correction) : voir le commentaire équivalent sur entries/page.tsx.
      agencyIds: accessibleAgencyIds ?? undefined,
    }),
    getExpenseCategories(user.tenantId),
    prisma.agency.findMany({
      where: { tenantId: user.tenantId, ...(accessibleAgencyIds ? { id: { in: accessibleAgencyIds } } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
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
          agencies={agencies}
        />
      )}

      <form className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3" method="get">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
            Du
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={params.from ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="to" className="text-xs font-medium text-muted-foreground">
            Au
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={params.to ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {(params.from || params.to) && (
          <Button render={<Link href="/dashboard/cash-register/expenses" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <ExpensesTable
        expenses={rows}
        categories={categories.map((category) => ({ id: category.id, name: category.name }))}
        canEdit={canEdit}
        canDelete={canDelete}
      />
    </div>
  );
}
