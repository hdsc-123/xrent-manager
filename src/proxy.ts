import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionUser } from "@/lib/authz";
import {
  evaluateDashboardRouteGuard,
  matchesDashboardRouteGuard,
  renderDashboardNotFoundHtml,
} from "@/lib/route-guards";

/**
 * `middleware.ts` est déprécié dans cette version de Next.js et renommé `proxy.ts`
 * (voir node_modules/next/dist/docs/.../file-conventions/proxy.md) — même comportement,
 * seul le nom change.
 *
 * Correctif sprint soft 404 (2026-08-24, DOMAINRULES.md section 64, SECURITY.md section 35) :
 * `proxy` s'exécute avant tout rendu de page (avant toute frontière `Suspense` introduite par
 * `dashboard/loading.tsx` et les `loading.tsx` imbriqués) — c'est le SEUL point où un vrai code
 * HTTP peut encore être choisi pour une ressource `/dashboard/*` refusée/absente, une fois le
 * streaming démarré le statut ne peut plus changer (voir le commentaire de
 * src/lib/route-guards.ts). `proxy` tourne en runtime **Node.js par défaut dans cette version**
 * (vérifié : `node_modules/next/dist/docs/.../proxy.md`, « Proxy defaults to using the Node.js
 * runtime » depuis v16.0.0) — contrairement aux anciennes versions (Edge), Prisma et les mêmes
 * fonctions déjà utilisées par chaque page (`getSessionUser`, `can`, `getXById`,
 * `canAccessAgency`/`canAccessLocationAgency`/`canAccessReservationAgencies`) sont donc
 * directement réutilisables ici, sans aucune règle métier réécrite (voir route-guards.ts).
 *
 * Vérification "optimiste" (`req.auth`, lecture du JWT côté cookie, pas de requête base de
 * données) conservée à l'identique pour la redirection de connexion existante. Le garde de
 * route centralisé ci-dessous, additionnel, relit `getSessionUser()` (rôle toujours à jour
 * depuis la base, même principe que chaque page) uniquement pour les requêtes déjà
 * authentifiées dont le chemin correspond à un motif du registre.
 *
 * `proxy` n'est JAMAIS la seule protection : chaque page et chaque route API conserve
 * exactement sa propre vérification (authentification, permission, tenant, agence) — voir
 * SECURITY.md section 35. Une erreur technique inattendue pendant l'évaluation du garde
 * (panne base de données, etc.) n'est jamais transformée en 404 : elle est journalisée et la
 * requête continue vers la page, qui gère l'erreur normalement (comportement inchangé).
 */
const protectedPrefixes = ["/dashboard", "/settings"];

export default auth(async (req) => {
  const pathname = req.nextUrl.pathname;
  const isProtectedRoute = protectedPrefixes.some((prefix) => pathname.startsWith(prefix));

  if (isProtectedRoute && !req.auth) {
    const loginUrl = new URL("/login", req.nextUrl);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Filtre synchrone, sans accès base, avant tout appel à getSessionUser() (voir le commentaire
  // de matchesDashboardRouteGuard, src/lib/route-guards.ts) — évite une requête base
  // supplémentaire sur chacune des pages `/dashboard/*` non couvertes par ce registre.
  if (isProtectedRoute && req.auth && matchesDashboardRouteGuard(pathname)) {
    try {
      const user = await getSessionUser();
      // req.auth truthy garantit normalement une session valide ; défensif seulement (ne
      // devrait pas se produire — si c'est le cas, on laisse la page elle-même gérer l'absence
      // de session, comportement déjà existant, jamais un faux 404).
      if (user) {
        const outcome = await evaluateDashboardRouteGuard(pathname, user);
        if (outcome.kind === "block") {
          return new NextResponse(renderDashboardNotFoundHtml(), {
            status: 404,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (outcome.kind === "redirect") {
          return NextResponse.redirect(new URL(outcome.to, req.nextUrl));
        }
      }
    } catch (error) {
      // Erreur technique (panne base de données, etc.) — jamais transformée en 404 : la page
      // continue de s'exécuter normalement et gère l'erreur comme aujourd'hui.
      console.error("Erreur du garde de route proxy :", error);
    }
  }
});

export const config = {
  matcher: ["/dashboard/:path*", "/settings/:path*"],
};
