import Link from "next/link";
import { Plus } from "lucide-react";
import { getSessionUser } from "@/lib/authz";
import { getClients } from "@/lib/clients";
import { Button } from "@/components/ui";
import { ClientsTable, type ClientRow } from "./ClientsTable";

interface PageProps {
  searchParams: Promise<{ search?: string }>;
}

export default async function ClientsPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  const params = await searchParams;
  const clients = await getClients(user.tenantId, params.search);

  const rows: ClientRow[] = clients.map((client) => ({
    id: client.id,
    name: client.name,
    email: client.email,
    phone: client.phone,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Clients</h1>
          <p className="text-sm text-muted-foreground">Locataires de votre organisation.</p>
        </div>
        <Button render={<Link href="/dashboard/clients/new" />}>
          <Plus className="size-4" />
          Créer un client
        </Button>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3" method="get">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="search" className="text-xs font-medium text-muted-foreground">
            Recherche (nom ou email)
          </label>
          <input
            id="search"
            name="search"
            defaultValue={params.search ?? ""}
            className="h-9 w-64 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {params.search && (
          <Button render={<Link href="/dashboard/clients" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <ClientsTable clients={rows} />
    </div>
  );
}
