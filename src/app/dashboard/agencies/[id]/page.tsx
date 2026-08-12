import { notFound } from "next/navigation";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { getAgencyById } from "@/lib/db";
import { EditAgencyForm } from "./EditAgencyForm";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AgencyDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  const agency = await getAgencyById(user.tenantId, id);
  if (!agency || !(await canAccessAgency(user, agency.id))) {
    notFound();
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold">{agency.name}</h1>
      {user.role === "ADMIN" ? (
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
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Slug : {agency.slug}. Seul un administrateur peut modifier cette agence.
        </p>
      )}
    </div>
  );
}
