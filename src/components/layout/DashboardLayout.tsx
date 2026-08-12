"use client";

import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";

interface DashboardLayoutUser {
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

interface DashboardLayoutProps {
  tenantName: string;
  user: DashboardLayoutUser;
  pendingAlertCount?: number;
  children: React.ReactNode;
}

export function DashboardLayout({ tenantName, user, pendingAlertCount, children }: DashboardLayoutProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  return (
    <div className="flex min-h-screen">
      <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          tenantName={tenantName}
          user={user}
          onMenuClick={() => setIsSidebarOpen(true)}
          pendingAlertCount={pendingAlertCount}
        />
        <main className="flex-1 overflow-x-hidden p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
