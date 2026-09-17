"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { StepUpDialog } from "./StepUpDialog";

/**
 * Câblage UI du step-up MFA (2026-09-17, brief explicite du propriétaire du projet) — jusqu'ici
 * la preuve de step-up (src/lib/mfa-session.ts) était implémentée et testée côté serveur mais
 * consommée par aucune interface (voir SECURITY.md section 44/45, HANDOFF.md). Ce provider
 * expose `requestStepUp()` : ouvre une modale de re-preuve TOTP, résout quand une preuve fraîche
 * a été obtenue, rejette (StepUpCancelledError) si l'utilisateur annule ou ferme la modale —
 * jamais de nouvelle tentative automatique dans ce cas (voir src/lib/step-up-retry.ts, seul
 * consommateur prévu de ce contexte).
 *
 * Le client ne crée jamais lui-même de preuve : ce composant ne fait qu'orchestrer l'ouverture
 * de la modale et la relance de l'action originale une fois — la vérification réelle du code
 * TOTP reste entièrement côté serveur (POST /api/mfa/step-up/verify, StepUpDialog.tsx).
 */

export class StepUpCancelledError extends Error {
  constructor() {
    super("Vérification MFA annulée.");
    this.name = "StepUpCancelledError";
  }
}

interface StepUpContextValue {
  requestStepUp: () => Promise<void>;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

export function StepUpProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const pendingRef = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);

  const requestStepUp = useCallback((): Promise<void> => {
    // Une seule vérification de step-up à la fois — évite d'empiler plusieurs modales si
    // plusieurs actions gardées étaient déclenchées coup sur coup.
    if (pendingRef.current) {
      return Promise.reject(new Error("Une vérification MFA est déjà en cours."));
    }

    setIsOpen(true);
    return new Promise((resolve, reject) => {
      pendingRef.current = { resolve, reject };
    });
  }, []);

  function handleVerified() {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setIsOpen(false);
    pending?.resolve();
  }

  function handleCancelled() {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setIsOpen(false);
    pending?.reject(new StepUpCancelledError());
  }

  return (
    <StepUpContext.Provider value={{ requestStepUp }}>
      {children}
      <StepUpDialog open={isOpen} onVerified={handleVerified} onCancelled={handleCancelled} />
    </StepUpContext.Provider>
  );
}

/** Réservé à src/lib/step-up-retry.ts — les pages/formulaires individuels ne devraient jamais
 * appeler requestStepUp() directement, toujours via useStepUpRetry(). */
export function useStepUp(): StepUpContextValue {
  const context = useContext(StepUpContext);
  if (!context) {
    throw new Error("useStepUp() doit être utilisé à l'intérieur de <StepUpProvider>.");
  }
  return context;
}
