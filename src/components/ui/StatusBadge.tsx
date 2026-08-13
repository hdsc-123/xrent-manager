import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Badge de statut coloré réutilisable (Sprint 13B) — couvre les statuts `Reservation`
 * (PENDING/CONFIRMED/CONVERTED/CANCELLED) et `Location` (PENDING/CONFIRMED/ACTIVE/
 * COMPLETED/CANCELLED). Les deux vocabulaires ne se recouvrent que partiellement
 * (PENDING/CONFIRMED/CANCELLED communs), donc une seule table couleur/libellé suffit ; ACTIVE
 * (propre à Location) reçoit une couleur distincte de COMPLETED, non spécifiée par l'énoncé
 * du sprint (qui ne couvrait pas ce statut).
 */
const STATUS_STYLES: Record<string, string> = {
  PENDING:
    "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800",
  CONFIRMED:
    "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  ACTIVE:
    "bg-cyan-100 text-cyan-800 border-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-400 dark:border-cyan-800",
  COMPLETED:
    "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  CANCELLED:
    "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
  CONVERTED:
    "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  CONFIRMED: "Confirmée",
  ACTIVE: "En cours",
  COMPLETED: "Terminée",
  CANCELLED: "Annulée",
  CONVERTED: "Convertie",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn(STATUS_STYLES[status])}>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}
