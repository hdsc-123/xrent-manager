import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getVehiclePerformanceReport } from "@/lib/reports";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { VehiclePerformanceTable } from "./VehiclePerformanceTable";

/**
 * Sprint 23 (DOMAINRULES.md section 39, point D de l'énoncé) — performance par véhicule,
 * toutes villes confondues pour un ADMIN, scopée aux agences accessibles sinon. Gardée par
 * `vehicle_performance.view` (catalogue src/lib/permissions.ts), distincte de `reports.view`.
 */
export default async function VehiclePerformancePage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "vehicle_performance.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Performance véhicules</CardTitle>
          <CardDescription>
            Vous n&apos;avez pas la permission de consulter la performance des véhicules.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const vehicles = await getVehiclePerformanceReport(user.tenantId, accessibleAgencyIds);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Performance véhicules</h1>
        <p className="text-sm text-muted-foreground">
          Tous les véhicules de la société, toutes villes confondues — CA réalisé, dépenses, jours loués et
          classement de rendement (marge nette).
        </p>
      </div>

      <VehiclePerformanceTable vehicles={vehicles} />
    </div>
  );
}
