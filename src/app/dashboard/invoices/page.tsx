import Link from "next/link";
import { Plus } from "lucide-react";
import type { InvoiceStatus } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { Button, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { InvoicesTable, type InvoiceRow } from "./InvoicesTable";

const STATUS_OPTIONS: { value: InvoiceStatus; label: string }[] = [
  { value: "DRAFT", label: "Brouillon" },
  { value: "SENT", label: "Envoyée" },
  { value: "PARTIALLY_PAID", label: "Partiellement payée" },
  { value: "PAID", label: "Payée" },
  { value: "CANCELLED", label: "Annulée" },
];

interface PageProps {
  searchParams: Promise<{ status?: string; from?: string; to?: string; showHistory?: string }>;
}

export default async function InvoicesPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "invoices.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Factures</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter les factures.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const params = await searchParams;
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  // Sprint 26E : masque par défaut les factures remplacées par une nouvelle version —
  // comportement propre à cet écran uniquement, jamais un changement du comportement par défaut
  // de GET /api/invoices/getInvoices (voir src/lib/invoices.ts, filtre excludeReplaced, jamais
  // appliqué sans opt-in explicite). Filtre sur la relation inverse `replacedBy` (aucune colonne
  // physique dupliquée — voir prisma/schema.prisma, Invoice.replacesInvoiceId).
  const showHistory = params.showHistory === "true";

  const invoices = await prisma.invoice.findMany({
    where: {
      tenantId: user.tenantId,
      ...(accessibleAgencyIds ? { agencyId: { in: accessibleAgencyIds } } : {}),
      ...(params.status ? { status: params.status as InvoiceStatus } : {}),
      ...(params.from ? { issuedAt: { gte: new Date(params.from) } } : {}),
      ...(params.to ? { issuedAt: { lte: new Date(params.to) } } : {}),
      ...(showHistory ? {} : { replacedBy: null }),
    },
    include: { client: { select: { name: true } }, location: { select: { contractNumber: true } } },
    orderBy: { issuedAt: "desc" },
  });

  const rows: InvoiceRow[] = invoices.map((invoice) => ({
    id: invoice.id,
    number: invoice.number,
    contractNumber: invoice.location.contractNumber,
    clientName: invoice.client.name,
    status: invoice.status,
    issuedAt: invoice.issuedAt.toISOString(),
    totalAmount: invoice.totalAmount,
    amountPaid: invoice.amountPaid,
    currency: invoice.currency,
    versionNumber: invoice.versionNumber,
  }));

  const canCreate = (accessibleAgencyIds === null || accessibleAgencyIds.length > 0) && (await can(user, "invoices.create"));

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

        <input type="hidden" name="showHistory" value={showHistory ? "true" : "false"} />

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {(params.status || params.from || params.to) && (
          <Button render={<Link href="/dashboard/invoices" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      {/* Sprint 26E : par défaut, seule la dernière version active de chaque facture
          versionnée est affichée — bascule explicite pour voir aussi les versions
          remplacées (CANCELLED, une autre facture pointe vers elle via replacesInvoiceId). */}
      <div>
        <Link
          href={{
            pathname: "/dashboard/invoices",
            query: { ...params, showHistory: showHistory ? "false" : "true" },
          }}
          className="text-sm text-primary hover:underline"
        >
          {showHistory ? "Masquer les versions remplacées" : "Afficher l'historique des versions"}
        </Link>
      </div>

      <InvoicesTable invoices={rows} />
    </div>
  );
}
