import { getSessionUser } from "@/lib/authz";
import { getTenantById } from "@/lib/db";
import { getUserById } from "@/lib/users";
import { EditTenantForm } from "@/app/dashboard/tenants/[id]/EditTenantForm";
import { EditProfileForm } from "./EditProfileForm";
import { DataResetCard } from "./DataResetCard";

export default async function SettingsPage() {
  const user = await getSessionUser();
  if (!user) return null;

  const [tenant, currentUser] = await Promise.all([
    getTenantById(user.tenantId),
    getUserById(user.tenantId, user.id),
  ]);

  if (!currentUser) return null;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6">
      <h1 className="font-heading text-2xl font-semibold">Paramètres</h1>

      {tenant && user.role === "ADMIN" && (
        <EditTenantForm id={tenant.id} initialName={tenant.name} slug={tenant.slug} />
      )}

      <EditProfileForm
        initialName={currentUser.name ?? ""}
        initialEmail={currentUser.email}
        initialPhone={currentUser.phone ?? ""}
        initialAvatar={currentUser.avatar ?? ""}
      />

      {tenant && user.role === "ADMIN" && <DataResetCard tenantName={tenant.name} />}
    </div>
  );
}
