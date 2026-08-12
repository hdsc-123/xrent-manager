import { redirect } from "next/navigation";
import { SessionProvider } from "next-auth/react";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { getTenantById } from "@/lib/db";
import { getPendingAlerts } from "@/lib/alerts";
import { getEffectivePermissions } from "@/lib/permissions";
import { DashboardLayout } from "@/components/layout/DashboardLayout";

export default async function DashboardRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login");
  }

  const [tenant, accessibleAgencyIds, pendingAlerts, effectivePermissions] = await Promise.all([
    getTenantById(user.tenantId),
    getAccessibleAgencyIds(user),
    getPendingAlerts(user.tenantId, user.id),
    getEffectivePermissions(user),
  ]);

  // null = ADMIN, aucune restriction (voir Sidebar.tsx) — getEffectivePermissions()
  // retourne déjà l'ensemble complet pour un ADMIN, mais le sentinel null évite de
  // dépendre de la liste PERMISSIONS étant tenue à jour côté client.
  const permissions = user.role === "ADMIN" ? null : Array.from(effectivePermissions);

  // Un MEMBER ne voit que les alertes diffusées à tout le tenant (agencyId null) ou
  // rattachées à une agence à laquelle il est rattaché — même principe que vehicles/locations.
  const visiblePendingAlerts =
    accessibleAgencyIds === null
      ? pendingAlerts
      : pendingAlerts.filter((alert) => alert.agencyId === null || accessibleAgencyIds.includes(alert.agencyId));

  return (
    <SessionProvider>
      <DashboardLayout
        tenantName={tenant?.name ?? ""}
        user={user}
        pendingAlertCount={visiblePendingAlerts.length}
        permissions={permissions}
      >
        {children}
      </DashboardLayout>
    </SessionProvider>
  );
}
