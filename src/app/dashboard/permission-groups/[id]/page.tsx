import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { PERMISSIONS, getPermissionGroupById } from "@/lib/permissions";
import { EditPermissionGroupForm } from "./EditPermissionGroupForm";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function PermissionGroupDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  if (user.role !== "ADMIN") {
    redirect("/dashboard");
  }

  const group = await getPermissionGroupById(user.tenantId, id);
  if (!group) {
    notFound();
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold">Groupe : {group.name}</h1>
      <EditPermissionGroupForm
        groupId={group.id}
        initialName={group.name}
        initialPermissions={group.permissions}
        permissions={PERMISSIONS}
      />
    </div>
  );
}
