import type { SessionUser } from "@/lib/authz";
import {
  canAccessAgency,
  canAccessLocationAgency,
  canAccessReservationAgencies,
  canEditReservationAgency,
} from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getAgencyById, getTenantById } from "@/lib/db";
import { getClientById } from "@/lib/clients";
import { getVehicleById } from "@/lib/vehicles";
import { getLocationById } from "@/lib/locations";
import { getInvoiceById } from "@/lib/invoices";
import { getDamageInvoiceWithDetails } from "@/lib/damage-invoices";
import { getReservationById } from "@/lib/reservations";
import { getPermissionGroupById } from "@/lib/permissions";
import { getUserById } from "@/lib/users";

/**
 * Correctif sprint soft 404 (2026-08-24, DOMAINRULES.md section 64, SECURITY.md section 35) —
 * registre centralisé et réutilisable de gardes de route pour `/dashboard/*`, exécuté depuis
 * `src/proxy.ts` (Node.js runtime, confirmé — voir le commentaire de proxy.ts) AVANT toute
 * frontière `Suspense` (`dashboard/loading.tsx` et les `loading.tsx` imbriqués), donc AVANT que
 * le streaming ne démarre — seul point où un vrai code HTTP peut encore être choisi.
 *
 * Principes non négociables de ce module :
 * - AUCUNE règle métier n'est réinventée ici : chaque `check` appelle exclusivement les mêmes
 *   fonctions déjà utilisées par la page/la route API correspondante (`getXById`, `can()`,
 *   `canAccessAgency`/`canAccessLocationAgency`/`canAccessReservationAgencies`). Une seule
 *   source de vérité par vérification — si l'une de ces fonctions évolue, ce module suit
 *   automatiquement, sans double maintenance.
 * - Ce module ne remplace JAMAIS la vérification déjà présente dans chaque page — il s'agit
 *   d'un filtre additionnel, seulement responsable du code HTTP renvoyé avant que le rendu ne
 *   commence. Chaque page conserve exactement son propre `can()`/`getXById`/`canAccessX` déjà
 *   en place (défense en profondeur : si ce registre était un jour désynchronisé du chemin
 *   réel d'une page, ou si `proxy` était mal configuré/contourné, la page resterait protégée).
 * - AUCUN état n'est stocké ici (pas de cache, pas de compteur) : chaque appel relit les
 *   données à jour.
 * - Ne transforme JAMAIS une erreur technique (panne DB, etc.) en résultat "block" — une
 *   exception levée par un `check` doit être laissée remonter à l'appelant (`proxy.ts`), qui la
 *   traite comme une erreur, jamais comme une ressource absente (voir proxy.ts).
 * - Les redirections de confort liées à un état métier (ex. réservation déjà convertie) ne
 *   sont volontairement PAS couvertes ici : ce ne sont pas des décisions d'autorisation, et
 *   reproduire `reservation.status` ici dupliquerait une règle métier changeante dans une
 *   couche où ce projet a choisi de ne jamais le faire — voir SECURITY.md section 35 pour le
 *   détail de cette distinction.
 */

export type RouteGuardOutcome =
  | { kind: "allow" }
  | { kind: "block" }
  | { kind: "redirect"; to: string };

interface RouteGuardDefinition {
  /** Ancré avec `^`/`$` — un seul groupe capturé au maximum (l'identifiant de ressource, s'il
   * y en a un). Les motifs voisins (`/new`, `/import`, sous-routes plus profondes) sont exclus
   * explicitement par lookahead négatif ou par construction (l'ancrage `$` empêche déjà tout
   * chevauchement avec une sous-route à segments supplémentaires). */
  pattern: RegExp;
  check: (user: SessionUser, id: string | undefined) => Promise<RouteGuardOutcome>;
}

const ALLOW: RouteGuardOutcome = { kind: "allow" };
const BLOCK: RouteGuardOutcome = { kind: "block" };
const DASHBOARD_REDIRECT: RouteGuardOutcome = { kind: "redirect", to: "/dashboard" };

/** Fabrique pour les pages de création/import (Groupe A) : une seule permission requise,
 * aucune ressource par identifiant. */
function permissionOnlyGuard(permission: string): RouteGuardDefinition["check"] {
  return async (user) => ((await can(user, permission)) ? ALLOW : BLOCK);
}

