"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMoney } from "@/lib/format";

const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
};

const PIE_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

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

interface LocationsByMonthChartProps {
  data: { month: string; count: number }[];
}

export function LocationsByMonthChart({ data }: LocationsByMonthChartProps) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Aucune donnée sur cette période.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="month" tick={{ fontSize: 12, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
        <YAxis
          tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
          width={32}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Line
          type="monotone"
          dataKey="count"
          name="Locations"
          stroke="var(--color-chart-1)"
          strokeWidth={2}
          dot={{ r: 3, fill: "var(--color-chart-1)" }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

interface RevenueByAgencyChartProps {
  data: { agencyName: string; revenue: number }[];
  currency: string;
}

export function RevenueByAgencyChart({ data, currency }: RevenueByAgencyChartProps) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Aucune donnée sur cette période.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Tooltip formatter={(value) => formatMoney(Number(value), currency)} contentStyle={TOOLTIP_STYLE} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Pie data={data} dataKey="revenue" nameKey="agencyName" innerRadius={50} outerRadius={90} paddingAngle={2}>
          {data.map((entry, index) => (
            <Cell key={entry.agencyName} fill={PIE_COLORS[index % PIE_COLORS.length]} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

interface OccupancyGaugeProps {
  /** Taux entre 0 et 1. */
  rate: number;
}

/** Jauge d'occupation — recharts n'a pas de composant "gauge" natif, RadialBarChart en demi-cercle
 * est l'équivalent idiomatique le plus proche (pattern courant avec cette librairie). */
export function OccupancyGauge({ rate }: OccupancyGaugeProps) {
  const percent = Math.round(Math.min(1, Math.max(0, rate)) * 100);
  const data = [{ value: percent }];

  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={180}>
        <RadialBarChart data={data} startAngle={180} endAngle={0} innerRadius="70%" outerRadius="100%" barSize={18}>
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar dataKey="value" cornerRadius={9} fill="var(--color-chart-1)" background={{ fill: "var(--muted)" }} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-x-0 top-[58%] flex -translate-y-1/2 flex-col items-center">
        <span className="text-2xl font-semibold">{percent}%</span>
        <span className="text-xs text-muted-foreground">Taux d&apos;occupation</span>
      </div>
    </div>
  );
}

interface ReservationsByStatusChartProps {
  data: { status: string; broker: number; direct: number }[];
}

const RESERVATION_STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  CONFIRMED: "Confirmée",
  CONVERTED: "Convertie",
  CANCELLED: "Annulée",
};

export function ReservationsByStatusChart({ data }: ReservationsByStatusChartProps) {
  if (data.every((entry) => entry.broker === 0 && entry.direct === 0)) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Aucune réservation sur cette période.</p>;
  }

  const chartData = data.map((entry) => ({ ...entry, label: RESERVATION_STATUS_LABELS[entry.status] ?? entry.status }));

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
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="broker" name="Broker" stackId="source" fill="var(--color-chart-1)" radius={[0, 0, 0, 0]} maxBarSize={48} />
        <Bar dataKey="direct" name="Direct" stackId="source" fill="var(--color-chart-2)" radius={[4, 4, 0, 0]} maxBarSize={48} />
      </BarChart>
    </ResponsiveContainer>
  );
}
