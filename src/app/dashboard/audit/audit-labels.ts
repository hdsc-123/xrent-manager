import { Plus, Pencil, Trash2, Upload, ArrowRightLeft, CheckCircle2, Circle, type LucideIcon } from "lucide-react";

/**
 * Sprint 24-1 : extrait de page.tsx (Server Component) pour être réutilisable tel quel par
 * AuditLogTable.tsx (Client Component, sélection + suppression) — un composant serveur ne peut
 * pas transmettre une référence de composant (LucideIcon) en prop à un Client Component à
 * travers la frontière RSC, seules des données sérialisables le peuvent ; ce module, purement
 * fonctionnel (aucun hook, aucune API navigateur), est donc importé tel quel des deux côtés
 * plutôt que dupliqué.
 */
export const ACTION_LABELS: Record<string, string> = {
  "user.role_changed": "Changement de rôle",
  "user.agencies_changed": "Agences assignées modifiées",
  "user.deleted": "Suppression d'utilisateur",
  "user.profile_updated": "Profil modifié",
  "user.permissions_changed": "Permissions modifiées",
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
  "client.duplicate_reused": "Client existant réutilisé (doublon)",
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
  "alert_check.scheduled_run": "Vérification automatique des alertes (scheduler horaire)",
  "reservation.created": "Réservation créée",
  "reservation.updated": "Réservation modifiée",
  "reservation.status_changed": "Statut de réservation modifié",
  "reservation.deleted": "Réservation supprimée",
  "reservation.imported": "Réservations importées (Excel)",
  "reservation.converted": "Réservation convertie en contrat",
  "permission_group.created": "Groupe de permissions créé",
  "permission_group.updated": "Groupe de permissions modifié",
  "permission_group.deleted": "Groupe de permissions supprimé",
  "cashEntry.created": "Entrée de caisse enregistrée",
  "cashExpense.created": "Dépense de caisse enregistrée",
  "expenseCategory.created": "Catégorie de dépense créée",
  "vehicle_transfer.created": "Transfert de véhicule lancé",
  "vehicle_transfer.validated": "Transfert de véhicule validé",
  "vehicle_transfer.cancelled": "Transfert de véhicule annulé",
  "vehicle_trip.created": "Bon de déplacement créé",
  "vehicle_trip.returned": "Retour de déplacement enregistré",
  "vehicle_trip.cancelled": "Bon de déplacement annulé",
  "data.reset": "Réinitialisation de données",
  "data.reset_failed": "Tentative de réinitialisation refusée (confirmation invalide)",
  "agency.created": "Agence créée",
  "agency.updated": "Agence modifiée",
  "agency.deleted": "Agence supprimée",
  "user.created": "Utilisateur créé",
  "tenant.updated": "Tenant modifié",
  "user.password_reset": "Mot de passe réinitialisé (par un administrateur)",
  // Sprint 24-1 : suppression du journal d'audit lui-même (voir src/lib/audit.ts).
  "audit.log_deleted": "Entrée d'audit supprimée",
  "audit.bulk_deleted": "Entrées d'audit supprimées (en masse)",
  "audit.purged": "Journal d'audit purgé",
  "audit.purge_failed": "Tentative de purge refusée (confirmation invalide)",
};

export const RESOURCE_LABELS: Record<string, string> = {
  User: "Utilisateur",
  Invitation: "Invitation",
  Vehicle: "Véhicule",
  Location: "Location",
  Client: "Client",
  Invoice: "Facture",
  Payment: "Paiement",
  Maintenance: "Maintenance",
  Alert: "Alerte",
  Reservation: "Réservation",
  PermissionGroup: "Groupe de permissions",
  Agency: "Agence",
  Tenant: "Tenant",
  CashEntry: "Écriture de caisse",
  CashRegister: "Caisse",
  ExpenseCategory: "Catégorie de dépense",
  VehicleTransfer: "Transfert de véhicule",
  VehicleTrip: "Bon de déplacement",
  AuditLog: "Journal d'audit",
};

/** Icône + couleur par type d'action, dérivées du suffixe verbal de l'action plutôt que d'une
 * carte exhaustive par action — reste correct pour toute nouvelle action suivant la convention
 * "<ressource>.<verbe>" (DOMAINRULES.md section 16). */
export function getActionStyle(action: string): { icon: LucideIcon; className: string } {
  if (action.endsWith(".created") || action.endsWith(".imported")) {
    return { icon: Plus, className: "text-success" };
  }
  if (
    action.endsWith(".deleted") ||
    action.endsWith(".revoked") ||
    action.endsWith(".declined") ||
    action.endsWith("_deleted") ||
    action.endsWith(".purged")
  ) {
    return { icon: Trash2, className: "text-destructive" };
  }
  if (action.endsWith(".converted")) {
    return { icon: ArrowRightLeft, className: "text-primary" };
  }
  if (action.endsWith(".acknowledged") || action.endsWith(".resolved") || action.endsWith(".accepted")) {
    return { icon: CheckCircle2, className: "text-success" };
  }
  if (
    action.endsWith(".updated") ||
    action.endsWith(".status_changed") ||
    action.endsWith("_changed") ||
    action.endsWith("_reused")
  ) {
    return { icon: action.endsWith("_reused") ? Upload : Pencil, className: "text-primary" };
  }
  return { icon: Circle, className: "text-muted-foreground" };
}
