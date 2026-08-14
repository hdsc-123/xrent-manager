import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { getInvoiceById } from "@/lib/invoices";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/format";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { InvoiceActions } from "./InvoiceActions";

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

export default async function InvoiceDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "invoices.view"))) {
    notFound();
  }

  const invoice = await getInvoiceById(user.tenantId, id);
  if (!invoice || !(await canAccessAgency(user, invoice.agencyId))) {
    notFound();
  }

  const [client, location, payments, canEdit, canDelete, canCreatePayment] = await Promise.all([
    prisma.client.findUnique({ where: { id: invoice.clientId } }),
    prisma.location.findUnique({ where: { id: invoice.locationId }, include: { vehicle: true } }),
    prisma.payment.findMany({ where: { invoiceId: invoice.id }, orderBy: { paidAt: "desc" } }),
    can(user, "invoices.edit"),
    can(user, "invoices.delete"),
    can(user, "payments.create"),
  ]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">{invoice.number}</h1>
          <p className="text-sm text-muted-foreground">Client : {client?.name ?? "—"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{STATUS_LABELS[invoice.status] ?? invoice.status}</Badge>
          <Button
            render={<a href={`/api/invoices/${invoice.id}/pdf`} target="_blank" rel="noreferrer" />}
            variant="outline"
            size="sm"
          >
            <Download className="size-4" />
            PDF
          </Button>
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
            <p className="text-xs font-medium text-muted-foreground">Location</p>
            <p>
              {location ? (
                <Link href={`/dashboard/locations/${location.id}`} className="text-primary hover:underline">
                  {location.vehicle.name} ({location.vehicle.licensePlate})
                </Link>
              ) : (
                "—"
              )}
            </p>
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
            <p className="text-xs font-medium text-muted-foreground">Remise</p>
            <p>{formatMoney(invoice.discountAmount, invoice.currency)}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">TVA ({(invoice.taxRate / 100).toFixed(2)}%)</p>
            <p>{formatMoney(invoice.taxAmount, invoice.currency)}</p>
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
            <p className="font-medium">{formatMoney(invoice.totalAmount - invoice.amountPaid, invoice.currency)}</p>
          </div>
          {invoice.dueDate && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Échéance</p>
              <p>{invoice.dueDate.toLocaleDateString("fr-FR")}</p>
            </div>
          )}
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
          <CardTitle>Paiements</CardTitle>
        </CardHeader>
        <CardContent>
          {payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun paiement enregistré.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Méthode</th>
                    <th className="px-3 py-2 font-medium">Référence</th>
                    <th className="px-3 py-2 font-medium">Montant</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((payment) => (
                    <tr key={payment.id} className="border-t border-border">
                      <td className="px-3 py-2">{payment.paidAt.toLocaleDateString("fr-FR")}</td>
                      <td className="px-3 py-2">{METHOD_LABELS[payment.method] ?? payment.method}</td>
                      <td className="px-3 py-2">{payment.reference ?? "—"}</td>
                      <td className="px-3 py-2">{formatMoney(payment.amount, payment.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <InvoiceActions
        id={invoice.id}
        status={invoice.status}
        remainingBalance={invoice.totalAmount - invoice.amountPaid}
        currency={invoice.currency}
        canEdit={canEdit}
        canDelete={canDelete}
        canCreatePayment={canCreatePayment}
      />
    </div>
  );
}
