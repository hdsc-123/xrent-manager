import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getContractsOverview } from "@/lib/locations";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { ContractsOverviewTable, type ContractOverviewRow } from "./ContractsOverviewTable";

/**
 * Sprint 23 (DOMAINRULES.md section 39, point C de l'énoncé) — listing de tous les contrats
 * (Location), scopé aux agences accessibles à l'appelant (départ ou retour). Gardée par
 * `contracts_overview.view` (catalogue src/lib/permissions.ts), distincte de `reports.view`.
 */
export default async function ContractsPage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "contracts_overview.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Contrats</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter le listing des contrats.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const contracts = await getContractsOverview(user.tenantId, { agencyIds: accessibleAgencyIds });

  const rows: ContractOverviewRow[] = contracts.map((contract) => ({
    id: contract.id,
    contractNumber: contract.contractNumber,
    clientName: contract.clientName,
    source: contract.source,
    startDate: contract.startDate.toISOString(),
    endDate: contract.endDate.toISOString(),
    make: contract.make,
    licensePlate: contract.licensePlate,
    startOdometer: contract.startOdometer,
    endOdometer: contract.endOdometer,
    startFuelLevel: contract.startFuelLevel,
    endFuelLevel: contract.endFuelLevel,
    totalPrice: contract.totalPrice,
    currency: contract.currency,
    status: contract.status,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Contrats</h1>
        <p className="text-sm text-muted-foreground">
          Listing complet de tous les contrats — numéro, client, véhicule, kilométrage/carburant,
          total facturé et état.
        </p>
      </div>

      <ContractsOverviewTable contracts={rows} />
    </div>
  );
}
