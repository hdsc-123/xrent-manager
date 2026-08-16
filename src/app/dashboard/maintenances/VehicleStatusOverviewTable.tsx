"use client";

import { useMemo, useState } from "react";
import { Badge, Checkbox } from "@/components/ui";

export interface VehicleStatusRow {
  id: string;
  name: string;
  licensePlate: string;
  /** Sprint 30 (point 6b, Sprint A du chantier filtres — voir DOMAINRULES.md) — nécessaire pour
   * le filtre Agence ci-dessous ; agencyName reste affiché tel quel (inchangé). */
  agencyId: string;
  agencyName: string;
  status: string;
  /** Date de retour de la location ACTIVE en cours, s'il y en a une. */
  returnDate: string | null;
  /** Disponible = status AVAILABLE ET aucune location ACTIVE en cours (cohérence
   * véhicule/location, section 5 du sprint 14C — voir DOMAINRULES.md). */
  available: boolean;
}

export interface VehicleStatusAgencyOption {
  id: string;
  name: string;
}

const STATUS_LABELS: Record<string, string> = {
  AVAILABLE: "Disponible",
  RENTED: "Loué",
  MAINTENANCE: "Maintenance",
  INACTIVE: "Inactif",
  TRANSFERRING: "En transfert",
  ON_TRIP: "En déplacement",
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  AVAILABLE: "default",
  RENTED: "secondary",
  MAINTENANCE: "outline",
  INACTIVE: "destructive",
  TRANSFERRING: "outline",
  ON_TRIP: "outline",
};

/**
 * Vue "état réel" des véhicules (Sprint 14C, section 3) : distincte de la liste des Maintenance
 * (ci-dessous sur la même page) — un véhicule loué reste visible ici pour anticiper une
 * maintenance à son retour. Filtres directement dans les en-têtes (pas de formulaire GET séparé,
 * filtrage client léger — cette table n'a pas besoin d'être partagée par lien/URL comme les
 * autres listes du dashboard).
 *
 * Sprint 30 (point 6b, Sprint A — DOMAINRULES.md) : filtres Agence et Date de retour ajoutés,
 * mêmes principes — `agencies` (liste des agences réellement accessibles à l'appelant, fournie
 * par le Server Component, jamais dérivée des seules lignes déjà chargées) et une plage
 * Date de retour (du/au) avec option explicite « Sans date de retour » pour les véhicules dont
 * `returnDate` est `null` (jamais inclus silencieusement par une plage de dates, ni exclus par
 * défaut quand aucun filtre de date n'est actif).
 */
