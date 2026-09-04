import { LoginForm } from "./LoginForm";

// `Suspense` retiré (2026-09-04) : LoginForm ne dépend plus d'aucune API Next.js dynamique
// (voir LoginForm.tsx) — plus rien ne suspend dans ce sous-arbre, la page reste entièrement
// statique et pré-rendable, sans bail-out vers le rendu client sous `next start`.
export default function LoginPage() {
  return <LoginForm />;
}
