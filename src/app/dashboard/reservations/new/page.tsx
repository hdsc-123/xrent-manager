import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { NewReservationForm } from "./NewReservationForm";

/**
 * Correctif sprint soft 404 (2026-08-24) : garde serveur ajoutée (reservations.create) —
 * jusqu'ici cette page (Client Component pur) rendait le formulaire de création sans aucune
 * vérification, contrairement à toutes les autres pages de création similaires (agencies/new,
 * clients/new, vehicles/new, etc.) et à reservations/import/page.tsx (déjà corrigé au Sprint 18
 * pour exactement la même raison — écart découvert par comparaison lors de l'audit exhaustif du
 * soft 404, jamais reporté à ce module) : un utilisateur connaissant l'URL directe voyait le
 * formulaire s'afficher normalement même sans la permission, l'échec n'intervenant qu'à la
 * soumission (403 de POST /api/reservations). Même découpage Server/Client Component que
 * import/, convert/ et edit/.
 */
export default async function NewReservationPage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "reservations.create"))) {
    notFound();
  }

  return <NewReservationForm />;
}
