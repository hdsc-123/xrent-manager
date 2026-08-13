"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Bell,
  Building2,
  Car,
  CalendarRange,
  CalendarClock,
  ClipboardList,
  CreditCard,
  Wallet,
  FileText,
  KeyRound,
  LayoutDashboard,
  Mail,
  Settings,
  Store,
  UserRound,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Clé de permission requise pour afficher l'entrée (voir src/lib/permissions.ts). Réservé
   * au(x) module(s) réellement gated par can() côté serveur (Sprint 14A, DOMAINRULES.md
   * section 22) — aujourd'hui seul Réservations. Pour tout autre module, le système de
   * permissions granulaires ne gate rien : la route/page cible ne vérifie que le rôle
   * (voir `adminOnly`) ou est ouverte à tout user du tenant. Utiliser `permission` sur un
   * module non réellement gated masquerait à tort l'onglet pour des groupes qui y ont en
   * réalité accès (bug corrigé ce sprint). */
  permission?: string;
  /** true = n'afficher qu'aux ADMIN, reflète une vérification `role !== "ADMIN"` réelle côté
   * page/route cible (vérifié Sprint 14A) — pas une permission granulaire. */
  adminOnly?: boolean;
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
  { href: "/dashboard/tenants", label: "Tenants", icon: Building2 },
  { href: "/dashboard/agencies", label: "Agences", icon: Store },
  { href: "/dashboard/vehicles", label: "Véhicules", icon: Car },
  { href: "/dashboard/locations", label: "Locations", icon: CalendarRange },
  { href: "/dashboard/reservations", label: "Réservations", icon: CalendarClock, permission: "reservations.view" },
  { href: "/dashboard/clients", label: "Clients", icon: UserRound },
  { href: "/dashboard/maintenances", label: "Maintenances", icon: Wrench },
  { href: "/dashboard/alerts", label: "Alertes", icon: Bell },
  { href: "/dashboard/invoices", label: "Factures", icon: FileText },
  { href: "/dashboard/payments", label: "Paiements", icon: CreditCard },
  { href: "/dashboard/cash-register", label: "Caisse", icon: Wallet },
  { href: "/dashboard/reports", label: "Rapports", icon: BarChart3, adminOnly: true },
  { href: "/dashboard/users", label: "Utilisateurs", icon: Users, adminOnly: true },
  { href: "/dashboard/invitations", label: "Invitations", icon: Mail, adminOnly: true },
  { href: "/dashboard/permission-groups", label: "Permissions", icon: KeyRound, adminOnly: true },
  { href: "/dashboard/audit", label: "Audit", icon: ClipboardList, adminOnly: true },
  { href: "/dashboard/settings", label: "Paramètres", icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") {
    return pathname === "/dashboard";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  /** Permissions effectives de l'user connecté ; null = ADMIN, aucune restriction. */
  permissions: string[] | null;
  /** Rôle de l'user connecté, pour les entrées `adminOnly` (voir NavItem). */
  role?: string | null;
}

export function Sidebar({ isOpen, onClose, permissions, role }: SidebarProps) {
  const pathname = usePathname();
  const visibleItems = navItems.filter((item) => {
    if (item.adminOnly) {
      return role === "ADMIN";
    }
    return !item.permission || permissions === null || permissions.includes(item.permission);
  });

  const nav = (
    <nav aria-label="Navigation principale" className="flex flex-1 flex-col gap-1 p-3">
      {visibleItems.map((item) => {
        const Icon = item.icon;
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onClose}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors max-md:min-h-12 max-md:py-3",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            )}
          >
            <Icon className="size-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-sidebar-border bg-sidebar transition-transform md:hidden",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
        aria-hidden={!isOpen}
      >
        <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-4">
          <span className="font-heading text-sm font-semibold">XRent Manager</span>
          <Button
            variant="ghost"
            size="icon"
            className="max-md:size-12"
            onClick={onClose}
            aria-label="Fermer le menu"
          >
            <X className="size-4" />
          </Button>
        </div>
        {nav}
      </aside>

      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <div className="flex h-14 items-center border-b border-sidebar-border px-4">
          <span className="font-heading text-sm font-semibold">XRent Manager</span>
        </div>
        {nav}
      </aside>
    </>
  );
}
