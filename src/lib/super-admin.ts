/**
 * Super Admin plateforme (2026-08-29) — révise une décision antérieure documentée à plusieurs
 * reprises (SECURITY.md section 24/25, DOMAINRULES.md, HANDOFF.md point 16) selon laquelle
 * « aucun rôle superadmin transverse n'existe ». Décision explicite du propriétaire du projet :
 * la création d'un tenant devient une opération de plateforme, réservée à un opérateur désigné
 * hors du modèle de rôle par tenant.
 *
 * Choix technique délibéré pour éviter toute migration de schéma et tout risque de régression
 * sur les ~40 vérifications existantes `role === "ADMIN"` (can(), canAccessAgency, etc.) :
 * aucune nouvelle valeur de rôle n'est introduite. Un Super Admin reste un `User` ordinaire
 * (`role: "ADMIN"`) d'un tenant qui lui est propre (contrainte de schéma : `User.tenantId` est
 * obligatoire) — voir scripts/bootstrap-superadmin.js pour la création de ce premier tenant/
 * compte, qui ne passe par aucune route HTTP publique. La capacité supplémentaire (créer
 * d'autres tenants) est accordée par une allowlist d'emails côté serveur, jamais par le rôle
 * seul — même famille de mécanisme que CRON_SECRET (secret d'exploitation hors du modèle de
 * données métier, jamais exposé au client).
 *
 * `SUPER_ADMIN_EMAILS` : liste séparée par des virgules. Une entrée commençant par "@" filtre
 * par domaine (ex. "@xrent-platform.internal" autorise toute adresse de ce domaine) ; toute
 * autre entrée est une correspondance exacte (insensible à la casse). Variable serveur
 * uniquement (jamais NEXT_PUBLIC_*).
 */
export function isSuperAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;

  const raw = process.env.SUPER_ADMIN_EMAILS;
  if (!raw) return false;

  const normalizedEmail = email.trim().toLowerCase();
  const entries = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return entries.some((entry) => {
    if (entry.startsWith("@")) {
      return normalizedEmail.endsWith(entry);
    }
    return normalizedEmail === entry;
  });
}
