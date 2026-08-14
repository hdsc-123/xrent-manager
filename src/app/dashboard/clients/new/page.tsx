import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { NewClientForm } from "./NewClientForm";

export default async function NewClientPage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "clients.create"))) {
    notFound();
  }

  return <NewClientForm />;
}
