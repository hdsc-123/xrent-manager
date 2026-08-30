import type { LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Clé de permission requise pour afficher l'entrée (voir src/lib/permissions.ts). */
  permission?: string;
  /** true = n'afficher qu'aux ADMIN, reflète une vérification `role !== "ADMIN"` réelle côté
   * page/route cible (modules volontairement non convertis en permission granulaire). */
  adminOnly?: boolean;
}

/**
 * Logique de visibilité partagée entre Sidebar (desktop/tiroir) et BottomNav (navigation rapide
 * mobile) — une seule source de vérité pour ne jamais faire diverger les deux, voir HANDOFF.md
 * (correctif BottomNav non filtrée par permission).
 */
export function isNavItemVisible(
  item: Pick<NavItem, "permission" | "adminOnly">,
  { permissions, role }: { permissions: string[] | null; role?: string | null }
): boolean {
  if (item.adminOnly) {
    return role === "ADMIN";
  }
  return !item.permission || permissions === null || permissions.includes(item.permission);
}
