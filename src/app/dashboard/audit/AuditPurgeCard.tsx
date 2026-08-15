"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@/components/ui";

interface PurgeSummary {
  tenantName: string;
  count: number;
}

/**
 * Sprint 24-1 : purge complète du journal d'audit du tenant courant — brief explicite du
 * propriétaire du projet. Même mécanisme de confirmation que DataResetCard.tsx (saisie exacte du
 * nom du tenant) pour la même raison : c'est l'action la plus destructrice des trois (unité,
 * masse, purge totale) sur cette page, réservée ADMIN + permission audit.delete
 * (voir GET/POST /api/audit/purge/route.ts, seule autorité réelle — ce composant ne fait
 * qu'exposer l'UI, aucune décision d'accès n'est prise ici).
 */
export function AuditPurgeCard() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<PurgeSummary | null>(null);
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [isPurging, setIsPurging] = useState(false);

  async function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setConfirmText("");
      return;
    }

    setLoadError(null);
    setIsLoadingSummary(true);
    try {
      const data = await apiGet<PurgeSummary>("/api/audit/purge");
      setSummary(data);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Impossible de charger l'aperçu.");
    } finally {
      setIsLoadingSummary(false);
    }
  }

  async function handlePurge() {
    setIsPurging(true);
    try {
      const result = await apiPost<{ success: boolean; deleted: number }>("/api/audit/purge", {
        confirmTenantName: confirmText,
      });
      toast.success(`Journal d'audit purgé (${result.deleted} entrée(s) supprimée(s)).`);
      setOpen(false);
      setConfirmText("");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la purge.");
    } finally {
      setIsPurging(false);
    }
  }

  const canConfirm = summary !== null && confirmText === summary.tenantName;

  return (
    <Card className="border-destructive/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="size-4" />
          Zone dangereuse — Audit
        </CardTitle>
        <CardDescription>
          Supprime définitivement toutes les entrées du journal d&apos;audit de ce tenant. Cette
          action est <strong>irréversible</strong> et ne supprime aucune autre donnée métier.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" variant="destructive" className="w-fit" onClick={() => handleOpenChange(true)}>
          Purger le journal d&apos;audit
        </Button>

        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Purger le journal d&apos;audit ?</DialogTitle>
              <DialogDescription>
                Cette action est <strong>irréversible</strong>. Elle ne supprime que les entrées du
                journal d&apos;audit — aucune autre donnée métier n&apos;est affectée. Une nouvelle
                entrée enregistrant cette purge sera créée juste après.
              </DialogDescription>
            </DialogHeader>

            {isLoadingSummary && (
              <p className="text-sm text-muted-foreground">Chargement de l&apos;aperçu...</p>
            )}
            {loadError && (
              <p role="alert" className="text-sm text-destructive">
                {loadError}
              </p>
            )}

            {summary && (
              <>
                <p className="text-sm">
                  <span className="font-medium">{summary.count}</span> entrée(s) du journal
                  d&apos;audit de « {summary.tenantName} » seront définitivement supprimées.
                </p>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirmPurgeTenantName" required>
                    Tapez « {summary.tenantName} » pour confirmer
                  </Label>
                  <Input
                    id="confirmPurgeTenantName"
                    value={confirmText}
                    onChange={(event) => setConfirmText(event.target.value)}
                    autoComplete="off"
                  />
                </div>
              </>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Annuler
              </Button>
              <Button type="button" variant="destructive" disabled={!canConfirm || isPurging} onClick={handlePurge}>
                {isPurging ? "Purge..." : "Purger définitivement"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
