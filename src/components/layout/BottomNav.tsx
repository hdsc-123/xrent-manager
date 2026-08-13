"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarClock, Car, LayoutDashboard, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Navigation rapide mobile (Sprint 13E) — complète, sans la remplacer, la sidebar existante
 * (déjà accessible en mobile via le menu hamburger du Header) : un sous-ensemble des 18
 * entrées de navigation, limité aux 4 sections les plus fréquentes, pour un accès direct à
 * une main sur les écrans étroits sans ouvrir le tiroir latéral.
 */
const navItems = [
  { href: "/dashboard", label: "Accueil", icon: LayoutDashboard },
  { href: "/dashboard/vehicles", label: "Véhicules", icon: Car },
  { href: "/dashboard/reservations", label: "Réservations", icon: CalendarClock },
  { href: "/dashboard/settings", label: "Profil", icon: UserRound },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") {
    return pathname === "/dashboard";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Navigation rapide"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-100 bg-white/90 backdrop-blur-md pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="flex h-14 items-stretch justify-around">
        {navItems.map((item) => {
          const Icon = item.icon;
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
              <Icon className="size-5 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
