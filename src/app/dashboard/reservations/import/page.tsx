import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { ImportReservationsForm } from "./ImportReservationsForm";

/**
 * Sprint 18 : garde serveur ajoutée (reservations.import) — jusqu'ici cette page (Client
 * Component pur) rendait le formulaire d'import sans aucune vérification, contrairement aux
 * autres pages similairement restreintes (ex. convert/page.tsx) : un utilisateur connaissant
 * l'URL directe voyait le formulaire s'afficher normalement même sans la permission, l'échec
 * n'intervenant qu'à la soumission (403 de POST /api/reservations/import). Même découpage
 * Server/Client Component que convert/ et edit/.
 */
export default async function ImportReservationsPage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "reservations.import"))) {
    notFound();
  }

  return <ImportReservationsForm />;
}
