import { getSessionUser } from "@/lib/authz";
import { getTenantById } from "@/lib/db";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui";
import { EditTenantForm } from "@/app/dashboard/tenants/[id]/EditTenantForm";

export default async function SettingsPage() {
  const user = await getSessionUser();
  if (!user) return null;

  const tenant = await getTenantById(user.tenantId);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6">
      <h1 className="font-heading text-2xl font-semibold">Paramètres</h1>

      {tenant && user.role === "ADMIN" && (
        <EditTenantForm id={tenant.id} initialName={tenant.name} slug={tenant.slug} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Mon compte</CardTitle>
          <CardDescription>
            La modification du profil (nom, email, mot de passe) n&apos;est pas encore
            disponible — elle nécessite une décision de sécurité supplémentaire (voir
            HANDOFF.md, points À DÉCIDER).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Nom</span>
            <span className="font-medium">{user.name || "—"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Email</span>
            <span className="font-medium">{user.email}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Rôle</span>
            <Badge variant={user.role === "ADMIN" ? "default" : "secondary"}>
              {user.role === "ADMIN" ? "Administrateur" : "Membre"}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
