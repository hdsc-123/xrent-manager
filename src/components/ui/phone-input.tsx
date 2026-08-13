"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Input } from "./input";
import { cn } from "@/lib/utils";

export interface CountryDialCode {
  code: string;
  name: string;
  flag: string;
  dialCode: string;
}

/**
 * Liste professionnelle de pays (Sprint 13C) — Maroc en premier (marché principal),
 * puis ordre alphabétique par nom. `code` (ISO) sert de clé stable pour la préférence
 * mémorisée en localStorage ; `dialCode` reste la valeur utilisée pour la reconstruction
 * du numéro complet (voir splitPhone plus bas — un préfixe plus long doit toujours être
 * testé avant un préfixe plus court, ex. +33 avant +3, pour ne pas se tromper de pays sur
 * un numéro déjà enregistré).
 */
const COUNTRIES: CountryDialCode[] = [
  { code: "MA", name: "Maroc", flag: "🇲🇦", dialCode: "+212" },
  { code: "DE", name: "Allemagne", flag: "🇩🇪", dialCode: "+49" },
  { code: "SA", name: "Arabie Saoudite", flag: "🇸🇦", dialCode: "+966" },
  { code: "AU", name: "Australie", flag: "🇦🇺", dialCode: "+61" },
  { code: "BE", name: "Belgique", flag: "🇧🇪", dialCode: "+32" },
  { code: "BR", name: "Brésil", flag: "🇧🇷", dialCode: "+55" },
  { code: "CA", name: "Canada", flag: "🇨🇦", dialCode: "+1" },
  { code: "CN", name: "Chine", flag: "🇨🇳", dialCode: "+86" },
  { code: "AE", name: "Émirats Arabes Unis", flag: "🇦🇪", dialCode: "+971" },
  { code: "ES", name: "Espagne", flag: "🇪🇸", dialCode: "+34" },
  { code: "US", name: "États-Unis", flag: "🇺🇸", dialCode: "+1" },
  { code: "FR", name: "France", flag: "🇫🇷", dialCode: "+33" },
  { code: "IT", name: "Italie", flag: "🇮🇹", dialCode: "+39" },
  { code: "JP", name: "Japon", flag: "🇯🇵", dialCode: "+81" },
  { code: "NL", name: "Pays-Bas", flag: "🇳🇱", dialCode: "+31" },
  { code: "PT", name: "Portugal", flag: "🇵🇹", dialCode: "+351" },
  { code: "GB", name: "Royaume-Uni", flag: "🇬🇧", dialCode: "+44" },
  { code: "RU", name: "Russie", flag: "🇷🇺", dialCode: "+7" },
  { code: "CH", name: "Suisse", flag: "🇨🇭", dialCode: "+41" },
  { code: "TR", name: "Turquie", flag: "🇹🇷", dialCode: "+90" },
];

const DEFAULT_COUNTRY = COUNTRIES[0];
const STORAGE_KEY = "phoneInput_country";

// Préfixes les plus longs d'abord : +212 ne doit jamais matcher avant +21 (inexistant ici,
// mais +1 est un vrai sous-préfixe de tout numéro US/CA, donc l'ordre compte dès qu'un
// indicatif est un préfixe d'un autre).
const COUNTRIES_BY_DIAL_CODE_LENGTH = [...COUNTRIES].sort((a, b) => b.dialCode.length - a.dialCode.length);

function splitPhone(value: string, lastCountry: CountryDialCode): { country: CountryDialCode; number: string } {
  const match = COUNTRIES_BY_DIAL_CODE_LENGTH.find((c) => value.startsWith(c.dialCode));
  if (match) {
    return { country: match, number: value.slice(match.dialCode.length) };
  }
  return { country: lastCountry, number: value.replace(/^\+/, "") };
}

