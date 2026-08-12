import Link from "next/link";
import { getSessionUser } from "@/lib/authz";
import { PERMISSIONS } from "@/lib/permissions";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";

export default async function PermissionsCatalogPage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (user.role !== "ADMIN") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Permissions</CardTitle>
          <CardDescription>Cette section est réservée aux administrateurs du tenant.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const categories = Array.from(new Set(PERMISSIONS.map((p) => p.category)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Permissions</h1>
          <p className="text-sm text-muted-foreground">
            Catalogue des permissions disponibles. Voir <Link href="/dashboard/permission-groups" className="underline">
              Groupes de permissions
            </Link>{" "}
            pour les assigner.
          </p>
        </div>
        <Button variant="outline" render={<Link href="/dashboard/permission-groups" />}>
          Groupes de permissions
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {categories.map((category) => (
          <Card key={category}>
            <CardHeader>
              <CardTitle className="text-base">{category}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {PERMISSIONS.filter((p) => p.category === category).map((permission) => (
                <Badge key={permission.key} variant="outline">
                  {permission.label}
                </Badge>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
