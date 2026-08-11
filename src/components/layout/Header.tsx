"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { LogOut, Menu, Settings } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui";

interface HeaderUser {
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

interface HeaderProps {
  tenantName: string;
  user: HeaderUser;
  onMenuClick: () => void;
}

function initials(name?: string | null, email?: string | null): string {
  const source = name?.trim() || email?.trim() || "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

export function Header({ tenantName, user, onMenuClick }: HeaderProps) {
  const router = useRouter();

  async function handleSignOut() {
    await signOut({ redirect: false });
    router.push("/login");
  }

  return (
    <header className="flex h-14 items-center gap-3 border-b border-border bg-background px-4">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onMenuClick}
        aria-label="Ouvrir le menu"
      >
        <Menu className="size-4" />
      </Button>

      <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">
        {tenantName}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" className="h-8 gap-2 px-1.5" />}
        >
          <Avatar className="size-6">
            <AvatarFallback className="text-xs">
              {initials(user.name, user.email)}
            </AvatarFallback>
          </Avatar>
          <span className="hidden max-w-32 truncate text-sm sm:inline">
            {user.name || user.email}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-foreground">
              {user.name || "Utilisateur"}
            </span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {user.email}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<Link href="/dashboard/settings" />}>
            <Settings className="size-4" />
            Paramètres
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={handleSignOut}>
            <LogOut className="size-4" />
            Se déconnecter
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
