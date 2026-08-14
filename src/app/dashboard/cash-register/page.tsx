import Link from "next/link";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { recomputeCashRegisterBalance, getDailyBreakdown, getCashEntries } from "@/lib/cash-register";
import { formatMoney } from "@/lib/format";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { DailyBreakdownChart } from "./CashRegisterCharts";

const TYPE_LABELS: Record<string, string> = { ENTRY: "Entrée", EXPENSE: "Dépense" };

export default async function CashRegisterPage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "cash_register.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Caisse</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter la caisse.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [summary, dailyBreakdown, recentOperations] = await Promise.all([
    recomputeCashRegisterBalance(user.tenantId),
    getDailyBreakdown(user.tenantId, from, to),
    getCashEntries(user.tenantId, { take: 10 }),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Caisse</h1>
          <p className="text-sm text-muted-foreground">Solde, entrées et dépenses de votre organisation.</p>
        </div>
        <div className="flex gap-2">
          <Button render={<Link href="/dashboard/cash-register/entries" />} variant="outline" size="sm">
            Entrées
          </Button>
          <Button render={<Link href="/dashboard/cash-register/expenses" />} variant="outline" size="sm">
            Dépenses
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardDescription>Solde actuel</CardDescription>
          <CardTitle className="text-4xl">{formatMoney(summary.currentBalance, summary.currency)}</CardTitle>
        </CardHeader>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Report du mois précédent</CardDescription>
            <CardTitle className="text-xl">{formatMoney(summary.previousBalance, summary.currency)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Entrées du mois</CardDescription>
            <CardTitle className="text-xl text-chart-2">
              +{formatMoney(summary.monthEntries, summary.currency)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Dépenses du mois</CardDescription>
            <CardTitle className="text-xl text-destructive">
              -{formatMoney(summary.monthExpenses, summary.currency)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Solde final</CardDescription>
            <CardTitle className="text-xl">{formatMoney(summary.finalBalance, summary.currency)}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Entrées vs dépenses</CardTitle>
          <CardDescription>Par jour, sur les 30 derniers jours.</CardDescription>
        </CardHeader>
        <CardContent>
          <DailyBreakdownChart data={dailyBreakdown} currency={summary.currency} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dernières opérations</CardTitle>
        </CardHeader>
        <CardContent>
          {recentOperations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune opération.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Catégorie</th>
                    <th className="px-3 py-2 font-medium">Description</th>
                    <th className="px-3 py-2 font-medium">Montant</th>
                  </tr>
                </thead>
                <tbody>
                  {recentOperations.map((operation) => (
                    <tr key={operation.id} className="border-t border-border">
                      <td className="px-3 py-2">{operation.createdAt.toLocaleString("fr-FR")}</td>
                      <td className="px-3 py-2">
                        <Badge variant={operation.type === "ENTRY" ? "default" : "outline"}>
                          {TYPE_LABELS[operation.type] ?? operation.type}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">{operation.category ?? "—"}</td>
                      <td className="px-3 py-2">{operation.description ?? "—"}</td>
                      <td className="px-3 py-2">
                        {operation.type === "ENTRY" ? "+" : "-"}
                        {formatMoney(operation.amount, operation.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
