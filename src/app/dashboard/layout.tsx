import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { getTenantById } from "@/lib/db";
import { DashboardLayout } from "@/components/layout/DashboardLayout";

export default async function DashboardRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login");
  }

  const tenant = await getTenantById(user.tenantId);

  return (
    <DashboardLayout tenantName={tenant?.name ?? ""} user={user}>
      {children}
    </DashboardLayout>
  );
}
