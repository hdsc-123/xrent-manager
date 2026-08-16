import Link from "next/link";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getCashEntries } from "@/lib/cash-register";
import { prisma } from "@/lib/prisma";
import { Button, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { EntriesTable, type EntryRow } from "./EntriesTable";
import { NewEntryForm } from "./NewEntryForm";

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function CashEntriesPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "cash_register.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Entrées de caisse</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter la caisse.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const canCreateEntry = await can(user, "cash_register.create_entry");
  const canEdit = await can(user, "cash_register.edit");
  const canDelete = await can(user, "cash_register.delete");
  const params = await searchParams;
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const [entries, agencies] = await Promise.all([
    getCashEntries(user.tenantId, {
      type: "ENTRY",
      from: params.from ? new Date(params.from) : undefined,
      to: params.to ? new Date(params.to) : undefined,
      // Sprint 24 (correction) : un non-ADMIN ne doit voir que les écritures de son périmètre
      // d'agences accessibles (SECURITY.md section 2) — jusqu'ici tenant-wide pour tout
      // titulaire de cash_register.view.
      agencyIds: accessibleAgencyIds ?? undefined,
    }),
    prisma.agency.findMany({
      where: { tenantId: user.tenantId, ...(accessibleAgencyIds ? { id: { in: accessibleAgencyIds } } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const rows: EntryRow[] = entries.map((entry) => ({
    id: entry.id,
    category: entry.category,
    amount: entry.amount,
    currency: entry.currency,
    description: entry.description,
    contractNumber: entry.contractNumber,
    clientName: entry.clientName,
    paymentMethod: entry.paymentMethod,
    createdAt: entry.createdAt.toISOString(),
    contractId: entry.contractId,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Entrées de caisse</h1>
        <p className="text-sm text-muted-foreground">Versements, commissions et virements encaissés.</p>
      </div>

      {canCreateEntry && <NewEntryForm agencies={agencies} />}

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
          <Button render={<Link href="/dashboard/cash-register/entries" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <EntriesTable entries={rows} canEdit={canEdit} canDelete={canDelete} />
    </div>
  );
}