export function VehicleStatusOverviewTable({
  vehicles,
  agencies,
}: {
  vehicles: VehicleStatusRow[];
  agencies: VehicleStatusAgencyOption[];
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [availabilityFilter, setAvailabilityFilter] = useState("");
  const [agencyFilter, setAgencyFilter] = useState("");
  const [returnDateFrom, setReturnDateFrom] = useState("");
  const [returnDateTo, setReturnDateTo] = useState("");
  const [noReturnDateOnly, setNoReturnDateOnly] = useState(false);

  const filtered = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    return vehicles.filter((vehicle) => {
      if (
        searchLower &&
        !vehicle.licensePlate.toLowerCase().includes(searchLower) &&
        !vehicle.name.toLowerCase().includes(searchLower)
      ) {
        return false;
      }
      if (statusFilter && vehicle.status !== statusFilter) {
        return false;
      }
      if (availabilityFilter === "available" && !vehicle.available) {
        return false;
      }
      if (availabilityFilter === "unavailable" && vehicle.available) {
        return false;
      }
      if (agencyFilter && vehicle.agencyId !== agencyFilter) {
        return false;
      }
      if (noReturnDateOnly) {
        if (vehicle.returnDate !== null) {
          return false;
        }
      } else if (returnDateFrom || returnDateTo) {
        // Une plage de dates active exclut par construction les véhicules sans date de retour
        // (returnDate === null) — seule l'option « Sans date de retour » ci-dessus les inclut.
        if (vehicle.returnDate === null) {
          return false;
        }
        const returnDay = vehicle.returnDate.slice(0, 10);
        if (returnDateFrom && returnDay < returnDateFrom) {
          return false;
        }
        if (returnDateTo && returnDay > returnDateTo) {
          return false;
        }
      }
      return true;
    });
  }, [vehicles, search, statusFilter, availabilityFilter, agencyFilter, returnDateFrom, returnDateTo, noReturnDateOnly]);

  const hasActiveFilters =
    search || statusFilter || availabilityFilter || agencyFilter || returnDateFrom || returnDateTo || noReturnDateOnly;

  function resetFilters() {
    setSearch("");
    setStatusFilter("");
    setAvailabilityFilter("");
    setAgencyFilter("");
    setReturnDateFrom("");
    setReturnDateTo("");
    setNoReturnDateOnly(false);
  }

  return (
    <div className="flex flex-col gap-2">
      {hasActiveFilters && (
        <button
          type="button"
          onClick={resetFilters}
          className="w-fit text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Réinitialiser les filtres
        </button>
      )}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              <th className="px-3 py-2 align-middle font-medium">
                <div className="flex flex-col gap-1">
                  <span className="whitespace-nowrap">Véhicule / Immatriculation</span>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Rechercher..."
                    className="h-7 rounded border border-input bg-background px-2 text-xs font-normal"
                  />
                </div>
              </th>
              <th className="px-3 py-2 align-middle font-medium">
                <div className="flex flex-col gap-1">
                  <span className="whitespace-nowrap">Agence</span>
                  <select
                    value={agencyFilter}
                    onChange={(e) => setAgencyFilter(e.target.value)}
                    className="h-7 rounded border border-input bg-background px-1 text-xs font-normal"
                  >
                    <option value="">Toutes</option>
                    {agencies.map((agency) => (
                      <option key={agency.id} value={agency.id}>
                        {agency.name}
                      </option>
                    ))}
                  </select>
                </div>
              </th>
              <th className="px-3 py-2 align-middle font-medium">
                <div className="flex flex-col gap-1">
                  <span className="whitespace-nowrap">État</span>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="h-7 rounded border border-input bg-background px-1 text-xs font-normal"
                  >
                    <option value="">Tous</option>
                    {Object.entries(STATUS_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              </th>
              <th className="px-3 py-2 align-middle font-medium">
                <div className="flex flex-col gap-1">
                  <span className="whitespace-nowrap">Date de retour</span>
                  <div className="flex flex-col gap-1">
                    <input
                      type="date"
                      value={returnDateFrom}
                      disabled={noReturnDateOnly}
                      onChange={(e) => setReturnDateFrom(e.target.value)}
                      className="h-7 rounded border border-input bg-background px-1 text-xs font-normal disabled:opacity-50"
                      aria-label="Date de retour — du"
                    />
                    <input
                      type="date"
                      value={returnDateTo}
                      disabled={noReturnDateOnly}
                      onChange={(e) => setReturnDateTo(e.target.value)}
                      className="h-7 rounded border border-input bg-background px-1 text-xs font-normal disabled:opacity-50"
                      aria-label="Date de retour — au"
                    />
                    <label className="flex items-center gap-1.5 text-xs font-normal whitespace-nowrap">
                      <Checkbox
                        checked={noReturnDateOnly}
                        onCheckedChange={(checked) => setNoReturnDateOnly(checked === true)}
                      />
                      Sans date de retour
                    </label>
                  </div>
                </div>
              </th>
              <th className="px-3 py-2 align-middle font-medium">
                <div className="flex flex-col gap-1">
                  <span className="whitespace-nowrap">Disponibilité</span>
                  <select
                    value={availabilityFilter}
                    onChange={(e) => setAvailabilityFilter(e.target.value)}
                    className="h-7 rounded border border-input bg-background px-1 text-xs font-normal"
                  >
                    <option value="">Toutes</option>
                    <option value="available">Disponible</option>
                    <option value="unavailable">Indisponible</option>
                  </select>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-muted-foreground">
                  Aucun véhicule ne correspond aux filtres.
                </td>
              </tr>
            )}
            {filtered.map((vehicle) => (
              <tr key={vehicle.id} className="border-b border-border last:border-0">
                <td className="p-2">
                  {vehicle.name} <span className="text-muted-foreground">({vehicle.licensePlate})</span>
                </td>
                <td className="p-2">{vehicle.agencyName}</td>
                <td className="p-2">
                  <Badge variant={STATUS_VARIANTS[vehicle.status] ?? "outline"}>
                    {STATUS_LABELS[vehicle.status] ?? vehicle.status}
                  </Badge>
                </td>
                <td className="p-2">
                  {vehicle.returnDate ? new Date(vehicle.returnDate).toLocaleDateString("fr-FR") : "—"}
                </td>
                <td className="p-2">
                  <Badge variant={vehicle.available ? "default" : "outline"}>
                    {vehicle.available ? "Disponible" : "Indisponible"}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
