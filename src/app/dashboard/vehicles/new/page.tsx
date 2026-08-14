import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { NewVehicleForm } from "./NewVehicleForm";

export default async function NewVehiclePage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "vehicles.create"))) {
    notFound();
  }

  return <NewVehicleForm />;
}
