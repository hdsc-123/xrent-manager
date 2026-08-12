"use client";

import { Input } from "./input";

const COUNTRY_CODES = [
  { code: "+212", label: "Maroc (+212)" },
  { code: "+33", label: "France (+33)" },
  { code: "+34", label: "Espagne (+34)" },
  { code: "+1", label: "États-Unis / Canada (+1)" },
  { code: "+44", label: "Royaume-Uni (+44)" },
];

function splitPhone(value: string): { dialCode: string; number: string } {
  const match = COUNTRY_CODES.find((c) => value.startsWith(c.code));
  if (match) {
    return { dialCode: match.code, number: value.slice(match.code.length) };
  }
  return { dialCode: COUNTRY_CODES[0].code, number: value.replace(/^\+/, "") };
}

interface PhoneInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
}

/**
 * Composant téléphone avec indicatif pays, développé en interne (pas de dépendance
 * npm — CLAUDE.md déconseille d'ajouter une dépendance non strictement nécessaire,
 * voir HANDOFF.md Sprint 12A). La valeur exposée est une chaîne unique au format
 * "+212612345678" (indicatif + chiffres, sans espace).
 */
export function PhoneInput({ id, value, onChange, required, placeholder }: PhoneInputProps) {
  const { dialCode, number } = splitPhone(value);

  function update(nextDialCode: string, nextNumber: string) {
    const digits = nextNumber.replace(/[^0-9]/g, "");
    onChange(digits ? `${nextDialCode}${digits}` : "");
  }

  return (
    <div className="flex gap-2">
      <select
        aria-label="Indicatif pays"
        value={dialCode}
        onChange={(event) => update(event.target.value, number)}
        className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
      >
        {COUNTRY_CODES.map((country) => (
          <option key={country.code} value={country.code}>
            {country.label}
          </option>
        ))}
      </select>
      <Input
        id={id}
        inputMode="tel"
        required={required}
        placeholder={placeholder ?? "612345678"}
        value={number}
        onChange={(event) => update(dialCode, event.target.value)}
      />
    </div>
  );
}
