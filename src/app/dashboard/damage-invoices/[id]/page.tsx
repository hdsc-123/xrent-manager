import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getDamageInvoiceWithDetails } from "@/lib/damage-invoices";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/format";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { DamageInvoiceActions } from "./DamageInvoiceActions";

interface PageProps {
  params: Promise<{ id: string }>;
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Brouillon",
  SENT: "Envoyée",
  PARTIALLY_PAID: "Partiellement payée",
  PAID: "Payée",
  CANCELLED: "Annulée",
};

const METHOD_LABELS: Record<string, string> = {
  CASH: "Espèces",
  CARD: "Carte",
  BANK_TRANSFER: "Virement",
  CHECK: "Chèque",
  OTHER: "Autre",
};

/**
 * Sprint 33 (DOMAINRULES.md section 48) — détail d'une facture de dégâts : lignes snapshot
 * (immuables, jamais recalculées depuis le Damage vivant), historique des paiements, contrat/
 * client/véhicule/agence. Aucune seconde source de vérité : tout est lu depuis DamageInvoice/
 * DamageInvoiceLine (via getDamageInvoiceWithDetails, src/lib/damage-invoices.ts).
 */
export default async function DamageInvoiceDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "damage_invoices.view"))) {
    notFound();
  }

  const invoice = await getDamageInvoiceWithDetails(user.tenantId, id);
  if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) {
    notFound();
  }

  const [client, location, agency, canPay, canCancel, canExport] = await Promise.all([
    prisma.client.findUnique({ where: { id: invoice.clientId } }),
    prisma.location.findUnique({ where: { id: invoice.locationId }, include: { vehicle: true } }),
    prisma.agency.findUnique({ where: { id: invoice.agencyId }, select: { name: true } }),
    can(user, "damage_invoices.payment.create"),
    can(user, "damage_invoices.cancel"),
    can(user, "damage_invoices.export"),
  ]);

  const remainingBalance = invoice.totalAmount - invoice.amountPaid;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">{invoice.number}</h1>
          <p className="text-sm text-muted-foreground">Client : {client?.name ?? "—"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{STATUS_LABELS[invoice.status] ?? invoice.status}</Badge>
          {canExport && (
            <Button
              render={<a href={`/api/damage-invoices/${invoice.id}/pdf`} target="_blank" rel="noreferrer" />}
              variant="outline"
              size="sm"
            >
              <Download className="size-4" />
              PDF
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Détails</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm">
          {location?.contractNumber && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">N° contrat</p>
              <p>
                <Link href={`/dashboard/locations/${location.id}`} className="text-primary hover:underline">
                  {location.contractNumber}
                </Link>
              </p>
            </div>
          )}
          <div>
            <p className="text-xs font-medium text-muted-foreground">Véhicule</p>
            <p>{location ? `${location.vehicle.name} (${location.vehicle.licensePlate})` : "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Agence</p>
            <p>{agency?.name ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Émise le</p>
            <p>{invoice.issuedAt.toLocaleDateString("fr-FR")}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Sous-total</p>
            <p>{formatMoney(invoice.subtotal, invoice.currency)}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Total</p>
            <p className="font-medium">{formatMoney(invoice.totalAmount, invoice.currency)}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Payé</p>
            <p>{formatMoney(invoice.amountPaid, invoice.currency)}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Solde dû</p>
            <p className="font-medium">{formatMoney(remainingBalance, invoice.currency)}</p>
          </div>
          {invoice.notes && (
            <div className="col-span-2">
              <p className="text-xs font-medium text-muted-foreground">Notes</p>
              <p>{invoice.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dégâts facturés</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Nature</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium">Montant</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map((line) => (
                  <tr key={line.id} className="border-t border-border">
                    <td className="px-3 py-2">{line.nature}</td>
                    <td className="px-3 py-2">{line.description ?? "—"}</td>
                    <td className="px-3 py-2">{formatMoney(line.billableAmount, line.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Paiements</CardTitle>
        </CardHeader>
        <CardContent>
          {invoice.payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun paiement enregistré.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Méthode</th>
                    <th className="px-3 py-2 font-medium">Statut</th>
                    <th className="px-3 py-2 font-medium">Montant</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.payments.map((payment) => (
                    <tr key={payment.id} className="border-t border-border">
                      <td className="px-3 py-2">{payment.paidAt.toLocaleDateString("fr-FR")}</td>
                      <td className="px-3 py-2">{METHOD_LABELS[payment.method] ?? payment.method}</td>
                      <td className="px-3 py-2">{payment.status === "REFUNDED" ? "Remboursé" : "Actif"}</td>
                      <td className="px-3 py-2">{formatMoney(payment.amount, payment.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <DamageInvoiceActions
        id={invoice.id}
        status={invoice.status}
        remainingBalance={remainingBalance}
        currency={invoice.currency}
        canPay={canPay}
        canCancel={canCancel}
      />
    </div>
  );
}
