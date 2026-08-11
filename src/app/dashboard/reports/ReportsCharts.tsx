"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMoney } from "@/lib/format";

/** Ramp du thème shadcn/ui existant (base-nova, achromatique) — voir src/app/globals.css. */
const STATUS_COLORS: Record<string, string> = {
  PENDING: "var(--color-chart-1)",
  CONFIRMED: "var(--color-chart-2)",
  ACTIVE: "var(--color-chart-3)",
  COMPLETED: "var(--color-chart-4)",
  CANCELLED: "var(--color-chart-5)",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  CONFIRMED: "Confirmée",
  ACTIVE: "En cours",
  COMPLETED: "Terminée",
  CANCELLED: "Annulée",
};

interface RevenueChartProps {
  data: { month: string; revenue: number }[];
  currency: string;
}

export function RevenueByMonthChart({ data, currency }: RevenueChartProps) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Aucune donnée sur cette période.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="month" tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
        <YAxis
          tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(value: number) => formatMoney(value, currency)}
          width={90}
        />
        <Tooltip
          formatter={(value) => formatMoney(Number(value), currency)}
          contentStyle={{
            background: "var(--popover)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Bar dataKey="revenue" name="Revenu" fill="var(--color-chart-1)" radius={[4, 4, 0, 0]} maxBarSize={48} />
      </BarChart>
    </ResponsiveContainer>
  );
}

interface LocationsByStatusChartProps {
  data: { status: string; count: number }[];
}

export function LocationsByStatusChart({ data }: LocationsByStatusChartProps) {
  if (data.every((entry) => entry.count === 0)) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Aucune location sur cette période.</p>;
  }

  const chartData = data.map((entry) => ({ ...entry, label: STATUS_LABELS[entry.status] ?? entry.status }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
        <YAxis
          tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
          width={32}
        />
        <Tooltip
          contentStyle={{
            background: "var(--popover)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Bar dataKey="count" name="Locations" radius={[4, 4, 0, 0]} maxBarSize={48}>
          {chartData.map((entry) => (
            <Cell key={entry.status} fill={STATUS_COLORS[entry.status] ?? "var(--color-chart-1)"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
