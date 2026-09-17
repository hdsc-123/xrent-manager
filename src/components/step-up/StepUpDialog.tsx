"use client";

import { useRef, useState } from "react";
import { apiPost, ApiError } from "@/lib/api";
import { createSingleFlightGuard } from "@/lib/single-flight-guard";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@/components/ui";

/**
 * Câblage UI du step-up MFA (2026-09-17) — modale générique de re-preuve TOTP, montée une seule
 * fois par <StepUpProvider>. Jamais de code de récupération ici (POST /api/mfa/step-up/verify
 * ne les accepte de toute façon pas côté serveur, réservés à la connexion) — un seul champ TOTP.
 *
 * Le champ n'est jamais masqué (type="text"), même convention que l'écran MFA de connexion
 * (LoginForm.tsx) — un TOTP n'est pas traité comme un mot de passe. Le code n'est jamais
 * journalisé (aucun console.*, jamais inclus dans un message d'erreur) ni conservé au-delà de
 * l'état local de ce composant, effacé après succès ou fermeture.
 */

interface StepUpDialogProps {
  open: boolean;
  onVerified: () => void;
  onCancelled: () => void;
}

const GENERIC_INVALID_CODE_MESSAGE = "Code invalide.";

export function StepUpDialog({ open, onVerified, onCancelled }: StepUpDialogProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Garde synchrone (2026-09-17, corrige la réserve du même jour) : `isSubmitting` (useState)
  // reste utilisé pour l'affichage (bouton désactivé, libellé "Vérification..."), mais sa mise
  // à jour est asynchrone/batchée et ne suffit pas à empêcher deux appels quasi-simultanés à
  // handleSubmit (ex. deux clics natifs dans le même tick JS) d'envoyer chacun une requête —
  // voir src/lib/single-flight-guard.ts. `useRef` (jamais réinitialisé entre rendus, jamais lui-
  // même source de re-rendu) porte cette garde ; sa lecture/écriture est strictement synchrone.
  const submitGuardRef = useRef(createSingleFlightGuard());

  function reset() {
    setCode("");
    setError(null);
  }

  // Couvre à la fois le bouton Annuler et toute fermeture de la modale (Échap, clic hors
  // modale, croix) — dans tous les cas, aucune preuve n'est créée, l'action originale reste
  // abandonnée (jamais rejouée).
  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && !isSubmitting) {
      submitGuardRef.current.release();
      reset();
      onCancelled();
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    // Vérifiée et activée avant tout `await` (et avant même le premier `setState`) — une
    // deuxième invocation synchrone de handleSubmit, quel que soit l'état React déjà
    // programmé mais pas encore appliqué, est bloquée ici sans effet de bord.
    if (!submitGuardRef.current.tryEnter()) return;
    setError(null);
    setIsSubmitting(true);
    try {
      await apiPost("/api/mfa/step-up/verify", { code });
      reset();
      onVerified();
    } catch (err) {
      // Message générique déjà produit par le serveur, jamais réinterprété ni enrichi ici —
      // aucune distinction affichée entre code invalide, verrouillage, ou autre refus serveur.
      setError(err instanceof ApiError ? err.message : GENERIC_INVALID_CODE_MESSAGE);
    } finally {
      submitGuardRef.current.release();
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Vérification de sécurité requise</DialogTitle>
          <DialogDescription>
            Cette action nécessite une nouvelle confirmation par le code de votre application
            d&apos;authentification.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="stepUpCode" required>
              Code
            </Label>
            <Input
              id="stepUpCode"
              name="stepUpCode"
              type="text"
              autoComplete="one-time-code"
              required
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-invalid={Boolean(error)}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={() => handleOpenChange(false)}
            >
              Annuler
            </Button>
            <Button type="submit" disabled={isSubmitting || !code}>
              {isSubmitting ? "Vérification..." : "Confirmer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
