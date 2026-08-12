import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { getUserById } from "@/lib/users";
import { EditUserForm } from "./EditUserForm";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function UserDetailPage({ params }: PageProps) {
  const { id } = await params;
  const sessionUser = await getSessionUser();
  if (!sessionUser) return null;

  if (sessionUser.role !== "ADMIN") {
    notFound();
  }

  const target = await getUserById(sessionUser.tenantId, id);
  if (!target) {
    notFound();
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">{target.name}</h1>
        <p className="text-sm text-muted-foreground">{target.email}</p>
      </div>

      <EditUserForm
        id={target.id}
        initialRole={target.role}
        isSelf={target.id === sessionUser.id}
      />
    </div>
  );
}
