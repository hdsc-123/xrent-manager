/**
 * Garde anti-double-soumission synchrone (2026-09-17, brief explicite du propriétaire du
 * projet — corrige la réserve du même jour sur StepUpDialog.tsx). Un état React (`useState`)
 * ne convient pas ici : sa mise à jour est asynchrone/batchée, si bien que deux appels
 * synchrones à un même gestionnaire (ex. deux `element.click()` dans le même tick JS) peuvent
 * tous les deux lire l'ancienne valeur avant que le premier re-rendu n'applique la nouvelle.
 * Un objet mutable simple, lu/écrit de façon strictement synchrone, n'a pas ce problème.
 *
 * Sans état React : ne déclenche jamais de re-rendu. Toujours combiné, côté composant, à un
 * `useRef` pour lui donner une durée de vie stable entre rendus (voir StepUpDialog.tsx).
 */
export interface SingleFlightGuard {
  /** Tente d'entrer dans la section protégée. Retourne `true` une seule fois par cycle
   * entrée/`release()` — tout appel supplémentaire avant le `release()` correspondant retourne
   * `false` sans effet de bord. */
  tryEnter(): boolean;
  /** Libère la garde — un appel `tryEnter()` ultérieur pourra à nouveau réussir. Idempotent. */
  release(): void;
}

export function createSingleFlightGuard(): SingleFlightGuard {
  let inFlight = false;
  return {
    tryEnter() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    release() {
      inFlight = false;
    },
  };
}
