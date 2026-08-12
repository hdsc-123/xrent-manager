import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { getUserById } from "@/lib/users";
import { PERMISSIONS, ensureDefaultGroups, getPermissionGroups, getUserPermissionsView } from "@/lib/permissions";
import { UserPermissionsForm } from "./UserPermissionsForm";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function UserPermissionsPage({ params }: PageProps) {
  const { id } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return null;

  if (sessionUser.role !== "ADMIN") {
    redirect("/dashboard");
  }

  const target = await getUserById(sessionUser.tenantId, id);
  if (!target) {
    notFound();
  }

  await ensureDefaultGroups(sessionUser.tenantId);
  const [groups, permissionsView] = await Promise.all([
    getPermissionGroups(sessionUser.tenantId),
    getUserPermissionsView(sessionUser.tenantId, id),
  ]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Permissions : {target.name}</h1>
        <p className="text-sm text-muted-foreground">{target.email}</p>
      </div>

      <UserPermissionsForm
        userId={target.id}
        isAdmin={target.role === "ADMIN"}
        groups={groups.map((group) => ({ id: group.id, name: group.name }))}
        initialGroupId={permissionsView?.permissionGroupId ?? null}
        initialIndividualPermissions={permissionsView?.individualPermissions ?? []}
        groupPermissions={permissionsView?.groupPermissions ?? []}
        permissions={PERMISSIONS}
      />
    </div>
  );
}
