import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runScheduledAlertChecksForAllTenants } from "@/lib/alert-scheduler";

/**
 * Déclencheur de service pour le scheduler horaire d'alertes (Sprint 34 étape 2,
 * DOMAINRULES.md section 49) — distinct de POST /api/tasks/check-alerts (réservé ADMIN, un
 * seul tenant, session NextAuth) : cette route est appelée par un déclencheur externe (cron
 * système, Vercel Cron, tâche planifiée GitHub Actions, etc.), jamais par un navigateur —
 * l'hébergeur cible reste À DÉCIDER (HANDOFF.md section 8 point 6), donc aucune configuration
 * de cron spécifique à une plateforme n'est ajoutée ici (même principe que Docker
 * explicitement décliné faute de décision d'hébergement, voir HANDOFF.md Sprint 11) — seul cet
 * endpoint HTTP, invocable par n'importe quel déclencheur externe une fois l'hébergement
 * tranché, est du ressort de ce sprint.
 *
 * Authentification par secret partagé (`CRON_SECRET`, comparaison à temps constant) plutôt
 * que par une permission applicative ou une session : c'est précisément le "mécanisme
 * d'authentification de service dédié" identifié comme manquant depuis le Sprint 7
 * (HANDOFF.md section 8 point 29 — "un vrai cron périodique multi-tenant nécessiterait un
 * mécanisme d'authentification de service dédié, non conçu à ce stade"). Convention d'en-tête
 * (`Authorization: Bearer <secret>`) identique à celle utilisée nativement par Vercel Cron —
 * si cet hébergeur est un jour retenu, aucune adaptation de code n'est nécessaire ; tout autre
 * déclencheur externe peut envoyer le même en-tête manuellement.
 *
 * Échec fermé : si `CRON_SECRET` n'est pas configuré côté serveur, la route refuse
 * systématiquement (503) plutôt que d'autoriser tout appelant par défaut.
 */
function isAuthorized(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  const expected = Buffer.from(secret);
  const actual = Buffer.from(provided);
  // timingSafeEqual lève une exception si les tampons n'ont pas la même longueur — testé
  // explicitement avant l'appel plutôt que laissé se propager, sans quoi une longueur
  // différente serait elle-même une fuite d'information mesurable côté timing.
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Scheduler non configuré (CRON_SECRET absent)." }, { status: 503 });
  }

  if (!isAuthorized(request, secret)) {
    console.warn("[scheduled-alerts] Tentative d'appel non autorisée (secret absent ou invalide).");
    return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  }

  const summary = await runScheduledAlertChecksForAllTenants("CRON");
  return NextResponse.json(summary);
}
