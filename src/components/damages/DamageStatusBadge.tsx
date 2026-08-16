import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Sprint 32 (DOMAINRULES.md section 32) — badge de statut pour Damage, même patron que
 * StatusBadge.tsx (Reservation/Location) mais vocabulaire distinct (DamageStatus n'a rien de
 * commun avec LocationStatus/ReservationStatus) : composant dédié plutôt qu'une table
 * supplémentaire dans StatusBadge.tsx.
 */
const DAMAGE_STATUS_STYLES: Record<string, string> = {
  REPORTED:
    "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800",
  PARTIALLY_PAID:
    "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800",
  PAID: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  // Sprint 33 — reflète l'annulation de la DamageInvoice à laquelle ce dégât est rattaché.
  CANCELLED:
    "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800/40 dark:text-slate-400 dark:border-slate-700",
};

const DAMAGE_STATUS_LABELS: Record<string, string> = {
  REPORTED: "Signalé",
  PARTIALLY_PAID: "Partiellement payé",
  PAID: "Payé",
  CANCELLED: "Annulé",
};

export function DamageStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn(DAMAGE_STATUS_STYLES[status])}>
      {DAMAGE_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}
