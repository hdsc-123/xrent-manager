import { notFound } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/authz";
import { getUserById, getUserAgencyIds } from "@/lib/users";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui";
import { EditUserForm } from "./EditUserForm";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function UserDetailPage({ params }: PageProps) {
  const { id } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return null;

  if (sessionUser.role !== "ADMIN") {
    notFound();
  }

  const target = await getUserById(sessionUser.tenantId, id);
  if (!target) {
    notFound();
  }

  const [agencies, agencyIds, permissionGroup] = await Promise.all([
    prisma.agency.findMany({ where: { tenantId: sessionUser.tenantId }, orderBy: { name: "asc" } }),
    getUserAgencyIds(target.id),
    target.permissionGroupId
      ? prisma.permissionGroup.findUnique({ where: { id: target.permissionGroupId }, select: { name: true } })
      : null,
  ]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">{target.name}</h1>
          <p className="text-sm text-muted-foreground">{target.email}</p>
        </div>
        <Button variant="outline" render={<Link href={`/dashboard/users/${target.id}/permissions`} />}>
          Permissions
        </Button>
      </div>

      <EditUserForm
        id={target.id}
        initialRole={target.role}
        isSelf={target.id === sessionUser.id}
        agencies={agencies.map((agency) => ({ id: agency.id, name: agency.name }))}
        initialAgencyIds={agencyIds}
        permissionGroupName={permissionGroup?.name ?? null}
      />
    </div>
  );
}
