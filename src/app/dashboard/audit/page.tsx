import Link from "next/link";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getAuditLogs } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { ExportCsvButton } from "../reports/ExportCsvButton";
import { ACTION_LABELS, RESOURCE_LABELS } from "./audit-labels";
import { AuditLogTable } from "./AuditLogTable";
import { AuditPurgeCard } from "./AuditPurgeCard";

interface PageProps {
  searchParams: Promise<{ resource?: string; action?: string; userId?: string; from?: string; to?: string }>;
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
  const from = params.from ? new Date(params.from) : undefined;
  const to = params.to ? new Date(params.to) : undefined;

  const [logs, distinctResources, distinctActions, tenantUsers] = await Promise.all([
    getAuditLogs(user.tenantId, {
      resource: params.resource,
      action: params.action,
      userId: params.userId,
      from,
      to,
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
  const hasFilters = Boolean(params.resource || params.action || params.userId || params.from || params.to);

  // Sprint 24-1 : suppression du journal d'audit — double garde (role === "ADMIN", déjà vérifié
  // plus haut, ET can(user, "audit.delete")), voir le commentaire sur la clé dans
  // src/lib/permissions.ts. Recalculée côté serveur uniquement — la vérification réelle vit dans
  // les routes /api/audit/[id], /api/audit/bulk-delete, /api/audit/purge ; ce booléen ne fait que
  // masquer l'UI en conséquence.
  const canDeleteAudit = await can(user, "audit.delete");

  const auditRows = logs.map((log) => ({
    id: log.id,
    createdAt: log.createdAt.toISOString(),
    action: log.action,
    resource: log.resource,
    resourceId: log.resourceId,
    actorLabel: log.userId ? (actorNameById.get(log.userId) ?? "Utilisateur supprimé") : "Système",
  }));

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

        <div className="flex flex-col gap-1.5">
          <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
            Du
          </label>
          <input
            id="from"
            type="date"
            name="from"
            defaultValue={params.from ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="to" className="text-xs font-medium text-muted-foreground">
            Au
          </label>
          <input
            id="to"
            type="date"
            name="to"
            defaultValue={params.to ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {hasFilters && (
          <Button render={<Link href="/dashboard/audit" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}

        <ExportCsvButton
          filename="audit.csv"
          rows={logs.map((log) => ({
            date: new Date(log.createdAt).toISOString(),
            action: ACTION_LABELS[log.action] ?? log.action,
            ressource: RESOURCE_LABELS[log.resource] ?? log.resource,
            ressourceId: log.resourceId ?? "",
            acteur: log.userId ? (actorNameById.get(log.userId) ?? "Utilisateur supprimé") : "Système",
          }))}
        />
      </form>

      <Card>
        <CardContent className="p-0">
          <AuditLogTable logs={auditRows} canDelete={canDeleteAudit} />
        </CardContent>
      </Card>

      {canDeleteAudit && <AuditPurgeCard />}
    </div>
  );
}