const ROUTE_GUARDS: RouteGuardDefinition[] = [
  // ---------------------------------------------------------------------------------------
  // Groupe A — pages de création/import : permission seule, aucune ressource adressée.
  // ---------------------------------------------------------------------------------------
  { pattern: /^\/dashboard\/agencies\/new$/, check: permissionOnlyGuard("agencies.create") },
  { pattern: /^\/dashboard\/clients\/new$/, check: permissionOnlyGuard("clients.create") },
  { pattern: /^\/dashboard\/invoices\/new$/, check: permissionOnlyGuard("invoices.create") },
  { pattern: /^\/dashboard\/locations\/new$/, check: permissionOnlyGuard("locations.create") },
  { pattern: /^\/dashboard\/maintenances\/new$/, check: permissionOnlyGuard("maintenances.create") },
  // Correctif sprint soft 404 : reservations/new/page.tsx n'avait jusqu'ici AUCUNE garde
  // serveur (Client Component pur) — écart avec les 8 autres pages "new"/"import" et avec
  // reservations/import (déjà corrigé Sprint 18 pour la même raison). Couvert ici en plus du
  // gate serveur désormais ajouté directement à la page (voir son commentaire).
  { pattern: /^\/dashboard\/reservations\/new$/, check: permissionOnlyGuard("reservations.create") },
  { pattern: /^\/dashboard\/reservations\/import$/, check: permissionOnlyGuard("reservations.import") },
  { pattern: /^\/dashboard\/vehicle-transfers\/new$/, check: permissionOnlyGuard("vehicle_transfers.create") },
  { pattern: /^\/dashboard\/vehicle-trips\/new$/, check: permissionOnlyGuard("vehicle_trips.create") },
  { pattern: /^\/dashboard\/vehicles\/new$/, check: permissionOnlyGuard("vehicles.create") },

  // ---------------------------------------------------------------------------------------
  // Groupe B — fiches détail par identifiant : permission + tenant + agence (si applicable).
  // ---------------------------------------------------------------------------------------
  {
    pattern: /^\/dashboard\/agencies\/(?!new$)([^/]+)$/,
    check: async (user, id) => {
      if (!(await can(user, "agencies.view"))) return BLOCK;
      if (!id) return BLOCK;
      const agency = await getAgencyById(user.tenantId, id);
      if (!agency || !(await canAccessAgency(user, agency.id))) return BLOCK;
      return ALLOW;
    },
  },
  {
    pattern: /^\/dashboard\/clients\/(?!new$)([^/]+)$/,
    check: async (user, id) => {
      if (!(await can(user, "clients.view"))) return BLOCK;
      if (!id) return BLOCK;
      const client = await getClientById(user.tenantId, id);
      if (!client) return BLOCK;
      return ALLOW;
    },
  },
  {
    pattern: /^\/dashboard\/damage-invoices\/([^/]+)$/,
    check: async (user, id) => {
      if (!(await can(user, "damage_invoices.view"))) return BLOCK;
      if (!id) return BLOCK;
      const invoice = await getDamageInvoiceWithDetails(user.tenantId, id);
      if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) return BLOCK;
      return ALLOW;
    },
  },
  {
    pattern: /^\/dashboard\/invoices\/(?!new$)([^/]+)$/,
    check: async (user, id) => {
      if (!(await can(user, "invoices.view"))) return BLOCK;
      if (!id) return BLOCK;
      const invoice = await getInvoiceById(user.tenantId, id);
      if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) return BLOCK;
      return ALLOW;
    },
  },
  {
    pattern: /^\/dashboard\/locations\/(?!new$)([^/]+)$/,
    check: async (user, id) => {
      if (!(await can(user, "locations.view"))) return BLOCK;
      if (!id) return BLOCK;
      const location = await getLocationById(user.tenantId, id);
      if (!location || !(await canAccessLocationAgency(user, location))) return BLOCK;
      return ALLOW;
    },
  },
  {
    pattern: /^\/dashboard\/locations\/([^/]+)\/return$/,
    check: async (user, id) => {
      if (!(await can(user, "locations.complete"))) return BLOCK;
      if (!id) return BLOCK;
      const location = await getLocationById(user.tenantId, id);
      if (!location || !(await canAccessLocationAgency(user, location))) return BLOCK;
      return ALLOW;
    },
  },
  {
    pattern: /^\/dashboard\/reservations\/(?!new$|import$)([^/]+)$/,
    check: async (user, id) => {
      if (!(await can(user, "reservations.view"))) return BLOCK;
      if (!id) return BLOCK;
      const reservation = await getReservationById(user.tenantId, id);
      if (!reservation || !(await canAccessReservationAgencies(user, reservation))) return BLOCK;
      return ALLOW;
    },
  },
  {
    pattern: /^\/dashboard\/reservations\/([^/]+)\/convert$/,
    check: async (user, id) => {
      if (!(await can(user, "reservations.convert"))) return BLOCK;
      if (!id) return BLOCK;
      const reservation = await getReservationById(user.tenantId, id);
      if (!reservation || !(await canAccessReservationAgencies(user, reservation))) return BLOCK;
      if (!(await canEditReservationAgency(user, reservation))) return BLOCK;
      return ALLOW;
    },
  },
  {
    pattern: /^\/dashboard\/reservations\/([^/]+)\/edit$/,
    check: async (user, id) => {
      if (!(await can(user, "reservations.edit"))) return BLOCK;
      if (!id) return BLOCK;
      const reservation = await getReservationById(user.tenantId, id);
      if (!reservation || !(await canAccessReservationAgencies(user, reservation))) return BLOCK;
      if (!(await canEditReservationAgency(user, reservation))) return BLOCK;
      return ALLOW;
    },
  },
  {
    pattern: /^\/dashboard\/vehicles\/(?!new$)([^/]+)$/,
    check: async (user, id) => {
      if (!(await can(user, "vehicles.view"))) return BLOCK;
      if (!id) return BLOCK;
      const vehicle = await getVehicleById(user.tenantId, id);
      if (!vehicle || !(await canAccessAgency(user, vehicle.agencyId))) return BLOCK;
      return ALLOW;
    },
  },

  // ---------------------------------------------------------------------------------------
  // Groupe C — pages réservées ADMIN (contrôle de rôle strict, SECURITY.md section 4 : jamais
  // converties en can(), même principe reconduit ici). Le résultat ("block" ou "redirect")
  // reproduit exactement le comportement déjà choisi par CHAQUE page pour ce cas précis
  // (jamais unifié entre elles — ce serait un changement de comportement hors périmètre).
  // ---------------------------------------------------------------------------------------
  {
    pattern: /^\/dashboard\/permission-groups\/([^/]+)$/,
    check: async (user, id) => {
      if (user.role !== "ADMIN") return DASHBOARD_REDIRECT;
      if (!id) return BLOCK;
      const group = await getPermissionGroupById(user.tenantId, id);
      if (!group) return BLOCK;
      return ALLOW;
    },
  },
  {
    pattern: /^\/dashboard\/tenants\/([^/]+)$/,
    check: async (user, id) => {
      if (!id || id !== user.tenantId) return BLOCK;
      const tenant = await getTenantById(user.tenantId);
      if (!tenant) return BLOCK;
      return ALLOW;
    },
  },
  {
    pattern: /^\/dashboard\/users\/([^/]+)$/,
    check: async (user, id) => {
      if (user.role !== "ADMIN") return BLOCK;
      if (!id) return BLOCK;
      const target = await getUserById(user.tenantId, id);
      if (!target) return BLOCK;
      return ALLOW;
    },
  },
  {
    pattern: /^\/dashboard\/users\/([^/]+)\/permissions$/,
    check: async (user, id) => {
      if (user.role !== "ADMIN") return DASHBOARD_REDIRECT;
      if (!id) return BLOCK;
      const target = await getUserById(user.tenantId, id);
      if (!target) return BLOCK;
      return ALLOW;
    },
  },
];

