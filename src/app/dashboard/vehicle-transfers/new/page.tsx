import { notFound } from "next/navigation";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { NewVehicleTransferForm } from "./NewVehicleTransferForm";

export default async function NewVehicleTransferPage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "vehicle_transfers.create"))) {
    notFound();
  }

  // Sprint 24 : la ville/agence de départ n'est plus un sélecteur libre parmi toutes les
  // agences du tenant — elle est dérivée des agences réellement accessibles à l'appelant
  // (UserAgency, même filtrage que getAccessibleAgencyIds côté serveur). Un ADMIN (accès
  // transverse) conserve le choix complet, cohérent avec son absence de restriction ailleurs
  // dans l'app.
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const ownAgencies = await prisma.agency.findMany({
    where: {
      tenantId: user.tenantId,
      ...(accessibleAgencyIds !== null ? { id: { in: accessibleAgencyIds } } : {}),
    },
    select: { id: true, name: true, city: true },
    orderBy: { name: "asc" },
  });

  return <NewVehicleTransferForm ownAgencies={ownAgencies} />;
}
