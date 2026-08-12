import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { PERMISSIONS, ensureDefaultGroups, getPermissionGroups } from "@/lib/permissions";
import { PermissionGroupsPanel, type PermissionGroupRow } from "./PermissionGroupsPanel";

export default async function PermissionGroupsPage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (user.role !== "ADMIN") {
    redirect("/dashboard");
  }

  await ensureDefaultGroups(user.tenantId);
  const groups = await getPermissionGroups(user.tenantId);

  const rows: PermissionGroupRow[] = groups.map((group) => ({
    id: group.id,
    name: group.name,
    permissionCount: group.permissions.length,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Groupes de permissions</h1>
        <p className="text-sm text-muted-foreground">
          Un utilisateur hérite des permissions de son groupe, plus ses éventuelles permissions
          individuelles (voir la fiche utilisateur).
        </p>
      </div>

      <PermissionGroupsPanel groups={rows} permissions={PERMISSIONS} />
    </div>
  );
}
