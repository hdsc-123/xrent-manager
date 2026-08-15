"use client";

/**
 * Sprint 19 (DOMAINRULES.md section 37) : jauge carburant au format métier (vide/1-4/2-4/3-4/
 * plein) plutôt qu'un champ numérique libre — utilisée par les transferts entre agences et les
 * bons de déplacement (VehicleTransfer/VehicleTrip.startFuelLevel/endFuelLevel). Le champ reste
 * un Int 0-100 en base (aucun changement de schéma, voir prisma/schema.prisma) : ce composant
 * ne fait que contraindre la saisie à 5 valeurs discrètes, mappées vers ces pourcentages.
 */
const FUEL_LEVEL_OPTIONS = [
  { value: "", label: "—" },
  { value: "0", label: "Vide" },
  { value: "25", label: "1/4" },
  { value: "50", label: "2/4" },
  { value: "75", label: "3/4" },
  { value: "100", label: "Plein" },
];

interface FuelLevelSelectProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
}

export function FuelLevelSelect({ id, value, onChange, required, disabled }: FuelLevelSelectProps) {
  return (
    <select
      id={id}
      required={required}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-md border border-input bg-transparent px-3 text-sm disabled:opacity-60"
    >
      {FUEL_LEVEL_OPTIONS.map((option) => (
        <option key={option.value} value={option.value} disabled={required && option.value === ""}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
