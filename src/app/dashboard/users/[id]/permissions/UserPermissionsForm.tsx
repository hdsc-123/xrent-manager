"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
import { useStepUpRetry } from "@/lib/step-up-retry";
import { Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui";
import { PermissionCheckboxGrid, type PermissionDef } from "../../../permission-groups/PermissionCheckboxGrid";

interface Group {
  id: string;
  name: string;
}

interface UserPermissionsFormProps {
  userId: string;
  isAdmin: boolean;
  groups: Group[];
  initialGroupId: string | null;
  initialIndividualPermissions: string[];
  groupPermissions: string[];
  permissions: PermissionDef[];
}

export function UserPermissionsForm({
  userId,
  isAdmin,
  groups,
  initialGroupId,
  initialIndividualPermissions,
  groupPermissions,
  permissions,
}: UserPermissionsFormProps) {
  const router = useRouter();
  const withStepUpRetry = useStepUpRetry();
  const [groupId, setGroupId] = useState(initialGroupId ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set(initialIndividualPermissions));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isAdmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Permissions</CardTitle>
          <CardDescription>
            Cet utilisateur est ADMIN : il a toujours accès à toutes les permissions, quel que soit le
            groupe ou les permissions individuelles assignés.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  async function handleSave() {
    setError(null);
    setIsSubmitting(true);
    try {
      await withStepUpRetry(() =>
        apiPatch(`/api/users/${userId}/permissions`, {
          permissionGroupId: groupId || null,
          individualPermissions: Array.from(selected),
        })
      );
      toast.success("Permissions mises à jour.");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Groupe de permissions</CardTitle>
          <CardDescription>Les permissions du groupe s&apos;appliquent automatiquement.</CardDescription>
        </CardHeader>
        <CardContent>
          <select
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Aucun groupe</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
          {groupId && groupPermissions.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Permissions du groupe : {groupPermissions.join(", ")}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Permissions individuelles</CardTitle>
          <CardDescription>S&apos;ajoutent à celles du groupe (jamais un retrait).</CardDescription>
        </CardHeader>
        <CardContent>
          <PermissionCheckboxGrid permissions={permissions} selected={selected} onChange={setSelected} />
        </CardContent>
        <CardFooter className="flex flex-col items-start gap-2">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="button" onClick={handleSave} disabled={isSubmitting}>
            {isSubmitting ? "Enregistrement..." : "Enregistrer"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
