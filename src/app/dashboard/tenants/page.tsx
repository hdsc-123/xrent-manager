import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { getTenantById } from "@/lib/db";
import { TenantsTable, type TenantRow } from "./TenantsTable";

export default async function TenantsPage() {
  const user = await getSessionUser();
  if (!user) return null;

  // Gestion des tenants réservée ADMIN, même patron que /dashboard/users, /dashboard/
  // invitations et /dashboard/permission-groups (DOMAINRULES.md — modules strictement
  // réservés au rôle, voir aussi le commentaire sur PERMISSIONS dans src/lib/permissions.ts).
  // Correctif (validation manuelle 2026-08-25, finding F-1) : cette page n'avait jusqu'ici
  // aucune garde, contrairement à ses pages sœurs.
  if (user.role !== "ADMIN") {
    redirect("/dashboard");
  }

  const tenant = await getTenantById(user.tenantId);
  const tenants: TenantRow[] = tenant
    ? [
        {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          createdAt: tenant.createdAt.toISOString(),
        },
      ]
    : [];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Tenants</h1>
        <p className="text-sm text-muted-foreground">
          Un tenant n&apos;affiche jamais que sa propre organisation. La création d&apos;un
          tenant se fait exclusivement via l&apos;inscription (/register).
        </p>
      </div>

      <TenantsTable tenants={tenants} />
    </div>
  );
}
