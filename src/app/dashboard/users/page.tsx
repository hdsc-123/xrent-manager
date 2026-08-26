import Link from "next/link";
import { UserPlus } from "lucide-react";
import { getSessionUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { Button, Card, CardDescription, CardHeader, CardTitle, Icon } from "@/components/ui";
import { UsersTable, type UserRow } from "./UsersTable";

export default async function UsersPage() {
  const user = await getSessionUser();
  if (!user) return null;

  // Correctif UX (sprint stabilisation) : cette page redirigeait silencieusement vers
  // /dashboard pour un non-ADMIN, contrairement au patron déjà utilisé par
  // /dashboard/permissions et /dashboard/audit (message explicite). La garde serveur réelle
  // (aucune donnée chargée en dessous) est inchangée — seul le rendu du refus change.
  if (user.role !== "ADMIN") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Utilisateurs</CardTitle>
          <CardDescription>Cette section est réservée aux administrateurs du tenant.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const users = await prisma.user.findMany({
    where: { tenantId: user.tenantId },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const rows: UserRow[] = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    createdAt: u.createdAt.toISOString(),
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Utilisateurs</h1>
          <p className="text-sm text-muted-foreground">
            Cliquez sur un utilisateur pour modifier son rôle ou le supprimer.
          </p>
        </div>
        <Button render={<Link href="/dashboard/invitations" />}>
          <Icon icon={UserPlus} className="size-4" />
          Inviter un utilisateur
        </Button>
      </div>

      <UsersTable users={rows} />
    </div>
  );
}
