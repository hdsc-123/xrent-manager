"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { useStepUpRetry } from "@/lib/step-up-retry";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Icon,
  Input,
  Label,
} from "@/components/ui";

interface DataResetCounts {
  client: number;
  vehicle: number;
  location: number;
  invoice: number;
  payment: number;
  maintenance: number;
  vehicleTransfer: number;
  vehicleTrip: number;
  alert: number;
  invitation: number;
  reservation: number;
  cashEntry: number;
  auditLog: number;
}

interface DataResetSummary {
  tenantName: string;
  toDelete: DataResetCounts;
}

const COUNT_LABELS: Record<keyof DataResetCounts, string> = {
  client: "Clients",
  vehicle: "Véhicules",
  location: "Locations",
  invoice: "Factures",
  payment: "Paiements",
  maintenance: "Maintenances",
  vehicleTransfer: "Transferts",
  vehicleTrip: "Déplacements",
  alert: "Alertes",
  invitation: "Invitations",
  reservation: "Réservations",
  cashEntry: "Écritures de caisse",
  auditLog: "Entrées du journal d'audit",
};

function totalToDelete(counts: DataResetCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

export function DataResetCard({ tenantName }: { tenantName: string }) {
  const router = useRouter();
  const withStepUpRetry = useStepUpRetry();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<DataResetSummary | null>(null);
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [includeAuditLog, setIncludeAuditLog] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [isResetting, setIsResetting] = useState(false);

  async function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setConfirmText("");
      setIncludeAuditLog(false);
      return;
    }

    setLoadError(null);
    setIsLoadingSummary(true);
    try {
      const data = await apiGet<DataResetSummary>("/api/data-reset");
      setSummary(data);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Impossible de charger l'aperçu.");
    } finally {
      setIsLoadingSummary(false);
    }
  }

  async function handleReset() {
    setIsResetting(true);
    try {
      const result = await withStepUpRetry(() =>
        apiPost<{ success: boolean; deleted: DataResetCounts }>("/api/data-reset", {
          confirmTenantName: confirmText,
          includeAuditLog,
        })
      );
      const total = totalToDelete(result.deleted);
      toast.success(`Données réinitialisées (${total} enregistrement${total > 1 ? "s" : ""} supprimé${total > 1 ? "s" : ""}).`);
      setOpen(false);
      setConfirmText("");
      setIncludeAuditLog(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la réinitialisation.");
    } finally {
      setIsResetting(false);
    }
  }

  const canConfirm = summary !== null && confirmText === summary.tenantName;

  return (
    <Card className="border-destructive/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <Icon icon={AlertTriangle} className="size-4" />
          Zone dangereuse
        </CardTitle>
        <CardDescription>
          Réinitialise les données métier de test de ce tenant pour repartir sur une base propre.
          Réservé aux administrateurs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          variant="destructive"
          className="w-fit"
          onClick={() => handleOpenChange(true)}
        >
          Réinitialiser les données de test
        </Button>

        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Réinitialiser les données de « {tenantName} » ?</DialogTitle>
              <DialogDescription>
                Cette action est <strong>irréversible</strong>. Toutes les données métier listées
                ci-dessous seront définitivement supprimées. Les utilisateurs, agences,
                permissions et paramètres du tenant sont conservés.
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
                <ul className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border border-border p-3 text-sm">
                  {(Object.keys(COUNT_LABELS) as (keyof DataResetCounts)[])
                    .filter((key) => key !== "auditLog")
                    .map((key) => (
                      <li key={key} className="flex justify-between gap-2">
                        <span className="text-muted-foreground">{COUNT_LABELS[key]}</span>
                        <span className="font-medium">{summary.toDelete[key]}</span>
                      </li>
                    ))}
                </ul>

                <div className="flex items-start gap-2">
                  <Checkbox
                    id="includeAuditLog"
                    checked={includeAuditLog}
                    onCheckedChange={(checked) => setIncludeAuditLog(checked === true)}
                  />
                  <Label htmlFor="includeAuditLog" className="text-sm font-normal">
                    Réinitialisation complète — supprime aussi les {summary.toDelete.auditLog}{" "}
                    entrées existantes du journal d&apos;audit (une nouvelle entrée enregistrant
                    ce reset sera tout de même créée).
                  </Label>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirmTenantName" required>
                    Tapez « {summary.tenantName} » pour confirmer
                  </Label>
                  <Input
                    id="confirmTenantName"
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
              <Button
                type="button"
                variant="destructive"
                disabled={!canConfirm || isResetting}
                onClick={handleReset}
              >
                {isResetting ? "Réinitialisation..." : "Réinitialiser définitivement"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
