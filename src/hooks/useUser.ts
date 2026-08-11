"use client";

import { useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api";

interface SessionUser {
  id: string;
  tenantId: string;
  role: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}

interface UseUserResult {
  user: SessionUser | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Récupère le user de la session courante côté client (GET /api/auth/me).
 * À utiliser uniquement dans des Client Components qui en ont réellement besoin
 * (ex. menu utilisateur du Header) ; préférer `getSessionUser()` (src/lib/authz.ts)
 * dans les Server Components/route handlers.
 */
export function useUser(): UseUserResult {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    apiGet<{ user: SessionUser }>("/api/auth/me")
      .then((data) => {
        if (!cancelled) setUser(data.user);
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

  return { user, isLoading, error };
}
