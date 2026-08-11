"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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

interface RegisterResponse {
  tenant: { id: string; name: string; slug: string };
  user: { id: string; email: string };
}

export default function RegisterPage() {
  const router = useRouter();

  const [tenantName, setTenantName] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await apiPost<RegisterResponse>("/api/auth/register", {
        tenantName,
        tenantSlug: tenantSlug || undefined,
        name,
        email,
        password,
      });

      toast.success("Compte créé. Vous pouvez maintenant vous connecter.");
      router.push("/login");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Créer votre espace</CardTitle>
        <CardDescription>
          Cette étape crée un nouveau tenant et son premier utilisateur (administrateur).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tenantName">Nom de l&apos;organisation</Label>
            <Input
              id="tenantName"
              name="tenantName"
              required
              value={tenantName}
              onChange={(event) => setTenantName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tenantSlug">
              Identifiant (slug) <span className="text-muted-foreground">— optionnel</span>
            </Label>
            <Input
              id="tenantSlug"
              name="tenantSlug"
              placeholder="généré automatiquement si vide"
              value={tenantSlug}
              onChange={(event) => setTenantSlug(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Votre nom</Label>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Mot de passe</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">8 caractères minimum.</p>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={isSubmitting} className="w-full">
            {isSubmitting ? "Création..." : "Créer mon espace"}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          Déjà un compte ?{" "}
          <Link href="/login" className="font-medium text-foreground underline underline-offset-4">
            Se connecter
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
