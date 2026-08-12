/**
 * Politique de mot de passe (Sprint 9) : min 8 caractères, 1 majuscule, 1 chiffre,
 * 1 caractère spécial. Utilisée par /api/auth/register, l'acceptation d'invitation
 * et la réinitialisation de mot de passe par un ADMIN (PATCH /api/users/[id]).
 */
export function validatePassword(password: string): string[] {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push("Le mot de passe doit contenir au moins 8 caractères.");
  }
  if (!/[A-Z]/.test(password)) {
    errors.push("Le mot de passe doit contenir au moins une majuscule.");
  }
  if (!/[0-9]/.test(password)) {
    errors.push("Le mot de passe doit contenir au moins un chiffre.");
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    errors.push("Le mot de passe doit contenir au moins un caractère spécial.");
  }

  return errors;
}
