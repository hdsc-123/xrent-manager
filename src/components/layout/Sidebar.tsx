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
  Map,
  Repeat,
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
  icon: React.ComponentType<{ className?: string; suppressHydrationWarning?: boolean }>;
  /** Clé de permission requise pour afficher l'entrée (voir src/lib/permissions.ts). Sprint 15 :
   * le retrofit de permissions granulaires côté serveur couvre désormais (quasiment) tous les
   * modules métier (DOMAINRULES.md section 22) — chaque entrée ci-dessous reflète la clé
   * `<module>.view` réellement vérifiée par la route/page cible. */
  permission?: string;
  /** true = n'afficher qu'aux ADMIN, reflète une vérification `role !== "ADMIN"` réelle côté
   * page/route cible — modules volontairement non convertis en permission granulaire ce sprint
   * (gestion des utilisateurs/invitations/permissions/audit, réservée ADMIN même sur son
   * propre compte, DOMAINRULES.md section 4). */
  adminOnly?: boolean;
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
  { href: "/dashboard/tenants", label: "Tenants", icon: Building2 },
  { href: "/dashboard/agencies", label: "Agences", icon: Store, permission: "agencies.view" },
  { href: "/dashboard/vehicles", label: "Véhicules", icon: Car, permission: "vehicles.view" },
  { href: "/dashboard/locations", label: "Locations", icon: CalendarRange, permission: "locations.view" },
  { href: "/dashboard/reservations", label: "Réservations", icon: CalendarClock, permission: "reservations.view" },
  { href: "/dashboard/clients", label: "Clients", icon: UserRound, permission: "clients.view" },
  { href: "/dashboard/vehicle-transfers", label: "Transferts", icon: Repeat, permission: "vehicle_transfers.view" },
  { href: "/dashboard/vehicle-trips", label: "Déplacements", icon: Map, permission: "vehicle_trips.view" },
  { href: "/dashboard/maintenances", label: "Maintenances", icon: Wrench, permission: "maintenances.view" },
  { href: "/dashboard/alerts", label: "Alertes", icon: Bell, permission: "alerts.view" },
  { href: "/dashboard/invoices", label: "Factures", icon: FileText, permission: "invoices.view" },
  { href: "/dashboard/payments", label: "Paiements", icon: CreditCard, permission: "payments.view" },
  { href: "/dashboard/cash-register", label: "Caisse", icon: Wallet, permission: "cash_register.view" },
  { href: "/dashboard/reports", label: "Rapports", icon: BarChart3, permission: "reports.view" },
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
            <Icon className="size-4 shrink-0" suppressHydrationWarning />
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
            <X className="size-4" suppressHydrationWarning />
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
