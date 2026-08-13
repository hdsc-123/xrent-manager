"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPatch, apiDelete, ApiError } from "@/lib/api";
import {
  Button,
  Card,
  CardContent,
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
import { PermissionCheckboxGrid, type PermissionDef } from "../PermissionCheckboxGrid";

interface EditPermissionGroupFormProps {
  groupId: string;
  initialName: string;
  initialPermissions: string[];
  permissions: PermissionDef[];
}

export function EditPermissionGroupForm({
  groupId,
  initialName,
  initialPermissions,
  permissions,
}: EditPermissionGroupFormProps) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialPermissions));
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await apiPatch(`/api/permission-groups/${groupId}`, { name, permissions: Array.from(selected) });
      toast.success("Groupe mis à jour.");
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
      await apiDelete(`/api/permission-groups/${groupId}`);
      toast.success("Groupe supprimé.");
      router.push("/dashboard/permission-groups");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Erreur lors de la suppression.");
      setConfirmDelete(false);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Modifier le groupe</CardTitle>
      </CardHeader>
      <form onSubmit={handleSave}>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name" required>Nom</Label>
            <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <PermissionCheckboxGrid permissions={permissions} selected={selected} onChange={setSelected} />

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex justify-between">
          <Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
            Supprimer
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Enregistrement..." : "Enregistrer"}
          </Button>
        </CardFooter>
      </form>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer ce groupe ?</DialogTitle>
            <DialogDescription>
              Impossible si des utilisateurs y sont encore rattachés — réassignez-les d&apos;abord.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Retour
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? "Suppression..." : "Supprimer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
