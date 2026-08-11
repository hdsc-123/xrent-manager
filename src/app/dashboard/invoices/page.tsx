import Link from "next/link";
import { Plus } from "lucide-react";
import type { InvoiceStatus } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui";
import { InvoicesTable, type InvoiceRow } from "./InvoicesTable";

const STATUS_OPTIONS: { value: InvoiceStatus; label: string }[] = [
  { value: "DRAFT", label: "Brouillon" },
  { value: "SENT", label: "Envoyée" },
  { value: "PARTIALLY_PAID", label: "Partiellement payée" },
  { value: "PAID", label: "Payée" },
  { value: "CANCELLED", label: "Annulée" },
];

interface PageProps {
  searchParams: Promise<{ status?: string; from?: string; to?: string }>;
}

export default async function InvoicesPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  const params = await searchParams;
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId: user.tenantId,
      ...(accessibleAgencyIds ? { agencyId: { in: accessibleAgencyIds } } : {}),
      ...(params.status ? { status: params.status as InvoiceStatus } : {}),
      ...(params.from ? { issuedAt: { gte: new Date(params.from) } } : {}),
      ...(params.to ? { issuedAt: { lte: new Date(params.to) } } : {}),
    },
    include: { client: { select: { name: true } } },
    orderBy: { issuedAt: "desc" },
  });

  const rows: InvoiceRow[] = invoices.map((invoice) => ({
    id: invoice.id,
    number: invoice.number,
    clientName: invoice.client.name,
    status: invoice.status,
    issuedAt: invoice.issuedAt.toISOString(),
    totalAmount: invoice.totalAmount,
    amountPaid: invoice.amountPaid,
    currency: invoice.currency,
  }));

  const canCreate = accessibleAgencyIds === null || accessibleAgencyIds.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Factures</h1>
          <p className="text-sm text-muted-foreground">Factures émises pour vos locations.</p>
        </div>
        {canCreate && (
          <Button render={<Link href="/dashboard/invoices/new" />}>
            <Plus className="size-4" />
            Créer une facture
          </Button>
        )}
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3" method="get">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="status" className="text-xs font-medium text-muted-foreground">
            Statut
          </label>
          <select
            id="status"
            name="status"
            defaultValue={params.status ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Tous</option>
            {STATUS_OPTIONS.map((option) => (
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
        {(params.status || params.from || params.to) && (
          <Button render={<Link href="/dashboard/invoices" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <InvoicesTable invoices={rows} />
    </div>
  );
}
