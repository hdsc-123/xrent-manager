import Link from "next/link";
import type { LocationStatus } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getContractsOverview } from "@/lib/locations";
import { Button, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { ContractsOverviewTable, type ContractOverviewRow } from "./ContractsOverviewTable";

const STATUS_OPTIONS: { value: LocationStatus; label: string }[] = [
  { value: "PENDING", label: "En attente" },
  { value: "CONFIRMED", label: "Confirmée" },
  { value: "ACTIVE", label: "En cours" },
  { value: "COMPLETED", label: "Terminée" },
  { value: "CANCELLED", label: "Annulée" },
];

/** Longueur maximale acceptée pour la recherche par numéro de contrat — un numéro de contrat
 * réel ne dépasse jamais quelques dizaines de caractères (préfixe agence + compteur), cette
 * limite n'existe que pour rejeter proprement une valeur aberrante plutôt que de la transmettre
 * telle quelle à la requête Prisma. */
const MAX_CONTRACT_NUMBER_SEARCH_LENGTH = 50;

interface PageProps {
  searchParams: Promise<{ status?: string; contractNumber?: string }>;
}

/**
 * Sprint 23 (DOMAINRULES.md section 39, point C de l'énoncé) — listing de tous les contrats
 * (Location), scopé aux agences accessibles à l'appelant (départ ou retour). Gardée par
 * `contracts_overview.view` (catalogue src/lib/permissions.ts), distincte de `reports.view`.
 * Sprint 30 (point 6b, Sprint A) : filtre statut ajouté — `getContractsOverview` le supportait
 * déjà côté serveur, jamais exposé côté UI jusqu'ici.
 */
export default async function ContractsPage({ searchParams }: PageProps) {
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

  const params = await searchParams;
  const status = params.status && STATUS_OPTIONS.some((option) => option.value === params.status)
    ? (params.status as LocationStatus)
    : undefined;

  // Valeur vide/composée uniquement d'espaces ignorée proprement (jamais transmise à la
  // requête) ; valeur trop longue rejetée plutôt que tronquée silencieusement, pour ne jamais
  // laisser croire qu'une recherche a été appliquée alors qu'elle a été altérée.
  const rawContractNumber = params.contractNumber?.trim();
  const contractNumber =
    rawContractNumber && rawContractNumber.length <= MAX_CONTRACT_NUMBER_SEARCH_LENGTH ? rawContractNumber : undefined;
  const contractNumberTooLong = Boolean(
    rawContractNumber && rawContractNumber.length > MAX_CONTRACT_NUMBER_SEARCH_LENGTH
  );

  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const contracts = await getContractsOverview(user.tenantId, { agencyIds: accessibleAgencyIds, status, contractNumber });

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

      <form className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3" method="get">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="contractNumber" className="text-xs font-medium text-muted-foreground">
            N° de contrat
          </label>
          <input
            id="contractNumber"
            name="contractNumber"
            type="text"
            placeholder="ex. 00004 ou RAK-00004"
            defaultValue={params.contractNumber ?? ""}
            maxLength={MAX_CONTRACT_NUMBER_SEARCH_LENGTH}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm sm:w-56"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="status" className="text-xs font-medium text-muted-foreground">
            Statut
          </label>
          <select
            id="status"
            name="status"
            defaultValue={params.status ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Tous</option>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {(status || params.contractNumber) && (
          <Button render={<Link href="/dashboard/contracts" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      {contractNumberTooLong && (
        <p className="text-sm text-destructive">
          Recherche ignorée : {MAX_CONTRACT_NUMBER_SEARCH_LENGTH} caractères maximum.
        </p>
      )}

      <ContractsOverviewTable contracts={rows} />
    </div>
  );
}
