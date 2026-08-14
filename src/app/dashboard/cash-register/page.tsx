import Link from "next/link";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import {
  recomputeCashRegisterBalance,
  getDailyBreakdown,
  getCashEntries,
  getCashBalanceByAgency,
  getUnattributedCashAmount,
} from "@/lib/cash-register";
import { formatMoney } from "@/lib/format";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { DailyBreakdownChart, CashVsCardChart } from "./CashRegisterCharts";

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

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  // Sprint 22 (DOMAINRULES.md section 23, révisée) : "Caisse" devient aussi un centre de
  // pilotage financier multi-agence — le solde de départ par agence est désormais intégré au
  // calcul réel d'un solde *par agence* (getCashBalanceByAgency), en plus du solde global
  // ci-dessus (CashRegister reste un singleton par tenant, décision reconduite). Scopé aux
  // agences accessibles à l'appelant (null = toutes, ADMIN) — un MEMBER restreint à une agence
  // ne voit que son bloc, l'admin principal voit tout.
  const [summary, dailyBreakdown, recentOperations, agencyBalances, unattributed] = await Promise.all([
    recomputeCashRegisterBalance(user.tenantId),
    getDailyBreakdown(user.tenantId, from, to),
    getCashEntries(user.tenantId, { take: 10 }),
    getCashBalanceByAgency(user.tenantId, accessibleAgencyIds),
    getUnattributedCashAmount(user.tenantId),
  ]);
  const hasUnattributed = unattributed.entries > 0 || unattributed.expenses > 0;

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

      {agencyBalances.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pilotage financier par agence</CardTitle>
            <CardDescription>
              Solde de départ + entrées − dépenses de chaque agence (la caisse reste commune à tout
              le tenant pour le solde global ci-dessus — voir DOMAINRULES.md section 23).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Agence</th>
                    <th className="px-3 py-2 font-medium">Solde de départ</th>
                    <th className="px-3 py-2 font-medium">Entrées</th>
                    <th className="px-3 py-2 font-medium">Dépenses</th>
                    <th className="px-3 py-2 font-medium">Solde</th>
                  </tr>
                </thead>
                <tbody>
                  {agencyBalances.map((agency) => (
                    <tr key={agency.agencyId} className="border-t border-border">
                      <td className="px-3 py-2">{agency.agencyName}</td>
                      <td className="px-3 py-2">{formatMoney(agency.startingBalance, agency.currency)}</td>
                      <td className="px-3 py-2 text-chart-2">+{formatMoney(agency.entries, agency.currency)}</td>
                      <td className="px-3 py-2 text-destructive">-{formatMoney(agency.expenses, agency.currency)}</td>
                      <td className="px-3 py-2 font-medium">{formatMoney(agency.balance, agency.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {hasUnattributed && (
              <p className="mt-2 text-xs text-muted-foreground">
                Écart avec le solde global : {formatMoney(unattributed.entries, unattributed.currency)} d&apos;entrées
                et {formatMoney(unattributed.expenses, unattributed.currency)} de dépenses ne sont rattachées à
                aucune agence (écritures manuelles sans agence choisie).
              </p>
            )}
          </CardContent>
        </Card>
      )}

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

      {/* Sprint 19 (DOMAINRULES.md section 37) : séparation espèces/carte des entrées du mois —
          rapprochement de caisse physique (le compte espèces réel doit correspondre à ce total,
          pas au solde global qui mélange tous les modes de règlement). */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Espèces encaissées ce mois</CardDescription>
            <CardTitle className="text-xl">{formatMoney(summary.monthCash, summary.currency)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Carte encaissée ce mois</CardDescription>
            <CardTitle className="text-xl">{formatMoney(summary.monthCard, summary.currency)}</CardTitle>
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
          <CardTitle>Espèces vs carte</CardTitle>
          <CardDescription>Entrées par mode de règlement, par jour, sur les 30 derniers jours.</CardDescription>
        </CardHeader>
        <CardContent>
          <CashVsCardChart data={dailyBreakdown} currency={summary.currency} />
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
