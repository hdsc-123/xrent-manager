"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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

interface LoginResponse {
  user?: { id: string; tenantId: string; email: string; name: string; role: string };
  requiresTenantSelection?: boolean;
  tenants?: { id: string; name: string }[];
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [tenants, setTenants] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submitLogin(tenantId?: string) {
    setError(null);
    setIsSubmitting(true);

    try {
      const result = await apiPost<LoginResponse>("/api/auth/login", {
        email,
        password,
        tenantId,
        rememberMe,
      });

      if (result.requiresTenantSelection && result.tenants) {
        setTenants(result.tenants);
        return;
      }

      toast.success("Connexion réussie.");
      router.push(callbackUrl);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue. Veuillez réessayer.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    await submitLogin();
  }

  if (tenants) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Choisissez votre espace</CardTitle>
          <CardDescription>
            Cet email est utilisé dans plusieurs organisations. Sélectionnez celle à laquelle vous
            connecter.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {tenants.map((tenant) => (
            <Button
              key={tenant.id}
              type="button"
              variant="outline"
              className="justify-start"
              disabled={isSubmitting}
              onClick={() => submitLogin(tenant.id)}
            >
              {tenant.name}
            </Button>
          ))}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={() => setTenants(null)}>
            Retour
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connexion</CardTitle>
        <CardDescription>Connectez-vous à votre espace XRent Manager.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email" required>Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={Boolean(error)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password" required>Mot de passe</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={Boolean(error)}
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id="rememberMe"
              type="checkbox"
              checked={rememberMe}
              onChange={(event) => setRememberMe(event.target.checked)}
              className="size-4 rounded border-input"
            />
            <Label htmlFor="rememberMe" className="text-sm font-normal text-muted-foreground">
              Se souvenir de moi
            </Label>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={isSubmitting} className="w-full">
            {isSubmitting ? "Connexion..." : "Se connecter"}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          Pas encore de compte ?{" "}
          <Link href="/register" className="font-medium text-foreground underline underline-offset-4">
            Créer un tenant
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
