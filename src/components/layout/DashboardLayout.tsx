"use client";

import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { BottomNav } from "./BottomNav";

interface DashboardLayoutUser {
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

interface DashboardLayoutProps {
  tenantName: string;
  user: DashboardLayoutUser;
  pendingAlertCount?: number;
  /** Permissions effectives de l'user connecté ; null = ADMIN, aucune restriction. */
  permissions: string[] | null;
  children: React.ReactNode;
}

export function DashboardLayout({
  tenantName,
  user,
  pendingAlertCount,
  permissions,
  children,
}: DashboardLayoutProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  return (
    <div className="flex min-h-screen">
      <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} permissions={permissions} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          tenantName={tenantName}
          user={user}
          onMenuClick={() => setIsSidebarOpen(true)}
          pendingAlertCount={pendingAlertCount}
        />
        <main className="flex-1 overflow-x-hidden p-4 pb-20 sm:p-6 md:pb-6">{children}</main>
      </div>
      <BottomNav />
    </div>
  );
}
