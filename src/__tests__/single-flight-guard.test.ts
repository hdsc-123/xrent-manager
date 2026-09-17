import { describe, expect, it } from "vitest";
import { createSingleFlightGuard } from "@/lib/single-flight-guard";

/**
 * Non-régression (2026-09-17) — réserve constatée lors de la validation UI live du step-up MFA
 * du même jour : deux clics natifs synchrones sur "Confirmer" (StepUpDialog.tsx) déclenchaient
 * deux POST /api/mfa/step-up/verify, la garde précédente reposant sur un état React
 * (`isSubmitting`, mise à jour asynchrone/batchée) plutôt que sur une vérification strictement
 * synchrone. Corrigé par src/lib/single-flight-guard.ts, consommé via `useRef` dans
 * StepUpDialog.tsx.
 *
 * Le paradigme de test de ce dépôt n'utilise ni jsdom ni @testing-library/react (aucune des deux
 * n'est installée ; voir l'en-tête de src/__tests__/icon-hydration.test.tsx) et aucune nouvelle
 * dépendance n'a été ajoutée pour cette correction — un rendu DOM interactif réel avec
 * dispatch d'événements de clic n'est donc pas reproductible ici. Ce fichier teste directement
 * la garde synchrone réutilisable que StepUpDialog.tsx consomme telle quelle (même import, même
 * instance par montage) : toute régression de son comportement (ex. retour à un simple
 * booléen d'état React) ferait échouer ces tests. La confirmation interactive réelle (clic
 * navigateur, requêtes réseau observées) a été effectuée séparément via une validation
 * Playwright live sur xrent_test — voir le rapport de validation du 2026-09-17.
 */
describe("createSingleFlightGuard (src/lib/single-flight-guard.ts)", () => {
  it("deux tentatives d'entrée synchrones : une seule réussit", () => {
    const guard = createSingleFlightGuard();
    expect(guard.tryEnter()).toBe(true);
    expect(guard.tryEnter()).toBe(false);
    expect(guard.tryEnter()).toBe(false);
  });

  it("deux soumissions synchrones ne déclenchent qu'un seul appel réseau simulé (un seul parcours de résolution)", async () => {
    const guard = createSingleFlightGuard();
    let networkCallCount = 0;
    let resolveNetworkCall: (() => void) | undefined;

    async function submit(): Promise<"sent" | "blocked"> {
      if (!guard.tryEnter()) return "blocked";
      networkCallCount += 1;
      try {
        await new Promise<void>((resolve) => {
          resolveNetworkCall = resolve;
        });
        return "sent";
      } finally {
        guard.release();
      }
    }

    // Simule deux clics natifs dans le même tick JS (aucun `await` entre les deux appels) —
    // exactement le scénario reproduit en direct dans le navigateur (voir en-tête ci-dessus).
    const first = submit();
    const second = submit();

    expect(networkCallCount).toBe(1);
    expect(await second).toBe("blocked");
    resolveNetworkCall?.();
    expect(await first).toBe("sent");
  });

  it("après un échec (TOTP invalide ou erreur réseau récupérable), la garde est libérée et une nouvelle tentative légitime est acceptée", async () => {
    const guard = createSingleFlightGuard();

    async function submitRejecting(): Promise<void> {
      if (!guard.tryEnter()) throw new Error("ne devrait pas être bloqué ici");
      try {
        throw new Error("Code invalide.");
      } finally {
        guard.release();
      }
    }

    await expect(submitRejecting()).rejects.toThrow("Code invalide.");
    // Nouvelle tentative légitime après l'échec — doit réussir à entrer à nouveau.
    expect(guard.tryEnter()).toBe(true);
  });

  it("annulation/fermeture (release explicite) nettoie l'état : une tentative ultérieure réussit", () => {
    const guard = createSingleFlightGuard();
    expect(guard.tryEnter()).toBe(true);
    // Équivalent de StepUpDialog.handleOpenChange : release() sur fermeture/annulation.
    guard.release();
    expect(guard.tryEnter()).toBe(true);
  });

  it("un succès ne peut pas être suivi d'une seconde vérification tant que la garde n'a pas été libérée", async () => {
    const guard = createSingleFlightGuard();
    let networkCallCount = 0;

    async function submit(): Promise<void> {
      if (!guard.tryEnter()) return;
      networkCallCount += 1;
      // La libération n'intervient qu'après la résolution complète (voir `finally` de
      // StepUpDialog.handleSubmit) — une soumission concurrente pendant ce laps de temps doit
      // rester bloquée, succès ou non.
      await Promise.resolve();
      guard.release();
    }

    const first = submit();
    const second = submit(); // concurrente, avant que `first` ne libère la garde
    await Promise.all([first, second]);

    expect(networkCallCount).toBe(1);
  });
});
