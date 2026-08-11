import Link from "next/link";
import { Building2, Store, Users } from "lucide-react";
import { getSessionUser } from "@/lib/authz";
import { getTenantById } from "@/lib/db";
import { prisma } from "@/lib/prisma";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui";

export default async function DashboardPage() {
  const user = await getSessionUser();

  if (!user) {
    return null;
  }

  const [tenant, agencyCount, userCount] = await Promise.all([
    getTenantById(user.tenantId),
    prisma.agency.count({ where: { tenantId: user.tenantId } }),
    prisma.user.count({ where: { tenantId: user.tenantId } }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold">
          Bonjour {user.name || user.email}
        </h1>
        <p className="text-sm text-muted-foreground">
          {tenant?.name} · rôle {user.role === "ADMIN" ? "Administrateur" : "Membre"}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <Store className="size-4" /> Agences
            </CardDescription>
            <CardTitle className="text-3xl">{agencyCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <Users className="size-4" /> Utilisateurs
            </CardDescription>
            <CardTitle className="text-3xl">{userCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">
              <Building2 className="size-4" /> Tenant
            </CardDescription>
            <CardTitle className="truncate text-3xl">{tenant?.name ?? "—"}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Actions rapides</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button render={<Link href="/dashboard/agencies/new" />}>
            Créer une agence
          </Button>
          <Button variant="outline" render={<Link href="/dashboard/agencies" />}>
            Voir les agences
          </Button>
          <Button variant="outline" render={<Link href="/dashboard/users" />}>
            Voir les utilisateurs
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
