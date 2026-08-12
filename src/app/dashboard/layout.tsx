import { redirect } from "next/navigation";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { getTenantById } from "@/lib/db";
import { getPendingAlerts } from "@/lib/alerts";
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

  const [tenant, accessibleAgencyIds, pendingAlerts] = await Promise.all([
    getTenantById(user.tenantId),
    getAccessibleAgencyIds(user),
    getPendingAlerts(user.tenantId, user.id),
  ]);

  // Un MEMBER ne voit que les alertes diffusées à tout le tenant (agencyId null) ou
  // rattachées à une agence à laquelle il est rattaché — même principe que vehicles/locations.
  const visiblePendingAlerts =
    accessibleAgencyIds === null
      ? pendingAlerts
      : pendingAlerts.filter((alert) => alert.agencyId === null || accessibleAgencyIds.includes(alert.agencyId));

  return (
    <DashboardLayout tenantName={tenant?.name ?? ""} user={user} pendingAlertCount={visiblePendingAlerts.length}>
      {children}
    </DashboardLayout>
  );
}
