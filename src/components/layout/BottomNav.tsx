"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarClock, Car, LayoutDashboard, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui";
import { isNavItemVisible, type NavItem } from "./nav-visibility";

/**
 * Navigation rapide mobile (Sprint 13E) — complète, sans la remplacer, la sidebar existante
 * (déjà accessible en mobile via le menu hamburger du Header) : un sous-ensemble des 18
 * entrées de navigation, limité aux 4 sections les plus fréquentes, pour un accès direct à
 * une main sur les écrans étroits sans ouvrir le tiroir latéral.
 *
 * Correctif (HANDOFF.md) : ces 4 entrées reflètent désormais exactement les mêmes règles de
 * visibilité que Sidebar.tsx (même clé `permission`, même helper `isNavItemVisible`) — Accueil
 * et Profil restent non restreints (comme dans Sidebar), Véhicules/Réservations exigent
 * respectivement `vehicles.view`/`reservations.view`, déjà réellement vérifiées côté serveur.
 */
const navItems: NavItem[] = [
  { href: "/dashboard", label: "Accueil", icon: LayoutDashboard },
  { href: "/dashboard/vehicles", label: "Véhicules", icon: Car, permission: "vehicles.view" },
  { href: "/dashboard/reservations", label: "Réservations", icon: CalendarClock, permission: "reservations.view" },
  { href: "/dashboard/settings", label: "Profil", icon: UserRound },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") {
    return pathname === "/dashboard";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

interface BottomNavProps {
  /** Permissions effectives de l'user connecté ; null = ADMIN, aucune restriction. */
  permissions: string[] | null;
  /** Rôle de l'user connecté (aucune entrée `adminOnly` ici actuellement, gardé pour cohérence
   * avec Sidebar si une future entrée en avait besoin). */
  role?: string | null;
}

export function BottomNav({ permissions, role }: BottomNavProps) {
  const pathname = usePathname();
  const visibleItems = navItems.filter((item) => isNavItemVisible(item, { permissions, role }));

  return (
    <nav
      aria-label="Navigation rapide"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-100 bg-white/90 backdrop-blur-md pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <div className="flex h-14 items-stretch justify-around">
        {visibleItems.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors",
                active ? "text-blue-600" : "text-slate-400"
              )}
            >
              <Icon icon={item.icon} className="size-5 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
