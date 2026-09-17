"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { apiPatch, apiDelete, ApiError } from "@/lib/api";
import { useStepUpRetry } from "@/lib/step-up-retry";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@/components/ui";

interface AgencyOption {
  id: string;
  name: string;
}

interface EditUserFormProps {
  id: string;
  initialRole: string;
  isSelf: boolean;
  agencies: AgencyOption[];
  initialAgencyIds: string[];
  /** Nom du PermissionGroup assigné (Sprint 12C), null si aucun — affiché ici pour la
   * découvrabilité (Sprint 15) : le rôle ADMIN/MEMBER seul ne reflète pas les groupes
   * COMPTABILITÉ/AGENCE/personnalisés, gérés sur la page /permissions dédiée. */
  permissionGroupName: string | null;
}

export function EditUserForm({
  id,
  initialRole,
  isSelf,
  agencies,
  initialAgencyIds,
  permissionGroupName,
}: EditUserFormProps) {
  const router = useRouter();
  const withStepUpRetry = useStepUpRetry();
  const [role, setRole] = useState(initialRole);
  const [password, setPassword] = useState("");
  const [agencyIds, setAgencyIds] = useState<Set<string>>(new Set(initialAgencyIds));
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function toggleAgency(agencyId: string, checked: boolean) {
    setAgencyIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(agencyId);
      } else {
        next.delete(agencyId);
      }
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const body: { role?: string; password?: string; agencyIds?: string[] } = {
        role,
        agencyIds: Array.from(agencyIds),
      };
      if (password) {
        body.password = password;
      }
      await withStepUpRetry(() => apiPatch(`/api/users/${id}`, body));
      toast.success("Utilisateur mis à jour.");
      setPassword("");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete() {
    setIsDeleting(true);
    try {
      await apiDelete(`/api/users/${id}`);
      toast.success("Utilisateur supprimé.");
      router.push("/dashboard/users");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Modifier l&apos;utilisateur</CardTitle>
          <CardDescription>Rôle, agences assignées et réinitialisation du mot de passe.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="role">Rôle</Label>
              <select
                id="role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="MEMBER">Membre</option>
                <option value="ADMIN">Administrateur</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Groupe de permissions : {permissionGroupName ?? "Aucun"} —{" "}
                <Link href={`/dashboard/users/${id}/permissions`} className="underline">
                  Modifier
                </Link>
              </p>
            </div>

            {role === "MEMBER" && (
              <div className="flex flex-col gap-1.5">
                <Label>Agences</Label>
                <p className="text-xs text-muted-foreground">
                  Un membre ne voit et ne peut agir que sur les agences cochées ci-dessous
                  (véhicules, locations, clients de ces agences).
                </p>
                {agencies.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aucune agence pour ce tenant.</p>
                ) : (
                  <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                    {agencies.map((agency) => (
                      <label key={agency.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={agencyIds.has(agency.id)}
                          onCheckedChange={(checked) => toggleAgency(agency.id, checked === true)}
                        />
                        {agency.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">
                Nouveau mot de passe <span className="text-muted-foreground">— optionnel</span>
              </Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={isSubmitting} className="w-fit">
              {isSubmitting ? "Enregistrement..." : "Enregistrer"}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="justify-end border-t border-border pt-4">
          <Button
            type="button"
            variant="destructive"
            onClick={() => setConfirmDelete(true)}
          >
            Supprimer l&apos;utilisateur
          </Button>
        </CardFooter>
      </Card>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer cet utilisateur ?</DialogTitle>
            <DialogDescription>
              {isSelf
                ? "Vous êtes sur le point de supprimer votre propre compte."
                : "Cette action est irréversible."}{" "}
              Impossible si c&apos;est le dernier administrateur du tenant.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Annuler
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? "Suppression..." : "Supprimer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
