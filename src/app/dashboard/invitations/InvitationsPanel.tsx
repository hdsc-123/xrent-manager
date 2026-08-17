"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Trash2, UserPlus } from "lucide-react";
import { apiPost, apiDelete, ApiError } from "@/lib/api";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";
import {
  Badge,
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
  Icon,
  Input,
  Label,
} from "@/components/ui";

export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  ACCEPTED: "Acceptée",
  DECLINED: "Déclinée",
  EXPIRED: "Expirée",
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  PENDING: "default",
  ACCEPTED: "secondary",
  DECLINED: "outline",
  EXPIRED: "destructive",
};

export function InvitationsPanel({ invitations }: { invitations: InvitationRow[] }) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("MEMBER");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<InvitationRow | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await apiPost("/api/invitations", { email, role });
      toast.success("Invitation créée.");
      setDialogOpen(false);
      setEmail("");
      setRole("MEMBER");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRevoke() {
    if (!pendingRevoke) return;
    setIsRevoking(true);
    try {
      await apiDelete(`/api/invitations/${pendingRevoke.id}`);
      toast.success("Invitation révoquée.");
      setPendingRevoke(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsRevoking(false);
    }
  }

  function copyLink(id: string) {
    const url = `${window.location.origin}/invitations/${id}`;
    navigator.clipboard.writeText(url);
    toast.success("Lien copié dans le presse-papiers.");
  }

  const columns = useMemo<DataTableColumn<InvitationRow>[]>(
    () => [
      { accessorKey: "email", header: "Email" },
      {
        accessorKey: "role",
        header: "Rôle",
        cell: ({ getValue }) => (getValue<string>() === "ADMIN" ? "Administrateur" : "Membre"),
      },
      {
        accessorKey: "status",
        header: "Statut",
        cell: ({ getValue }) => {
          const status = getValue<string>();
          return <Badge variant={STATUS_VARIANTS[status] ?? "outline"}>{STATUS_LABELS[status] ?? status}</Badge>;
        },
      },
      {
        accessorKey: "expiresAt",
        header: "Expire le",
        cell: ({ getValue }) => new Date(getValue<string>()).toLocaleDateString("fr-FR"),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            {row.original.status === "PENDING" && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copier le lien"
                  onClick={() => copyLink(row.original.id)}
                >
                  <Icon icon={Copy} className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Révoquer"
                  onClick={() => setPendingRevoke(row.original)}
                >
                  <Icon icon={Trash2} className="size-4" />
                </Button>
              </>
            )}
          </div>
        ),
      },
    ],
    []
  );

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>Invitations envoyées</CardTitle>
              <CardDescription>Liste des invitations de ce tenant.</CardDescription>
            </div>
            <Button onClick={() => setDialogOpen(true)}>
              <Icon icon={UserPlus} className="size-4" />
              Inviter
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable columns={columns} data={invitations} emptyMessage="Aucune invitation." />
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Inviter un utilisateur</DialogTitle>
            <DialogDescription>
              Un lien sera généré à partager manuellement (aucun email n&apos;est envoyé).
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-email" required>Email</Label>
              <Input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-role">Rôle</Label>
              <select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="MEMBER">Membre</option>
                <option value="ADMIN">Administrateur</option>
              </select>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Envoi..." : "Créer l'invitation"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(pendingRevoke)} onOpenChange={(open) => !open && setPendingRevoke(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Révoquer cette invitation ?</DialogTitle>
            <DialogDescription>
              Le lien envoyé à « {pendingRevoke?.email} » ne fonctionnera plus.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRevoke(null)}>
              Annuler
            </Button>
            <Button variant="destructive" onClick={handleRevoke} disabled={isRevoking}>
              {isRevoking ? "Révocation..." : "Révoquer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
