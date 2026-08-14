import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { NewVehicleTransferForm } from "./NewVehicleTransferForm";

export default async function NewVehicleTransferPage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "vehicle_transfers.create"))) {
    notFound();
  }

  return <NewVehicleTransferForm />;
}