/**
 * Évalue les gardes centralisés pour un pathname sous `/dashboard/*`. Retourne `{kind:
 * "allow"}` si aucun motif ne correspond (route non couverte par ce registre — laissée
 * inchangée, aucune régression possible sur une route hors périmètre) ou si toutes les
 * vérifications passent. Ne capture jamais les exceptions : une erreur levée par un `check`
 * (panne DB, etc.) se propage à l'appelant, qui doit la traiter comme une erreur technique,
 * jamais comme "block" (voir proxy.ts).
 */
export async function evaluateDashboardRouteGuard(
  pathname: string,
  user: SessionUser
): Promise<RouteGuardOutcome> {
  for (const definition of ROUTE_GUARDS) {
    const match = pathname.match(definition.pattern);
    if (match) {
      return definition.check(user, match[1]);
    }
  }
  return ALLOW;
}

/**
 * Test synchrone, sans accès base — permet à `proxy.ts` de ne payer le coût d'une relecture de
 * session fraîche (`getSessionUser()`, une requête base) que pour les requêtes dont le chemin
 * correspond réellement à un motif du registre. Sans ce filtre préalable, `proxy` interrogerait
 * la base pour CHAQUE page `/dashboard/*` authentifiée, y compris les ~27 pages non couvertes
 * par ce registre (listes, caisse, rapports, alertes, audit...) — une charge supplémentaire
 * inutile sur le processus serveur/Prisma partagé de la suite de tests (voir INCIDENTS.md
 * INC-3) pour des requêtes que ce garde n'a de toute façon rien à décider.
 */
