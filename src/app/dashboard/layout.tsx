import { redirect } from "next/navigation";
import { SessionProvider } from "next-auth/react";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { getTenantById } from "@/lib/db";
import { getPendingAlerts } from "@/lib/alerts";
import { maybeRunScheduledAlertChecks } from "@/lib/scheduled-tasks";
import { can, getEffectivePermissions } from "@/lib/permissions";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { StepUpProvider } from "@/components/step-up/StepUpProvider";

export default async function DashboardRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login");
  }

  // Sprint 22 : déclenchement best-effort des vérifications d'alertes planifiées — voir le
  // commentaire de maybeRunScheduledAlertChecks (src/lib/scheduled-tasks.ts). Attendu avant le
  // Promise.all ci-dessous pour que les alertes fraîchement créées apparaissent dès ce
  // chargement de page (throttlé, donc sans coût sur la majorité des requêtes).
  await maybeRunScheduledAlertChecks(user.tenantId);

  const [tenant, accessibleAgencyIds, pendingAlerts, effectivePermissions, canViewAlerts] = await Promise.all([
    getTenantById(user.tenantId),
    getAccessibleAgencyIds(user),
    getPendingAlerts(user.tenantId, user.id),
    getEffectivePermissions(user),
    can(user, "alerts.view"),
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

  // Sprint 18 : la cloche/badge d'alertes du Header (visible sur toutes les pages du dashboard)
  // n'était jusqu'ici gatée par aucune permission, contrairement à /dashboard/alerts elle-même
  // — un groupe sans alerts.view (ex. COMPTABILITÉ) voyait quand même un compte réel en
  // permanence, avec un lien menant à une page qui lui refuse l'accès.
  const visiblePendingAlertCount = canViewAlerts ? visiblePendingAlerts.length : 0;

  return (
    <SessionProvider>
      <StepUpProvider>
        <DashboardLayout
          tenantName={tenant?.name ?? ""}
          user={user}
          pendingAlertCount={visiblePendingAlertCount}
          permissions={permissions}
        >
          {children}
        </DashboardLayout>
      </StepUpProvider>
    </SessionProvider>
  );
}
