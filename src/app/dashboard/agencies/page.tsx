import Link from "next/link";
import { Plus } from "lucide-react";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { Button, Card, CardDescription, CardHeader, CardTitle, Icon } from "@/components/ui";
import { AgenciesTable, type AgencyRow } from "./AgenciesTable";

export default async function AgenciesPage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "agencies.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Agences</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter les agences.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const agencies = await prisma.agency.findMany({
    where: { tenantId: user.tenantId },
    orderBy: { createdAt: "desc" },
  });

  const rows: AgencyRow[] = agencies.map((agency) => ({
    id: agency.id,
    name: agency.name,
    slug: agency.slug,
    city: agency.city,
    phone: agency.phone,
    createdAt: agency.createdAt.toISOString(),
  }));

  const canCreate = await can(user, "agencies.create");
  const canEdit = await can(user, "agencies.edit");
  const canDelete = await can(user, "agencies.delete");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Agences</h1>
          <p className="text-sm text-muted-foreground">
            Points de location de votre organisation.
          </p>
        </div>
        {canCreate && (
          <Button render={<Link href="/dashboard/agencies/new" />}>
            <Icon icon={Plus} className="size-4" />
            Créer une agence
          </Button>
        )}
      </div>

      <AgenciesTable agencies={rows} canEdit={canEdit} canDelete={canDelete} />
    </div>
  );
}
