import { notFound } from "next/navigation";
import { getInvitationById } from "@/lib/invitations";
import { prisma } from "@/lib/prisma";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { AcceptInvitationForm } from "./AcceptInvitationForm";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function InvitationPage({ params }: PageProps) {
  const { id } = await params;
  const invitation = await getInvitationById(id);

  if (!invitation) {
    notFound();
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: invitation.tenantId }, select: { name: true } });

  if (invitation.status !== "PENDING" || invitation.expiresAt < new Date()) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invitation indisponible</CardTitle>
          <CardDescription>
            {invitation.status === "ACCEPTED"
              ? "Cette invitation a déjà été acceptée."
              : invitation.status === "DECLINED"
                ? "Cette invitation a été déclinée."
                : "Cette invitation a expiré."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <AcceptInvitationForm
      id={invitation.id}
      email={invitation.email}
      tenantName={tenant?.name ?? ""}
      role={invitation.role}
    />
  );
}
