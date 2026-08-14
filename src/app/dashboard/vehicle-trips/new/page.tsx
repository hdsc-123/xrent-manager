import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { NewVehicleTripForm } from "./NewVehicleTripForm";

export default async function NewVehicleTripPage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "vehicle_trips.create"))) {
    notFound();
  }

  return <NewVehicleTripForm />;
}
