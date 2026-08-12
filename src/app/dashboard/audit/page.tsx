import Link from "next/link";
import { getSessionUser } from "@/lib/authz";
import { getAuditLogs } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";

const ACTION_LABELS: Record<string, string> = {
  "user.role_changed": "Changement de rôle",
  "user.deleted": "Suppression d'utilisateur",
  "user.profile_updated": "Profil modifié",
  "invitation.created": "Invitation créée",
  "invitation.accepted": "Invitation acceptée",
  "invitation.declined": "Invitation déclinée",
  "invitation.revoked": "Invitation révoquée",
  "vehicle.created": "Véhicule créé",
  "vehicle.updated": "Véhicule modifié",
  "vehicle.deleted": "Véhicule supprimé",
  "location.created": "Location créée",
  "location.updated": "Location modifiée",
  "location.status_changed": "Statut de location modifié",
  "location.deleted": "Location supprimée",
  "client.created": "Client créé",
  "client.updated": "Client modifié",
  "client.deleted": "Client supprimé",
  "invoice.created": "Facture créée",
  "invoice.updated": "Facture modifiée",
  "invoice.status_changed": "Statut de facture modifié",
  "invoice.deleted": "Facture supprimée",
  "payment.created": "Paiement enregistré",
  "payment.updated": "Paiement modifié",
  "payment.deleted": "Paiement supprimé",
  "maintenance.created": "Maintenance planifiée",
  "maintenance.updated": "Maintenance modifiée",
  "maintenance.status_changed": "Statut de maintenance modifié",
  "maintenance.deleted": "Maintenance supprimée",
  "alert.acknowledged": "Alerte acquittée",
  "alert.resolved": "Alerte résolue",
};

const RESOURCE_LABELS: Record<string, string> = {
  User: "Utilisateur",
  Invitation: "Invitation",
  Vehicle: "Véhicule",
  Location: "Location",
  Client: "Client",
  Invoice: "Facture",
  Payment: "Paiement",
  Maintenance: "Maintenance",
  Alert: "Alerte",
};

interface PageProps {
  searchParams: Promise<{ resource?: string; action?: string; userId?: string }>;
}

export default async function AuditPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (user.role !== "ADMIN") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Journal d&apos;audit</CardTitle>
          <CardDescription>Cette section est réservée aux administrateurs du tenant.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const params = await searchParams;

  const [logs, distinctResources, distinctActions, tenantUsers] = await Promise.all([
    getAuditLogs(user.tenantId, {
      resource: params.resource,
      action: params.action,
      userId: params.userId,
      take: 100,
    }),
    prisma.auditLog.findMany({
      where: { tenantId: user.tenantId },
      select: { resource: true },
      distinct: ["resource"],
      orderBy: { resource: "asc" },
    }),
    prisma.auditLog.findMany({
      where: { tenantId: user.tenantId },
      select: { action: true },
      distinct: ["action"],
      orderBy: { action: "asc" },
    }),
    prisma.user.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const actorNameById = new Map(tenantUsers.map((actor) => [actor.id, actor.name]));
  const hasFilters = Boolean(params.resource || params.action || params.userId);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Journal d&apos;audit</h1>
        <p className="text-sm text-muted-foreground">
          Trace des actions de création, modification et suppression sur les ressources métier
          (véhicules, locations, clients, factures, paiements, maintenances, alertes) ainsi que
          des actions sensibles (rôles, suppressions d&apos;utilisateurs, invitations).
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3" method="get">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="resource" className="text-xs font-medium text-muted-foreground">
            Ressource
          </label>
          <select
            id="resource"
            name="resource"
            defaultValue={params.resource ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Toutes</option>
            {distinctResources.map(({ resource }) => (
              <option key={resource} value={resource}>
                {RESOURCE_LABELS[resource] ?? resource}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="action" className="text-xs font-medium text-muted-foreground">
            Action
          </label>
          <select
            id="action"
            name="action"
            defaultValue={params.action ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Toutes</option>
            {distinctActions.map(({ action }) => (
              <option key={action} value={action}>
                {ACTION_LABELS[action] ?? action}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="userId" className="text-xs font-medium text-muted-foreground">
            Utilisateur
          </label>
          <select
            id="userId"
            name="userId"
            defaultValue={params.userId ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Tous</option>
            {tenantUsers.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.name || actor.id}
              </option>
            ))}
          </select>
        </div>

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {hasFilters && (
          <Button render={<Link href="/dashboard/audit" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <Card>
        <CardContent className="p-0">
          {logs.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Aucune entrée pour l&apos;instant.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Action</th>
                    <th className="px-3 py-2 font-medium">Ressource</th>
                    <th className="px-3 py-2 font-medium">Acteur</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="border-t border-border">
                      <td className="px-3 py-2 whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString("fr-FR")}
                      </td>
                      <td className="px-3 py-2">{ACTION_LABELS[log.action] ?? log.action}</td>
                      <td className="px-3 py-2">
                        {RESOURCE_LABELS[log.resource] ?? log.resource}
                        {log.resourceId ? ` (${log.resourceId})` : ""}
                      </td>
                      <td className="px-3 py-2">
                        {log.userId ? (actorNameById.get(log.userId) ?? "Utilisateur supprimé") : "Système"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
