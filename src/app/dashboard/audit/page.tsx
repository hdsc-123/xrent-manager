import { getSessionUser } from "@/lib/authz";
import { getAuditLogs } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";

const ACTION_LABELS: Record<string, string> = {
  "user.role_changed": "Changement de rôle",
  "user.deleted": "Suppression d'utilisateur",
  "invitation.created": "Invitation créée",
  "invitation.accepted": "Invitation acceptée",
  "invitation.declined": "Invitation déclinée",
  "invitation.revoked": "Invitation révoquée",
};

export default async function AuditPage() {
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

  const logs = await getAuditLogs(user.tenantId, { take: 100 });
  const actorIds = [...new Set(logs.map((log) => log.userId).filter((id): id is string => Boolean(id)))];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const actorNameById = new Map(actors.map((actor) => [actor.id, actor.name]));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Journal d&apos;audit</h1>
        <p className="text-sm text-muted-foreground">
          Trace des actions sensibles (rôles, suppressions d&apos;utilisateurs, invitations) — périmètre
          limité, voir HANDOFF.md.
        </p>
      </div>

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
                        {log.resource}
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
