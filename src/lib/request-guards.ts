import { NextResponse } from "next/server";

/**
 * Garde générique de taille de corps de requête JSON (revue OWASP Phase 6, 2026-08-31) —
 * réservé aux routes API **publiques** (pas de session, donc aucune garde de rôle/permission en
 * amont) qui parsent un corps JSON avant toute autre vérification bon marché (rate limiting,
 * authentification) : `POST /api/auth/login`, `POST /api/auth/mfa/verify`,
 * `POST /api/invitations/[id]/accept`. Sans ce garde, un corps disproportionné (plusieurs
 * dizaines/centaines de Mo) était intégralement bufferisé par `request.json()` avant même que le
 * verrou de connexion (`src/lib/login-throttle.ts`) n'ait la moindre chance de le rejeter —
 * consommation mémoire/CPU non bornée, atteignable sans authentification.
 *
 * Les routes authentifiées ne sont volontairement pas couvertes ici : elles exigent déjà une
 * session valide (`getSessionUser()`), ce qui borne déjà la surface d'abus à un compte compromis
 * ou malveillant — un risque différent, de moindre priorité pour cette revue. L'import Excel des
 * réservations (`POST /api/reservations/import`) a sa propre limite dédiée (20 Mo, vérifiée sur
 * `file.size` d'un `multipart/form-data` après authentification/permission, jamais sur ce garde
 * générique JSON) et n'est pas concerné.
 *
 * Repose sur l'en-tête `Content-Length` annoncé par le client — limite connue et documentée : un
 * client qui l'omet (`Transfer-Encoding: chunked`) ou ment délibérément dessus n'est pas détecté
 * ici (Next.js/Node bufferise de toute façon le corps avant que `request.json()` ne puisse être
 * appelé, quelle que soit la véracité de l'en-tête annoncé). Reste une protection réelle contre
 * l'immense majorité des clients HTTP réels (navigateurs, `fetch`, `curl`, tout outil
 * d'automatisation usuel), qui annoncent un `Content-Length` honnête — pas une garantie absolue
 * contre un attaquant contournant délibérément ce contrôle précis (voir SECURITY.md section 34
 * pour ce risque résiduel documenté).
 */
export function isRequestBodyTooLarge(request: Request, maxBytes: number): boolean {
  const contentLength = request.headers.get("content-length");
  if (!contentLength) {
    return false;
  }
  const size = Number(contentLength);
  return Number.isFinite(size) && size > maxBytes;
}

/** 1 Mo — largement suffisant pour tout corps JSON applicatif public de ce projet (email, mot
 * de passe, code TOTP, nom...), très au-dessus de toute valeur légitime observée. */
export const MAX_PUBLIC_JSON_BODY_BYTES = 1024 * 1024;

/**
 * 3 Mo — risque résiduel A (HANDOFF.md, Phase 6.2, 2026-09-01) : les routes API authentifiées
 * qui parsent un corps JSON (`request.json()`) n'avaient elles-mêmes aucune limite explicite —
 * seule la nécessité d'une session valide (`getSessionUser()`) bornait déjà la surface d'abus à
 * un compte compromis ou malveillant. Limite plus généreuse que `MAX_PUBLIC_JSON_BODY_BYTES` (un
 * champ `notes`/`description` métier peut légitimement être plus long qu'un email ou un mot de
 * passe — voir les limites dédiées de `Location.notes`/`Invoice.notes`/`Damage.description`,
 * `DOMAINRULES.md`), tout en restant très au-dessus de tout corps JSON applicatif réel de ce
 * projet. Ne concerne aucune route multipart/upload/webhook (chacune a sa propre limite dédiée,
 * ex. 20 Mo sur `file.size` pour l'import Excel des réservations, jamais sur ce garde générique
 * JSON) — voir SECURITY.md section 34.
 */
export const MAX_AUTHENTICATED_JSON_BODY_BYTES = 3 * 1024 * 1024;

export function requestBodyTooLargeResponse(maxBytes: number): NextResponse {
  return NextResponse.json(
    { error: `Corps de requête trop volumineux (maximum ${Math.floor(maxBytes / 1024)} Ko).` },
    { status: 413 }
  );
}
