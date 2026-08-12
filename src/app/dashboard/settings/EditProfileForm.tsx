"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { apiPatch, ApiError } from "@/lib/api";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  PhoneInput,
} from "@/components/ui";

interface EditProfileFormProps {
  initialName: string;
  initialEmail: string;
  initialPhone: string;
  initialAvatar: string;
}

export function EditProfileForm({ initialName, initialEmail, initialPhone, initialAvatar }: EditProfileFormProps) {
  const router = useRouter();
  const { update: updateSession } = useSession();
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [phone, setPhone] = useState(initialPhone);
  const [avatar, setAvatar] = useState(initialAvatar);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (newPassword && newPassword !== confirmPassword) {
      setError("La confirmation ne correspond pas au nouveau mot de passe.");
      return;
    }

    setIsSubmitting(true);

    try {
      const body: {
        name?: string;
        email?: string;
        phone?: string;
        avatar?: string;
        currentPassword?: string;
        newPassword?: string;
      } = {
        name,
        email,
        phone,
        avatar,
      };
      if (newPassword) {
        body.currentPassword = currentPassword;
        body.newPassword = newPassword;
      }

      await apiPatch("/api/users/me", body);
      toast.success("Profil mis à jour.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");

      // Rafraîchit le token JWT (nom/email) sans exiger de reconnexion (Sprint 11,
      // HANDOFF.md point 35) : déclenche le callback jwt() avec trigger "update", qui
      // relit la valeur à jour en base — voir src/lib/auth.ts.
      if (name !== initialName || email !== initialEmail) {
        await updateSession();
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mon compte</CardTitle>
        <CardDescription>
          Modifier votre nom, votre email ou votre mot de passe. Le changement de mot de
          passe exige de saisir votre mot de passe actuel.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Nom</Label>
            <Input id="name" required value={name} onChange={(event) => setName(event.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="phone">
              Téléphone <span className="text-muted-foreground">— optionnel</span>
            </Label>
            <PhoneInput id="phone" value={phone} onChange={setPhone} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="avatar">
              Photo de profil (URL) <span className="text-muted-foreground">— optionnel</span>
            </Label>
            <Input
              id="avatar"
              type="url"
              placeholder="https://..."
              value={avatar}
              onChange={(event) => setAvatar(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5 border-t border-border pt-4">
            <Label htmlFor="newPassword">Nouveau mot de passe</Label>
            <Input
              id="newPassword"
              type="password"
              placeholder="Laisser vide pour ne pas changer"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </div>

          {newPassword && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirmPassword">Confirmer le nouveau mot de passe</Label>
              <Input
                id="confirmPassword"
                type="password"
                required
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </div>
          )}

          {newPassword && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="currentPassword">Mot de passe actuel</Label>
              <Input
                id="currentPassword"
                type="password"
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </div>
          )}

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
    </Card>
  );
}
