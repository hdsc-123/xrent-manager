/**
 * Audit de sécurité (2026-09-06) — `LoginForm.tsx` passait `callbackUrl` (paramètre de requête
 * non fiable, lu depuis `window.location.search`) tel quel à `router.push()`. Next.js effectue
 * une navigation navigateur complète (`completeHardNavigation`,
 * node_modules/next/dist/client/components/segment-cache/navigation.js) dès que l'origine de la
 * cible diffère de celle de l'app — un lien `/login?callbackUrl=https://site-pirate.tld`
 * redirigeait donc silencieusement, juste après une connexion réussie, vers un domaine externe
 * arbitraire (redirection ouverte, hameçonnage post-connexion).
 *
 * N'accepte qu'un chemin interne relatif :
 * - commence par exactement un `/` (jamais `//`, que le parseur d'URL du navigateur traite
 *   comme protocol-relative — donc une origine externe sous le schéma courant) ;
 * - ne contient aucun backslash (`\`) — certains parseurs d'URL normalisent `\` en `/`, si bien
 *   que `/\evil.example` peut être résolu comme `//evil.example` malgré son apparence de simple
 *   chemin relatif ;
 * - ne contient aucun caractère de contrôle ASCII (tabulation/retour à la ligne compris) — le
 *   parseur d'URL WHATWG les supprime avant analyse, donc `/\t/evil.example` peut se réduire à
 *   `//evil.example` après cette suppression, contournant une vérification textuelle naïve
 *   effectuée avant cette étape ;
 * - ne contient jamais la sous-chaîne `://` — élimine toute URL absolue et tout schéma
 *   (`http:`, `https:`, `javascript:`, `data:`, ...), même hors du tout début de la chaîne.
 *
 * Toute autre valeur (absente, vide, absolue, protocol-relative, `javascript:`/`data:`,
 * backslashée, ou autrement ambiguë) retombe sur `fallback` (`/dashboard` par défaut) — ne lève
 * jamais d'exception.
 */
export function sanitizeInternalRedirect(
  rawCallbackUrl: string | null | undefined,
  fallback = "/dashboard"
): string {
  if (typeof rawCallbackUrl !== "string" || rawCallbackUrl.length === 0) {
    return fallback;
  }

  if (/[\x00-\x1f\x7f]/.test(rawCallbackUrl)) {
    return fallback;
  }

  if (rawCallbackUrl.includes("\\")) {
    return fallback;
  }

  if (rawCallbackUrl.includes("://")) {
    return fallback;
  }

  if (!rawCallbackUrl.startsWith("/") || rawCallbackUrl.startsWith("//")) {
    return fallback;
  }

  return rawCallbackUrl;
}
