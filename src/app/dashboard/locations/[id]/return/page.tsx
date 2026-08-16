import { notFound } from "next/navigation";
import { getSessionUser, canAccessLocationAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getLocationById } from "@/lib/locations";
import { getDamages } from "@/lib/damages";
import { prisma } from "@/lib/prisma";
import { ReturnLocationPanel } from "./ReturnLocationPanel";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Sprint 32 (DOMAINRULES.md section 32) — écran de retour d'un contrat. Server Component :
 * authentification/permissions/portée agence vérifiées ici, jamais côté client seul (voir
 * ReturnLocationPanel.tsx). Toutes les données affichées (récapitulatif, dégâts existants,
 * solde restant du contrat) sont dérivées côté serveur — le panneau client ne fait qu'afficher
 * ce qui lui est transmis et appeler les routes déjà validées. Sprint 33 (DOMAINRULES.md
 * section 48) : POST /api/damages/[id]/payments retiré (paiement direct de dégât sans facture) —
 * tout paiement de dégât passe désormais par POST /api/locations/[id]/return
 * (damageInvoicePaymentLines) ou POST /api/damage-invoices/[id]/payments.
 */
export default async function ReturnLocationPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  // locations.complete est la permission qui autorise le retour lui-même (réutilisée telle
  // quelle, voir DOMAINRULES.md section 32) — une permission UI n'est jamais une preuve
  // d'autorisation : POST /api/locations/[id]/return revérifie exactement la même chose.
  if (!(await can(user, "locations.complete"))) {
    notFound();
  }

  const location = await getLocationById(user.tenantId, id);
  if (!location || !(await canAccessLocationAgency(user, location))) {
    notFound();
  }

  const [client, vehicle, invoice, damages] = await Promise.all([
    prisma.client.findUnique({ where: { id: location.clientId }, select: { name: true } }),
    prisma.vehicle.findUnique({ where: { id: location.vehicleId }, select: { name: true, licensePlate: true } }),
    prisma.invoice.findFirst({ where: { locationId: location.id }, orderBy: { createdAt: "desc" } }),
    getDamages(user.tenantId, { locationId: location.id }),
  ]);

  // Sprint 33 (DOMAINRULES.md section 48) : le solde par dégât n'existe plus — un dégât facturé
  // est rattaché à une DamageInvoice (solde/paiements consultables sur son propre écran dédié,
  // /dashboard/damage-invoices/[id]) ; cette page se contente de résoudre le numéro de facture
  // pour l'affichage d'un lien, sans dupliquer le calcul de solde.
  const damageInvoiceIds = damages.map((damage) => damage.damageInvoiceId).filter((id): id is string => id !== null);
  const damageInvoices =
    damageInvoiceIds.length > 0
      ? await prisma.damageInvoice.findMany({ where: { id: { in: damageInvoiceIds } }, select: { id: true, number: true } })
      : [];
  const damageInvoiceNumberById = new Map(damageInvoices.map((invoice) => [invoice.id, invoice.number]));

  const canOverrideReturnTime = await can(user, "locations.return_time.edit");
  const canCreateDamages = await can(user, "damages.create");

  return (
    <ReturnLocationPanel
      locationId={location.id}
      status={location.status}
      contractNumber={location.contractNumber}
      clientName={client?.name ?? "—"}
      vehicleLabel={vehicle ? `${vehicle.name} (${vehicle.licensePlate})` : "—"}
      startDate={location.startDate.toISOString()}
      endDate={location.endDate.toISOString()}
      actualReturnAt={location.actualReturnAt ? location.actualReturnAt.toISOString() : null}
      startOdometer={location.startOdometer}
      startFuelLevel={location.startFuelLevel}
      totalAmount={invoice?.totalAmount ?? null}
      amountPaid={invoice?.amountPaid ?? null}
      currency={location.currency}
      serverNowIso={new Date().toISOString()}
      canOverrideReturnTime={canOverrideReturnTime}
      canCreateDamages={canCreateDamages}
      damages={damages.map((damage) => ({
        id: damage.id,
        nature: damage.nature,
        description: damage.description,
        billableAmount: damage.billableAmount,
        currency: damage.currency,
        status: damage.status,
        damageInvoiceId: damage.damageInvoiceId,
        damageInvoiceNumber: damage.damageInvoiceId ? (damageInvoiceNumberById.get(damage.damageInvoiceId) ?? null) : null,
      }))}
    />
  );
}
