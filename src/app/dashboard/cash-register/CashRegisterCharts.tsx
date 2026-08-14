"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMoney } from "@/lib/format";

const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
};

interface DailyBreakdownChartProps {
  data: { date: string; entries: number; expenses: number }[];
  currency: string;
}

export function DailyBreakdownChart({ data, currency }: DailyBreakdownChartProps) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Aucune opération sur cette période.</p>;
  }

  const chartData = data.map((entry) => ({
    ...entry,
    label: new Date(entry.date).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }),
  }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
        <YAxis
          tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(value: number) => formatMoney(value, currency)}
          width={90}
        />
        <Tooltip formatter={(value) => formatMoney(Number(value), currency)} contentStyle={TOOLTIP_STYLE} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="entries" name="Entrées" fill="var(--color-chart-2)" radius={[4, 4, 0, 0]} maxBarSize={32} />
        <Bar dataKey="expenses" name="Dépenses" fill="var(--color-chart-5)" radius={[4, 4, 0, 0]} maxBarSize={32} />
      </BarChart>
    </ResponsiveContainer>
  );
}

interface CashVsCardChartProps {
  data: { date: string; cash: number; card: number }[];
  currency: string;
}

/** Sprint 19 (DOMAINRULES.md section 37) : répartition espèces/carte des entrées, par jour —
 * même convention visuelle que DailyBreakdownChart ci-dessus. Un mode de règlement autre que
 * CASH/CARD (virement/chèque/autre/absent) n'apparaît dans aucune des deux séries — voir
 * getDailyBreakdown, src/lib/cash-register.ts. */
export function CashVsCardChart({ data, currency }: CashVsCardChartProps) {
  if (data.every((entry) => entry.cash === 0 && entry.card === 0)) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Aucune entrée espèces/carte sur cette période.</p>;
  }

  const chartData = data.map((entry) => ({
    ...entry,
    label: new Date(entry.date).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }),
  }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
        <YAxis
          tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(value: number) => formatMoney(value, currency)}
          width={90}
        />
        <Tooltip formatter={(value) => formatMoney(Number(value), currency)} contentStyle={TOOLTIP_STYLE} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="cash" name="Espèces" fill="var(--color-chart-1)" radius={[4, 4, 0, 0]} maxBarSize={32} />
        <Bar dataKey="card" name="Carte" fill="var(--color-chart-3)" radius={[4, 4, 0, 0]} maxBarSize={32} />
      </BarChart>
    </ResponsiveContainer>
  );
}
