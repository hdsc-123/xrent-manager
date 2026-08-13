import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { getTenantById } from "@/lib/db";
import { EditTenantForm } from "./EditTenantForm";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function TenantDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  // Un tenant n'est jamais accessible en dehors du sien (SECURITY.md section 1),
  // même vérification que /api/tenants/[id].
  if (id !== user.tenantId) {
    notFound();
  }

  const tenant = await getTenantById(user.tenantId);
  if (!tenant) {
    notFound();
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="font-heading text-2xl font-semibold">{tenant.name}</h1>
      <EditTenantForm
        id={tenant.id}
        initialName={tenant.name}
        slug={tenant.slug}
        initialContractNumberPrefix={tenant.contractNumberPrefix}
        initialLastContractNumber={tenant.lastContractNumber}
      />
    </div>
  );
}
