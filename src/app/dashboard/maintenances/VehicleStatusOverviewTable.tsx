"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui";

export interface VehicleStatusRow {
  id: string;
  name: string;
  licensePlate: string;
  agencyName: string;
  status: string;
  /** Date de retour de la location ACTIVE en cours, s'il y en a une. */
  returnDate: string | null;
  /** Disponible = status AVAILABLE ET aucune location ACTIVE en cours (cohérence
   * véhicule/location, section 5 du sprint 14C — voir DOMAINRULES.md). */
  available: boolean;
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
 * Vue "état réel" des véhicules (Sprint 14C, section 3 de l'énoncé) : distincte de la liste
 * des Maintenance (ci-dessous sur la même page) — un véhicule loué reste visible ici pour
 * anticiper une maintenance à son retour. Filtres directement dans les en-têtes (pas de
 * formulaire GET séparé, filtrage client léger — cette table n'a pas besoin d'être partagée
 * par lien/URL comme les autres listes du dashboard).
 */
export function VehicleStatusOverviewTable({ vehicles }: { vehicles: VehicleStatusRow[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [availabilityFilter, setAvailabilityFilter] = useState("");

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
      return true;
    });
  }, [vehicles, search, statusFilter, availabilityFilter]);

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left">
            <th className="p-2 font-medium">
              <div className="flex flex-col gap-1">
                <span>Véhicule / Immatriculation</span>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Rechercher..."
                  className="h-7 rounded border border-input bg-background px-2 text-xs font-normal"
                />
              </div>
            </th>
            <th className="p-2 font-medium">Agence</th>
            <th className="p-2 font-medium">
              <div className="flex flex-col gap-1">
                <span>État</span>
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
            <th className="p-2 font-medium">Date de retour</th>
            <th className="p-2 font-medium">
              <div className="flex flex-col gap-1">
                <span>Disponibilité</span>
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
  );
}
