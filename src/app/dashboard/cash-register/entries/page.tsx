import { getSessionUser } from "@/lib/authz";
import { getCashEntries } from "@/lib/cash-register";
import { EntriesTable, type EntryRow } from "./EntriesTable";
import { NewEntryForm } from "./NewEntryForm";

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function CashEntriesPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  const params = await searchParams;
  const entries = await getCashEntries(user.tenantId, {
    type: "ENTRY",
    from: params.from ? new Date(params.from) : undefined,
    to: params.to ? new Date(params.to) : undefined,
  });

  const rows: EntryRow[] = entries.map((entry) => ({
    id: entry.id,
    category: entry.category,
    amount: entry.amount,
    currency: entry.currency,
    description: entry.description,
    clientName: entry.clientName,
    paymentMethod: entry.paymentMethod,
    createdAt: entry.createdAt.toISOString(),
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Entrées de caisse</h1>
        <p className="text-sm text-muted-foreground">Versements, commissions et virements encaissés.</p>
      </div>

      <NewEntryForm />

      <EntriesTable entries={rows} />
    </div>
  );
}
