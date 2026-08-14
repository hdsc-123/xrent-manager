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
      {group.name === "ADMIN" && (
        // Sprint 18 : ce groupe est créé "pour référence/affichage uniquement" (src/lib/
        // permissions.ts) — can() court-circuite sur role === "ADMIN" sans jamais le
        // consulter. Sans cet avertissement, un ADMIN pouvait modifier/décocher ses
        // permissions en croyant restreindre les comptes administrateurs, sans aucun effet
        // réel ni message l'indiquant (confusion produit confirmée en pilote terrain).
        <p className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          Ce groupe est affiché pour référence uniquement : un utilisateur au rôle Administrateur
          a toujours accès à tout, quelles que soient les permissions cochées ici. Pour restreindre
          un compte, changez son rôle en Membre puis assignez-lui un groupe personnalisé.
        </p>
      )}
      <EditPermissionGroupForm
        groupId={group.id}
        initialName={group.name}
        initialPermissions={group.permissions}
        permissions={PERMISSIONS}
      />
    </div>
  );
}
