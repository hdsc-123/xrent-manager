import { NextResponse } from "next/server";
import { getSessionUser, canAccessLocationAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getLocationById } from "@/lib/locations";
import { getLocationChain } from "@/lib/location-chains";

/**
 * Sprint technique 2 (DOMAINRULES.md section 60, règle 12) : chaîne contractuelle + soldes
 * (individuel par contrat + consolidé). Lecture seule — aucune écriture, aucun paramètre de
 * requête au-delà de `id`. Même garde exactement que GET /api/locations/[id] (route.ts, dossier
 * parent) : locations.view puis canAccessLocationAgency (tenant + agence de rattachement ou de
 * retour). Utilisée par la page Server Component (src/app/dashboard/locations/[id]/page.tsx,
 * qui appelle getLocationChain directement, sans passer par cette route, pour éviter un aller-
 * retour HTTP vers elle-même) : cette route existe pour la testabilité (assertions JSON exactes
 * sur des montants financiers, plus fiable qu'une lecture de texte formaté dans du HTML) et pour
 * un futur accès client-side éventuel, cohérente avec le reste de l'architecture où chaque
 * lecture non triviale expose une route GET dédiée.
 */

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!(await can(user, "locations.view"))) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const { id } = await params;
  const location = await getLocationById(user.tenantId, id);
  if (!location || !(await canAccessLocationAgency(user, location))) {
    return NextResponse.json({ error: "Location introuvable." }, { status: 404 });
  }

  const chain = await getLocationChain(user.tenantId, user, location);
  return NextResponse.json({ chain });
}
