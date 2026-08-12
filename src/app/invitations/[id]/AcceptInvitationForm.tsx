"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@/components/ui";

interface AcceptInvitationFormProps {
  id: string;
  email: string;
  tenantName: string;
  role: string;
}

export function AcceptInvitationForm({ id, email, tenantName, role }: AcceptInvitationFormProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeclining, setIsDeclining] = useState(false);
  const [declined, setDeclined] = useState(false);

  async function handleAccept(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await apiPost(`/api/invitations/${id}/accept`, { name, password });
      toast.success("Compte créé. Vous pouvez maintenant vous connecter.");
      router.push("/login");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDecline() {
    setIsDeclining(true);
    try {
      await apiPost(`/api/invitations/${id}/decline`, {});
      setDeclined(true);
      toast.success("Invitation déclinée.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsDeclining(false);
    }
  }

  if (declined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invitation déclinée</CardTitle>
          <CardDescription>Vous pouvez fermer cette page.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rejoindre {tenantName}</CardTitle>
        <CardDescription>
          Vous avez été invité(e) en tant que {role === "ADMIN" ? "administrateur" : "membre"}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleAccept} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={email} disabled readOnly />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Votre nom</Label>
            <Input
              id="name"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Mot de passe</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              8 caractères minimum, avec majuscule, chiffre et caractère spécial.
            </p>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={isSubmitting} className="w-full">
            {isSubmitting ? "Création..." : "Accepter et créer mon compte"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={isDeclining}
            onClick={handleDecline}
            className="w-full"
          >
            {isDeclining ? "..." : "Décliner l'invitation"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
