import { notFound } from "next/navigation";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getAgencyById } from "@/lib/db";
import { EditAgencyForm } from "./EditAgencyForm";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AgencyDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  // Correctif sprint soft 404 (2026-08-24) : gate manquant découvert lors de l'audit exhaustif
  // — cette page ne vérifiait jusqu'ici que l'accès à l'agence, jamais agencies.view,
  // contrairement à /dashboard/agencies (liste) et GET /api/agencies/[id], qui l'exigent tous
  // les deux. Même correctif que locations/[id] (Sprint technique 2).
  if (!(await can(user, "agencies.view"))) {
    notFound();
  }

  const agency = await getAgencyById(user.tenantId, id);
  if (!agency || !(await canAccessAgency(user, agency.id))) {
    notFound();
  }

  const canEdit = await can(user, "agencies.edit");

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold">{agency.name}</h1>
      {canEdit ? (
        <EditAgencyForm
          id={agency.id}
          initialName={agency.name}
          slug={agency.slug}
          initialCity={agency.city}
          initialAddress={agency.address}
          initialPhone={agency.phone}
          initialEmail={agency.email}
          initialManagerName={agency.managerName}
          initialManagerPhone={agency.managerPhone}
          initialContractNumberPrefix={agency.contractNumberPrefix}
          initialLastContractNumber={agency.lastContractNumber}
          initialCashStartingBalance={agency.cashStartingBalance}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Slug : {agency.slug}. Vous n&apos;avez pas la permission de modifier cette agence.
        </p>
      )}
    </div>
  );
}
