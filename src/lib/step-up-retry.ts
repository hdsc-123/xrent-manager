"use client";

import { useCallback } from "react";
import { useStepUp } from "@/components/step-up/StepUpProvider";
import { ApiError } from "@/lib/api";

/**
 * Câblage UI du step-up MFA (2026-09-17) — seul point d'entrée prévu pour déclencher la modale
 * de re-preuve depuis un appel API existant. Ne remplace jamais un appel `apiPost`/`apiPatch`/
 * `apiDelete` : l'enveloppe simplement, une seule ligne modifiée par site d'appel.
 *
 * Dupliqué depuis STEP_UP_REQUIRED_CODE (src/lib/mfa-session.ts) : cette constante n'est PAS
 * réimportée depuis ce module serveur (il importe next/server et @/lib/prisma — l'importer
 * depuis un module client embarquerait Prisma dans le bundle navigateur). Seule la valeur
 * littérale est partagée entre les deux, comme pour d'autres frontières serveur/client déjà
 * établies dans ce dépôt (ex. scripts CommonJS dupliquant password-policy.ts).
 */
const STEP_UP_REQUIRED_CODE = "STEP_UP_REQUIRED";

/**
 * Garde stricte : un 403 ordinaire (permission refusée, tenant/agence non accessible, etc.) ne
 * doit jamais ouvrir la modale — seul un corps `{ code: "STEP_UP_REQUIRED" }` explicite le
 * déclenche. Le simple statut HTTP 403 n'est jamais un signal suffisant à lui seul.
 */
function isStepUpRequiredError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 403) {
    return false;
  }
  const body = error.body;
  return (
    typeof body === "object" &&
    body !== null &&
    "code" in body &&
    (body as { code?: unknown }).code === STEP_UP_REQUIRED_CODE
  );
}

/**
 * Hook retournant `withStepUpRetry` : exécute `action`, et si (et seulement si) le serveur
 * répond `STEP_UP_REQUIRED`, ouvre la modale de step-up puis rejoue `action` **une seule fois**
 * après une preuve fraîche. Toute autre erreur (y compris un second refus après la preuve,
 * normalement jamais atteint) remonte inchangée — aucune boucle, aucun deuxième essai. Si la
 * modale est annulée/fermée, `requestStepUp()` rejette et `action` n'est jamais rejouée.
 */
export function useStepUpRetry() {
  const { requestStepUp } = useStepUp();

  return useCallback(
    async function withStepUpRetry<T>(action: () => Promise<T>): Promise<T> {
      try {
        return await action();
      } catch (error) {
        if (!isStepUpRequiredError(error)) {
          throw error;
        }
        await requestStepUp();
        return action();
      }
    },
    [requestStepUp]
  );
}
