"use client";

import { useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api";

interface Tenant {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

interface UseTenantResult {
  tenant: Tenant | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Récupère le tenant de l'ADMIN connecté côté client (GET /api/tenants, qui ne
 * retourne jamais que le tenant de l'utilisateur — voir src/app/api/tenants/route.ts).
 */
export function useTenant(): UseTenantResult {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    apiGet<{ tenants: Tenant[] }>("/api/tenants")
      .then((data) => {
        if (!cancelled) setTenant(data.tenants[0] ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Erreur inconnue.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { tenant, isLoading, error };
}
