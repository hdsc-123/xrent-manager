"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiDelete, apiPost, ApiError } from "@/lib/api";
import { useStepUpRetry } from "@/lib/step-up-retry";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Icon,
} from "@/components/ui";
import { ACTION_LABELS, RESOURCE_LABELS, getActionStyle } from "./audit-labels";

export interface AuditLogRow {
  id: string;
  createdAt: string;
  action: string;
  resource: string;
  resourceId: string | null;
  actorLabel: string;
}

/**
 * Sprint 24-1 : sélection + suppression unitaire/en masse du journal d'audit — brief explicite
 * du propriétaire du projet. `canDelete` (role === "ADMIN" ET can(user, "audit.delete"), calculé
 * côté serveur par page.tsx) masque entièrement les cases à cocher et les actions de suppression
 * si absent — un utilisateur non-ADMIN, même avec une permission décorative ailleurs, ne voit
 * jamais cette capacité, cohérent avec la vérification serveur identique sur chaque route
 * (DELETE /api/audit/[id], POST /api/audit/bulk-delete).
 */
export function AuditLogTable({ logs, canDelete }: { logs: AuditLogRow[]; canDelete: boolean }) {
  const router = useRouter();
  const withStepUpRetry = useStepUpRetry();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<AuditLogRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const allSelected = logs.length > 0 && logs.every((log) => selectedIds.has(log.id));

  function toggleSelectAll(checked: boolean) {
    setSelectedIds(checked ? new Set(logs.map((log) => log.id)) : new Set());
  }

  function toggleSelected(id: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      await withStepUpRetry(() => apiDelete(`/api/audit/${pendingDelete.id}`));
      toast.success("Entrée d'audit supprimée.");
      const deletedId = pendingDelete.id;
      setPendingDelete(null);
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(deletedId);
        return next;
      });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la suppression.");
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleBulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setIsBulkDeleting(true);
    try {
      const result = await withStepUpRetry(() =>
        apiPost<{ deleted: number }>("/api/audit/bulk-delete", { ids })
      );
      toast.success(`${result.deleted} entrée(s) supprimée(s).`);
      setSelectedIds(new Set());
      setIsBulkDeleteOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la suppression.");
    } finally {
      setIsBulkDeleting(false);
    }
  }

  if (logs.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">Aucune entrée pour l&apos;instant.</p>;
  }

  return (
    <>
      {canDelete && selectedIds.size > 0 && (
        <div className="flex items-center justify-between border-b border-border bg-muted/50 px-3 py-2">
          <p className="text-sm text-muted-foreground">{selectedIds.size} sélectionnée(s)</p>
          <Button variant="destructive" size="sm" onClick={() => setIsBulkDeleteOpen(true)}>
            <Icon icon={Trash2} className="size-4" />
            Supprimer la sélection
          </Button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              {canDelete && (
                <th className="h-10 w-8 px-3 align-middle">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(checked) => toggleSelectAll(checked === true)}
                    aria-label="Tout sélectionner"
                  />
                </th>
              )}
              <th className="h-10 px-3 align-middle font-medium whitespace-nowrap">Date</th>
              <th className="h-10 px-3 align-middle font-medium whitespace-nowrap">Action</th>
              <th className="h-10 px-3 align-middle font-medium whitespace-nowrap">Ressource</th>
              <th className="h-10 px-3 align-middle font-medium whitespace-nowrap">Acteur</th>
              {canDelete && <th className="h-10 px-3 align-middle font-medium whitespace-nowrap" />}
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => {
              const { icon: ActionIcon, className } = getActionStyle(log.action);
              return (
                <tr key={log.id} className="border-t border-border">
                  {canDelete && (
                    <td className="px-3 py-2">
                      <Checkbox
                        checked={selectedIds.has(log.id)}
                        onCheckedChange={(checked) => toggleSelected(log.id, checked === true)}
                        aria-label="Sélectionner cette entrée"
                      />
                    </td>
                  )}
                  <td className="px-3 py-2 whitespace-nowrap">
                    {new Date(log.createdAt).toLocaleString("fr-FR")}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1.5 ${className}`}>
                      <Icon icon={ActionIcon} className="size-3.5 shrink-0" />
                      {ACTION_LABELS[log.action] ?? log.action}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {RESOURCE_LABELS[log.resource] ?? log.resource}
                    {log.resourceId ? ` (${log.resourceId})` : ""}
                  </td>
                  <td className="px-3 py-2">{log.actorLabel}</td>
                  {canDelete && (
                    <td className="px-3 py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Supprimer cette entrée"
                        onClick={() => setPendingDelete(log)}
                      >
                        <Icon icon={Trash2} className="size-4 text-destructive" />
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer cette entrée d&apos;audit ?</DialogTitle>
            <DialogDescription>
              Action irréversible. « {pendingDelete ? (ACTION_LABELS[pendingDelete.action] ?? pendingDelete.action) : ""} »
              {pendingDelete ? ` — ${new Date(pendingDelete.createdAt).toLocaleString("fr-FR")}` : ""}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Annuler
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? "Suppression..." : "Supprimer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isBulkDeleteOpen} onOpenChange={setIsBulkDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer {selectedIds.size} entrée(s) d&apos;audit ?</DialogTitle>
            <DialogDescription>Action irréversible.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsBulkDeleteOpen(false)}>
              Annuler
            </Button>
            <Button variant="destructive" onClick={handleBulkDelete} disabled={isBulkDeleting}>
              {isBulkDeleting ? "Suppression..." : "Supprimer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
