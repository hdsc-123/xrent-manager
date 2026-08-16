import type { DamageInvoiceStatus } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getDamageInvoices } from "@/lib/damage-invoices";
import { prisma } from "@/lib/prisma";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { DamageInvoicesTable, type DamageInvoiceRow } from "./DamageInvoicesTable";

/**
 * Sprint 33 (DOMAINRULES.md section 48) — écran dédié aux factures de dégâts, distinct de
 * /dashboard/invoices (factures locatives) : deux types de documents financiers différents,
 * jamais mélangés dans leurs totaux/soldes (voir DamageInvoicesTable.tsx et le badge « Dégât »
 * ajouté à /dashboard/invoices pour la recherche transversale, sans dupliquer les calculs).
 */

const STATUS_OPTIONS: { value: DamageInvoiceStatus; label: string }[] = [
  { value: "DRAFT", label: "Brouillon" },
  { value: "SENT", label: "Envoyée" },
  { value: "PARTIALLY_PAID", label: "Partiellement payée" },
  { value: "PAID", label: "Payée" },
  { value: "CANCELLED", label: "Annulée" },
];

interface PageProps {
  searchParams: Promise<{ status?: string; from?: string; to?: string }>;
}

export default async function DamageInvoicesPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "damage_invoices.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Factures de dégâts</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter les factures de dégâts.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const params = await searchParams;
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const status =
    params.status && STATUS_OPTIONS.some((option) => option.value === params.status)
      ? (params.status as DamageInvoiceStatus)
      : undefined;

  const damageInvoices = await getDamageInvoices(user.tenantId, {
    agencyIds: accessibleAgencyIds,
    status,
    from: params.from ? new Date(params.from) : undefined,
    to: params.to ? new Date(params.to) : undefined,
  });

  const locations = await prisma.location.findMany({
    where: { id: { in: damageInvoices.map((invoice) => invoice.locationId) } },
    select: { id: true, contractNumber: true },
  });
  const contractNumberByLocationId = new Map(locations.map((location) => [location.id, location.contractNumber]));

  const clients = await prisma.client.findMany({
    where: { id: { in: damageInvoices.map((invoice) => invoice.clientId) } },
    select: { id: true, name: true },
  });
  const clientNameById = new Map(clients.map((client) => [client.id, client.name]));

  const rows: DamageInvoiceRow[] = damageInvoices.map((invoice) => ({
    id: invoice.id,
    number: invoice.number,
    contractNumber: contractNumberByLocationId.get(invoice.locationId) ?? null,
    clientName: clientNameById.get(invoice.clientId) ?? "—",
    status: invoice.status,
    issuedAt: invoice.issuedAt.toISOString(),
    totalAmount: invoice.totalAmount,
    amountPaid: invoice.amountPaid,
    currency: invoice.currency,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Factures de dégâts</h1>
        <p className="text-sm text-muted-foreground">
          Facturation séparée des dégâts constatés au retour d&apos;un contrat — jamais mêlée au solde locatif.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
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
        <button
          type="submit"
          className="h-9 rounded-md border border-input bg-transparent px-4 text-sm font-medium hover:bg-accent"
        >
          Filtrer
        </button>
      </form>

      <DamageInvoicesTable damageInvoices={rows} />
    </div>
  );
}
