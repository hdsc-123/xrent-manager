"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
} from "@/components/ui";

export interface DuplicateClientInfo {
  client: { id: string; name: string; email: string | null; phone: string | null };
  matchType: "exact" | "fuzzy";
  field: "email" | "phone" | "idNumber" | "licenseNumber" | "name";
}

const FIELD_LABELS: Record<DuplicateClientInfo["field"], string> = {
  email: "l'email",
  phone: "le téléphone",
  idNumber: "le numéro de pièce d'identité",
  licenseNumber: "le numéro de permis",
  name: "le nom",
};

interface DuplicateCheckProps {
  duplicate: DuplicateClientInfo | null;
  onUseExisting: () => void;
  onCreateAnyway: () => void;
  onCancel: () => void;
  isSubmitting?: boolean;
}

/**
 * Dialogue affiché quand POST /api/clients renvoie 409 { duplicate } (détection de
 * doublons, DOMAINRULES.md section 9) — que ce soit depuis /dashboard/clients/new ou
 * depuis la conversion d'une réservation en contrat (même flux, même composant).
 */
export function DuplicateCheck({
  duplicate,
  onUseExisting,
  onCreateAnyway,
  onCancel,
  isSubmitting = false,
}: DuplicateCheckProps) {
  return (
    <Dialog
      open={duplicate !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Client similaire détecté</DialogTitle>
          <DialogDescription>
            {duplicate && (
              <>
                Un client {duplicate.matchType === "exact" ? "identique" : "possiblement le même"} existe
                déjà (correspondance sur {FIELD_LABELS[duplicate.field]}) :{" "}
                <strong className="text-foreground">{duplicate.client.name}</strong>
                {duplicate.client.email ? `, ${duplicate.client.email}` : ""}
                {duplicate.client.phone ? `, ${duplicate.client.phone}` : ""}. Voulez-vous utiliser ce
                client existant, ou en créer un nouveau quand même ?
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCreateAnyway} disabled={isSubmitting}>
            Créer quand même
          </Button>
          <Button type="button" onClick={onUseExisting} disabled={isSubmitting}>
            Utiliser ce client
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
