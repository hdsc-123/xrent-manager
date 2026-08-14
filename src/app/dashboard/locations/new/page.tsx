import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { NewLocationForm } from "./NewLocationForm";

export default async function NewLocationPage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "locations.create"))) {
    notFound();
  }

  return <NewLocationForm />;
}
