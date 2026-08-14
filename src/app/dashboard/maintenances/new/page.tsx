import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { NewMaintenanceForm } from "./NewMaintenanceForm";

export default async function NewMaintenancePage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "maintenances.create"))) {
    notFound();
  }

  return <NewMaintenanceForm />;
}
