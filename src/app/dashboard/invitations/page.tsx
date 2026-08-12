import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/authz";
import { getInvitations } from "@/lib/invitations";
import { InvitationsPanel, type InvitationRow } from "./InvitationsPanel";

export default async function InvitationsPage() {
  const user = await getSessionUser();
  if (!user) return null;

  if (user.role !== "ADMIN") {
    redirect("/dashboard");
  }

  const invitations = await getInvitations(user.tenantId);
  const rows: InvitationRow[] = invitations.map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Invitations</h1>
        <p className="text-sm text-muted-foreground">
          Aucun envoi d&apos;email pour l&apos;instant : partagez le lien généré manuellement
          avec la personne invitée.
        </p>
      </div>

      <InvitationsPanel invitations={rows} />
    </div>
  );
}
