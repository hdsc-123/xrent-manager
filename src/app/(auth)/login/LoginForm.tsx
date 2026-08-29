"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  requiresMfa?: boolean;
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
  // Phase 3B MFA (2026-08-29, AGENTS.md brief) : compte avec MFA activée — interrompt le flux
  // après mot de passe validé, avant toute session, voir POST /api/auth/login (requiresMfa) et
  // POST /api/auth/mfa/verify. selectedTenantId conserve le tenant déjà résolu (le cas échéant)
  // pour le second appel, jamais redemandé à l'utilisateur.
  const [requiresMfa, setRequiresMfa] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [selectedTenantId, setSelectedTenantId] = useState<string | undefined>(undefined);

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

      if (result.requiresMfa) {
        setSelectedTenantId(tenantId);
        setRequiresMfa(true);
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

  async function submitMfaCode(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await apiPost<LoginResponse>("/api/auth/mfa/verify", {
        email,
        password,
        tenantId: selectedTenantId,
        rememberMe,
        code: mfaCode,
      });

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

  if (requiresMfa) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Vérification en deux étapes</CardTitle>
          <CardDescription>
            Entrez le code à 6 chiffres de votre application d&apos;authentification, ou l&apos;un
            de vos codes de récupération.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitMfaCode} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mfaCode" required>Code</Label>
              <Input
                id="mfaCode"
                name="mfaCode"
                type="text"
                autoComplete="one-time-code"
                required
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
                aria-invalid={Boolean(error)}
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={isSubmitting} className="w-full">
              {isSubmitting ? "Vérification..." : "Vérifier"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setRequiresMfa(false);
                setMfaCode("");
                setError(null);
              }}
            >
              Retour
            </Button>
          </form>
        </CardContent>
      </Card>
    );
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
      </CardContent>
    </Card>
  );
}