/**
 * Lecture du pays mémorisé en localStorage via useSyncExternalStore plutôt qu'un
 * useEffect + setState au montage : évite un flash de contenu (le composant affiche le
 * Maroc par défaut côté serveur, puis pourrait re-render immédiatement côté client si un
 * autre pays était mémorisé) et le mismatch d'hydratation React que cela provoquerait.
 * localStorage ne change jamais depuis l'extérieur du composant pendant sa vie (seul
 * selectCountry l'écrit, dans un gestionnaire d'événement), donc `subscribe` n'a rien à
 * observer.
 */
function subscribeNoop() {
  return () => {};
}

function getStoredCountryCode(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function getServerStoredCountryCode(): string {
  return "";
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
 *
 * Sprint 13C : liste de pays étendue (drapeaux + recherche), et le dernier pays
 * sélectionné par l'utilisateur est mémorisé en localStorage — sert de valeur par
 * défaut pour les champs téléphone vides (Maroc si jamais rien n'a encore été choisi).
 */
export function PhoneInput({ id, value, onChange, required, placeholder }: PhoneInputProps) {
  const storedCountryCode = useSyncExternalStore(
    subscribeNoop,
    getStoredCountryCode,
    getServerStoredCountryCode
  );
  const storedCountry = COUNTRIES.find((c) => c.code === storedCountryCode) ?? DEFAULT_COUNTRY;

  // Pays cliqué explicitement dans le menu tant que `value` est encore vide (donc sans
  // indicatif à en extraire) — sans cet état, choisir un pays avant de taper le numéro
  // n'aurait aucun effet visible (update() renvoie "" tant qu'aucun chiffre n'est saisi).
  const [manualCountry, setManualCountry] = useState<CountryDialCode | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const fallbackCountry = manualCountry ?? storedCountry;

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      searchInputRef.current?.focus();
    }
  }, [isOpen]);

  const { country, number } = splitPhone(value, fallbackCountry);

  const filteredCountries = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return COUNTRIES;
    return COUNTRIES.filter(
      (c) => c.name.toLowerCase().includes(query) || c.dialCode.includes(query)
    );
  }, [search]);

  function update(nextCountry: CountryDialCode, nextNumber: string) {
    const digits = nextNumber.replace(/[^0-9]/g, "");
    onChange(digits ? `${nextCountry.dialCode}${digits}` : "");
  }

  function selectCountry(nextCountry: CountryDialCode) {
    setManualCountry(nextCountry);
    try {
      window.localStorage.setItem(STORAGE_KEY, nextCountry.code);
    } catch {
      // localStorage indisponible — la préférence ne survivra simplement pas au rechargement.
    }
    update(nextCountry, number);
    setIsOpen(false);
    setSearch("");
  }

  return (
    <div className="flex gap-2">
      <div ref={containerRef} className="relative">
        <button
          type="button"
          aria-label="Choisir l'indicatif pays"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((open) => !open)}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span aria-hidden="true">{country.flag}</span>
          <span>{country.dialCode}</span>
        </button>

        {isOpen && (
          <div className="absolute top-full left-0 z-50 mt-1 w-64 rounded-md border border-border bg-popover shadow-md">
            <div className="border-b border-border p-1.5">
              <input
                ref={searchInputRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Rechercher un pays..."
                className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </div>
            <ul role="listbox" className="max-h-56 overflow-y-auto p-1">
              {filteredCountries.length === 0 ? (
                <li className="px-2 py-1.5 text-sm text-muted-foreground">Aucun pays trouvé.</li>
              ) : (
                filteredCountries.map((c) => (
                  <li key={c.code}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={c.code === country.code}
                      onClick={() => selectCountry(c)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                        c.code === country.code && "bg-accent text-accent-foreground"
                      )}
                    >
                      <span aria-hidden="true">{c.flag}</span>
                      <span className="flex-1">{c.name}</span>
                      <span className="text-muted-foreground">{c.dialCode}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
      </div>
      <Input
        id={id}
        inputMode="tel"
        required={required}
        placeholder={placeholder ?? "612345678"}
        value={number}
        onChange={(event) => update(country, event.target.value)}
      />
    </div>
  );
}
