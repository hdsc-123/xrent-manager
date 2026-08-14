import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { NewInvoiceForm } from "./NewInvoiceForm";

export default async function NewInvoicePage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "invoices.create"))) {
    notFound();
  }

  return <NewInvoiceForm />;
}
