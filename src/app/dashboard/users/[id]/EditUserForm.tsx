"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPatch, apiDelete, ApiError } from "@/lib/api";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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

interface EditUserFormProps {
  id: string;
  initialRole: string;
  isSelf: boolean;
}

export function EditUserForm({ id, initialRole, isSelf }: EditUserFormProps) {
  const router = useRouter();
  const [role, setRole] = useState(initialRole);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const body: { role?: string; password?: string } = { role };
      if (password) {
        body.password = password;
      }
      await apiPatch(`/api/users/${id}`, body);
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
          <CardDescription>Rôle et réinitialisation du mot de passe.</CardDescription>
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
            </div>

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
