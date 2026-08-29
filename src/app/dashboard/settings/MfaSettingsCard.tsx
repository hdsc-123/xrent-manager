"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@/components/ui";

/**
 * Phase 3B MFA (2026-08-29, AGENTS.md brief) : interface minimale d'enrôlement MFA opt-in —
 * état, démarrage, confirmation, affichage unique des codes de récupération. Volontairement
 * absents (hors périmètre de cette phase) : désactivation, régénération de codes, obligation
 * MFA, QR code (aucune dépendance validée, le secret Base32/l'URI otpauth:// sont affichés en
 * texte pour saisie manuelle dans l'application d'authentification).
 */

type MfaStatus = "loading" | "disabled" | "enrolling" | "confirming" | "recovery-codes" | "enabled";

interface StatusResponse {
  mfaEnabled: boolean;
  hasPendingEnrollment: boolean;
}

interface EnrollResponse {
  secretBase32: string;
  otpauthUri: string;
}

export function MfaSettingsCard() {
  const [status, setStatus] = useState<MfaStatus>("loading");
  const [enrollment, setEnrollment] = useState<EnrollResponse | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    apiGet<StatusResponse>("/api/mfa/status")
      .then((data) => setStatus(data.mfaEnabled ? "enabled" : "disabled"))
      .catch(() => setStatus("disabled"));
  }, []);

  async function startEnrollment() {
    setError(null);
    setIsSubmitting(true);
    try {
      const data = await apiPost<EnrollResponse>("/api/mfa/enroll", {});
      setEnrollment(data);
      setStatus("confirming");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function confirmEnrollment(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const data = await apiPost<{ recoveryCodes: string[] }>("/api/mfa/enroll/confirm", { code });
      setRecoveryCodes(data.recoveryCodes);
      setStatus("recovery-codes");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  function finishRecoveryCodesStep() {
    setRecoveryCodes([]);
    setEnrollment(null);
    setCode("");
    setStatus("enabled");
    toast.success("MFA activée.");
  }

  if (status === "loading") {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Authentification à deux facteurs</CardTitle>
        <CardDescription>
          Protège votre compte avec un code temporaire en plus de votre mot de passe.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status === "enabled" && (
          <p className="text-sm text-muted-foreground">MFA activée sur ce compte.</p>
        )}

        {status === "disabled" && (
          <>
            <p className="text-sm text-muted-foreground">MFA désactivée sur ce compte.</p>
            <Button type="button" onClick={startEnrollment} disabled={isSubmitting}>
              Activer la MFA
            </Button>
          </>
        )}

        {status === "confirming" && enrollment && (
          <form onSubmit={confirmEnrollment} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <p className="text-sm text-muted-foreground">
                Ajoutez ce compte à votre application d&apos;authentification (Google
                Authenticator, Authy, 1Password...) en saisissant la clé ci-dessous, puis
                confirmez avec le code généré.
              </p>
              <p className="break-all rounded-md border bg-muted p-2 font-mono text-xs">
                {enrollment.secretBase32}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mfaConfirmCode" required>Code de confirmation</Label>
              <Input
                id="mfaConfirmCode"
                name="mfaConfirmCode"
                type="text"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
                aria-invalid={Boolean(error)}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={isSubmitting}>
              Confirmer
            </Button>
          </form>
        )}

        {status === "recovery-codes" && (
          <div className="flex flex-col gap-4">
            <p className="text-sm font-medium text-destructive">
              Notez ces codes de récupération maintenant : ils ne seront plus jamais affichés.
              Chacun ne peut être utilisé qu&apos;une seule fois pour vous connecter si vous
              perdez l&apos;accès à votre application d&apos;authentification.
            </p>
            <ul className="grid grid-cols-2 gap-1 rounded-md border bg-muted p-3 font-mono text-xs">
              {recoveryCodes.map((recoveryCode) => (
                <li key={recoveryCode}>{recoveryCode}</li>
              ))}
            </ul>
            <Button type="button" onClick={finishRecoveryCodesStep}>
              J&apos;ai noté mes codes de récupération
            </Button>
          </div>
        )}

        {status === "disabled" && error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
