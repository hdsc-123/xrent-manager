import Link from "next/link";
import type { PaymentMethod } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { Button, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { PaymentsTable, type PaymentRow } from "./PaymentsTable";

const METHOD_OPTIONS: { value: PaymentMethod; label: string }[] = [
  { value: "CASH", label: "Espèces" },
  { value: "CARD", label: "Carte" },
  { value: "BANK_TRANSFER", label: "Virement" },
  { value: "CHECK", label: "Chèque" },
  { value: "OTHER", label: "Autre" },
];

interface PageProps {
  searchParams: Promise<{ method?: string; from?: string; to?: string }>;
}

export default async function PaymentsPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "payments.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Paiements</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter les paiements.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const params = await searchParams;
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);

  const payments = await prisma.payment.findMany({
    where: {
      tenantId: user.tenantId,
      ...(accessibleAgencyIds ? { invoice: { agencyId: { in: accessibleAgencyIds } } } : {}),
      ...(params.method ? { method: params.method as PaymentMethod } : {}),
      ...(params.from ? { paidAt: { gte: new Date(params.from) } } : {}),
      ...(params.to ? { paidAt: { lte: new Date(params.to) } } : {}),
    },
    include: {
      invoice: {
        select: { number: true, client: { select: { name: true } }, location: { select: { contractNumber: true } } },
      },
    },
    orderBy: { paidAt: "desc" },
  });

  const rows: PaymentRow[] = payments.map((payment) => ({
    id: payment.id,
    invoiceNumber: payment.invoice.number,
    contractNumber: payment.invoice.location.contractNumber,
    clientName: payment.invoice.client.name,
    method: payment.method,
    paidAt: payment.paidAt.toISOString(),
    amount: payment.amount,
    currency: payment.currency,
    reference: payment.reference,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Paiements</h1>
        <p className="text-sm text-muted-foreground">Paiements enregistrés manuellement contre vos factures.</p>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3" method="get">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="method" className="text-xs font-medium text-muted-foreground">
            Méthode
          </label>
          <select
            id="method"
            name="method"
            defaultValue={params.method ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Toutes</option>
            {METHOD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
            Du
          </label>
          <input
            id="from"
            type="date"
            name="from"
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
            type="date"
            name="to"
            defaultValue={params.to ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {(params.method || params.from || params.to) && (
          <Button render={<Link href="/dashboard/payments" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <PaymentsTable payments={rows} />
    </div>
  );
}