export function matchesDashboardRouteGuard(pathname: string): boolean {
  return ROUTE_GUARDS.some((definition) => definition.pattern.test(pathname));
}

/**
 * Corps HTML du 404 produit par `proxy.ts` pour un `{kind: "block"}` — construit directement
 * par `proxy` (jamais par un rendu React) : la seule façon documentée par Next.js d'obtenir un
 * vrai statut HTTP 404 avant que le streaming ne démarre (voir le commentaire de proxy.ts).
 * Options évaluées avant ce choix (voir SECURITY.md section 35 pour le détail complet) :
 * réécriture vers une page/route dédiée (écartée — dépend de la résolution interne non
 * documentée comme stable du routeur pour rester synchrone) ; page 404 existante (aucune
 * n'existe dans le projet). Une réponse HTTP construite directement, pattern officiellement
 * documenté (« Producing a response »), est la seule option entièrement sous contrôle et
 * vérifiable.
 *
 * Volontairement générique, IDENTIQUE quel que soit le motif de blocage (ressource inexistante,
 * autre tenant, autre agence, permission absente) — jamais de distinction, cohérent avec le
 * principe IDOR déjà en vigueur dans tout le projet (SECURITY.md section 7). Aucune donnée de
 * la requête (id, type de ressource au-delà de ce que l'URL elle-même révèle déjà à
 * l'utilisateur qui l'a tapée/cliquée, tenant, agence) n'est incluse dans le corps.
 *
 * Design : reprend telles quelles les valeurs oklch clair/sombre de `src/app/globals.css`
 * (`:root`/`.dark`) plutôt que d'y référencer la feuille de styles compilée (dont le nom de
 * fichier est haché à chaque build, donc non fiable depuis `proxy`) — bascule via
 * `prefers-color-scheme`, sans possibilité de suivre une préférence de thème manuelle stockée
 * côté client à ce stade de la réponse (limite assumée, page de secours rarement vue). Police :
 * pile système générique plutôt que la police auto-hébergée (même raison que la feuille de
 * styles). `lang="fr"` (langue de l'application), `<meta name="robots" content="noindex">`,
 * viewport responsive, lien de retour vers `/dashboard`.
 */
export function renderDashboardNotFoundHtml(): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page introuvable — XRent Manager</title>
<style>
  :root {
    --background: oklch(0.984 0.003 247.858);
    --foreground: oklch(0.208 0.042 265.755);
    --card: oklch(1 0 0);
    --card-foreground: oklch(0.208 0.042 265.755);
    --muted-foreground: oklch(0.554 0.046 257.417);
    --border: oklch(0.928 0.006 264.531);
    --primary: oklch(0.546 0.245 262.881);
    --primary-foreground: oklch(1 0 0);
    --radius: 0.625rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: oklch(0.21 0.034 264.665);
      --foreground: oklch(0.985 0.002 247.839);
      --card: oklch(0.278 0.033 256.848);
      --card-foreground: oklch(0.985 0.002 247.839);
      --muted-foreground: oklch(0.707 0.022 261.325);
      --border: oklch(1 0 0 / 10%);
      --primary: oklch(0.623 0.214 259.815);
      --primary-foreground: oklch(1 0 0);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: var(--background);
    color: var(--foreground);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main {
    width: 100%;
    max-width: 28rem;
    background: var(--card);
    color: var(--card-foreground);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 2rem;
    text-align: center;
  }
  h1 { margin: 0 0 0.5rem; font-size: 1.25rem; font-weight: 600; }
  p { margin: 0 0 1.5rem; color: var(--muted-foreground); font-size: 0.9rem; line-height: 1.5; }
  a {
    display: inline-block;
    padding: 0.5rem 1.25rem;
    border-radius: calc(var(--radius) * 0.8);
    background: var(--primary);
    color: var(--primary-foreground);
    text-decoration: none;
    font-size: 0.9rem;
    font-weight: 500;
  }
  a:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
</style>
</head>
<body>
<main>
  <h1>Page introuvable</h1>
  <p>Cette page n&rsquo;existe pas ou vous n&rsquo;y avez pas accès.</p>
  <a href="/dashboard">Retour au tableau de bord</a>
</main>
</body>
</html>
`;
}
