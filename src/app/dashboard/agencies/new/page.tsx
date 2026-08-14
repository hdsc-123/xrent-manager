import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { NewAgencyForm } from "./NewAgencyForm";

export default async function NewAgencyPage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "agencies.create"))) {
    notFound();
  }

  return <NewAgencyForm />;
}
