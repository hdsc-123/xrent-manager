import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { getSessionUser, canAccessAgency } from "@/lib/authz";
import { can } from "@/lib/permissions";
import {
  getInvoiceById,
  getInvoiceVersionHistory,
  getInvoiceNetAmounts,
  getCreditNoteRefundableAmount,
  getCreditNotesForSource,
  isCreditNoteEligibleSource,
} from "@/lib/invoices";
import { getLocationUpgradeByLocationId } from "@/lib/location-upgrades";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/format";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Icon } from "@/components/ui";
import { InvoiceActions } from "./InvoiceActions";
import { CreateCreditNoteButton } from "./CreateCreditNoteButton";
import { RefundCreditNoteButton } from "./RefundCreditNoteButton";

interface PageProps {
  params: Promise<{ id: string }>;
}

// Sprint 13E tâche 3 : Record<string, string> (pas Record<InvoiceStatus, string>) — tsc ne
// détecte donc pas une clé obsolète ici, vérifié manuellement lors du renommage.
const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Brouillon",
  ISSUED: "Envoyée",
  PARTIALLY_PAID: "Partiellement payée",
  PAID: "Payée",
  VOID: "Annulée",
  CREDIT_NOTE: "Avoir",
};

const METHOD_LABELS: Record<string, string> = {
  CASH: "Espèces",
  CARD: "Carte",
  BANK_TRANSFER: "Virement",
  CHECK: "Chèque",
  OTHER: "Autre",
};

// Mêmes libellés que UPGRADE_TYPE_OPTIONS (ConvertReservationForm.tsx), raccourcis pour
// l'affichage en lecture seule (contexte déjà donné par le titre de la carte).
const UPGRADE_TYPE_LABELS: Record<string, string> = {
  CUSTOMER_REQUEST: "Demande du client",
  UNAVAILABILITY: "Indisponibilité de la catégorie réservée",
  COMMERCIAL_GESTURE: "Geste commercial",
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

  const [client, location, payments, canEdit, canDelete, canCreatePayment, canVersion, versionHistory] =
    await Promise.all([
      prisma.client.findUnique({ where: { id: invoice.clientId } }),
      prisma.location.findUnique({ where: { id: invoice.locationId }, include: { vehicle: true } }),
      prisma.payment.findMany({ where: { invoiceId: invoice.id }, orderBy: { paidAt: "desc" } }),
      can(user, "invoices.edit"),
      can(user, "invoices.delete"),
      can(user, "payments.create"),
      can(user, "invoices.version"),
      getInvoiceVersionHistory(user.tenantId, invoice.id),
    ]);

  // Sous-phase 2c2-D : un avoir (CREDIT_NOTE) et une facture ordinaire divergent complètement
  // dans les données dérivées à afficher — jamais la même formule (invoice.totalAmount -
  // invoice.amountPaid) réutilisée pour les deux, voir DOMAINRULES.md section 56/57.
  // "Créer un avoir"/"Rembourser" sont réservés ADMIN strict (dérivé de user.role, jamais une
  // permission granulaire — même principe que les routes POST .../credit-notes et .../refund) :
  // ce n'est qu'un confort d'affichage, les deux routes revalident indépendamment côté serveur.
  const isAdmin = user.role === "ADMIN";
  const isCreditNote = invoice.type === "CREDIT_NOTE";

  const sourceInvoice = isCreditNote && invoice.originalInvoiceId
    ? await prisma.invoice.findUnique({ where: { id: invoice.originalInvoiceId } })
    : null;

  const creditNoteAmounts = sourceInvoice ? await getCreditNoteRefundableAmount(invoice, sourceInvoice) : null;
  const sourceNetAmounts = sourceInvoice ? await getInvoiceNetAmounts(sourceInvoice) : null;

  const netAmounts = !isCreditNote ? await getInvoiceNetAmounts(invoice) : null;
  const creditNotes = !isCreditNote ? await getCreditNotesForSource(user.tenantId, invoice.id) : [];
  const canCreateCreditNote = !isCreditNote && isAdmin && isCreditNoteEligibleSource(invoice);

  const upgrade = location ? await getLocationUpgradeByLocationId(user.tenantId, location.id) : null;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">
            {invoice.number}
            {invoice.versionNumber > 1 && (
              <span className="ml-2 text-base font-normal text-muted-foreground">Version {invoice.versionNumber}</span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">Client : {client?.name ?? "—"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{STATUS_LABELS[invoice.status] ?? invoice.status}</Badge>
          <Button
            render={<a href={`/api/invoices/${invoice.id}/pdf`} target="_blank" rel="noreferrer" />}
            variant="outline"
            size="sm"
          >
            <Icon icon={Download} className="size-4" />
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
            <p className="text-xs font-medium text-muted-foreground">
              {isCreditNote ? "Montant de l'avoir" : "Total"}
            </p>
            <p className="font-medium">{formatMoney(invoice.totalAmount, invoice.currency)}</p>
          </div>
          {!isCreditNote && (
            <>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Payé</p>
                <p>{formatMoney(invoice.amountPaid, invoice.currency)}</p>
              </div>
              {netAmounts && netAmounts.creditedAmount > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Crédité (avoirs)</p>
                  <p>{formatMoney(netAmounts.creditedAmount, invoice.currency)}</p>
                </div>
              )}
              <div>
                <p className="text-xs font-medium text-muted-foreground">Solde dû</p>
                <p className="font-medium">
                  {formatMoney(netAmounts ? netAmounts.remainingBalance : invoice.totalAmount - invoice.amountPaid, invoice.currency)}
                </p>
              </div>
            </>
          )}
          {isCreditNote && (
            <div className="col-span-2">
              <p className="text-xs font-medium text-muted-foreground">Motif</p>
              <p>{invoice.reason ?? "—"}</p>
            </div>
          )}
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

      {upgrade && (
        <Card>
          <CardHeader>
            <CardTitle>Surclassement</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 text-sm">
            <div className="col-span-2">
              <p className="text-xs font-medium text-muted-foreground">Type</p>
              <p>{UPGRADE_TYPE_LABELS[upgrade.type] ?? upgrade.type}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Catégorie réservée</p>
              <p>{upgrade.reservedCategory}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Catégorie attribuée</p>
              <p>{upgrade.assignedCategory}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Supplément / jour</p>
              <p>{formatMoney(upgrade.dailySupplement, upgrade.currency)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Jours concernés</p>
              <p>{upgrade.daysCount}</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs font-medium text-muted-foreground">Total du supplément</p>
              <p className="font-medium">{formatMoney(upgrade.totalSupplement, upgrade.currency)}</p>
              <p className="text-xs text-muted-foreground">Déjà inclus dans le total ci-dessus.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {isCreditNote && sourceInvoice && creditNoteAmounts && sourceNetAmounts && (
        <Card>
          <CardHeader>
            <CardTitle>Facture source et remboursement</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Facture source</p>
              <p>
                <Link href={`/dashboard/invoices/${sourceInvoice.id}`} className="text-primary hover:underline">
                  {sourceInvoice.number}
                </Link>
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Total de la facture source</p>
              <p>{formatMoney(sourceInvoice.totalAmount, sourceInvoice.currency)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Encaissé sur la source</p>
              <p>{formatMoney(sourceInvoice.amountPaid, sourceInvoice.currency)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Solde net de la source</p>
              <p>{formatMoney(sourceNetAmounts.remainingBalance, sourceInvoice.currency)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Déjà remboursé (cet avoir)</p>
              <p>{formatMoney(creditNoteAmounts.totalRefundedForCreditNote, invoice.currency)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Encore remboursable (cet avoir)</p>
              <p className="font-medium">{formatMoney(creditNoteAmounts.refundableAmount, invoice.currency)}</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs font-medium text-muted-foreground">Statut de remboursement</p>
              <p>
                {creditNoteAmounts.totalRefundedForCreditNote <= 0
                  ? "Non remboursé"
                  : creditNoteAmounts.totalRefundedForCreditNote < invoice.totalAmount
                    ? "Partiellement remboursé"
                    : "Remboursé intégralement"}
              </p>
            </div>
          </CardContent>
          {isAdmin && creditNoteAmounts.refundableAmount > 0 && (
            <CardContent className="pt-0">
              <RefundCreditNoteButton
                creditNoteId={invoice.id}
                refundableAmount={creditNoteAmounts.refundableAmount}
                currency={invoice.currency}
              />
            </CardContent>
          )}
        </Card>
      )}

      {!isCreditNote && (
        <Card>
          <CardHeader>
            <CardTitle>Avoirs</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {creditNotes.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun avoir émis sur cette facture.</p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Numéro</th>
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Motif</th>
                      <th className="px-3 py-2 font-medium">Montant</th>
                      <th className="px-3 py-2 font-medium">Statut de remboursement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {creditNotes.map((creditNote) => (
                      <tr key={creditNote.id} className="border-t border-border">
                        <td className="px-3 py-2">
                          <Link href={`/dashboard/invoices/${creditNote.id}`} className="text-primary hover:underline">
                            {creditNote.number}
                          </Link>
                        </td>
                        <td className="px-3 py-2">{creditNote.createdAt.toLocaleDateString("fr-FR")}</td>
                        <td className="px-3 py-2">{creditNote.reason ?? "—"}</td>
                        <td className="px-3 py-2">{formatMoney(creditNote.totalAmount, creditNote.currency)}</td>
                        <td className="px-3 py-2">
                          {creditNote.refundedAmount <= 0
                            ? "Non remboursé"
                            : creditNote.refundedAmount < creditNote.totalAmount
                              ? "Partiellement remboursé"
                              : "Remboursé intégralement"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {canCreateCreditNote && netAmounts && (
              <CreateCreditNoteButton
                sourceInvoiceId={invoice.id}
                remainingCredit={netAmounts.netAmount}
                currency={invoice.currency}
              />
            )}
          </CardContent>
        </Card>
      )}

      {!isCreditNote && (
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
      )}

      {versionHistory.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Historique des versions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Version</th>
                    <th className="px-3 py-2 font-medium">Numéro</th>
                    <th className="px-3 py-2 font-medium">Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {versionHistory.map((version) => (
                    <tr key={version.id} className="border-t border-border">
                      <td className="px-3 py-2">{version.versionNumber}</td>
                      <td className="px-3 py-2">
                        {version.id === invoice.id ? (
                          version.number
                        ) : (
                          <Link href={`/dashboard/invoices/${version.id}`} className="text-primary hover:underline">
                            {version.number}
                          </Link>
                        )}
                      </td>
                      <td className="px-3 py-2">{STATUS_LABELS[version.status] ?? version.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <InvoiceActions
        id={invoice.id}
        status={invoice.status}
        // Sous-phase 2c2-D : solde net après avoirs (getInvoiceNetAmounts), jamais
        // invoice.totalAmount - invoice.amountPaid seul — sinon le pré-contrôle client
        // autoriserait un montant supérieur à ce que le serveur accepte réellement
        // (createPaymentLocked/createMixedPaymentsLocked plafonnent déjà sur ce même netAmount,
        // src/lib/payments.ts). Toujours 0 pour un avoir (aucun paiement n'est jamais possible
        // sur une CREDIT_NOTE, voir src/lib/payments.ts) — désactive de fait le bouton paiement.
        remainingBalance={netAmounts ? netAmounts.remainingBalance : 0}
        currency={invoice.currency}
        canEdit={canEdit}
        canDelete={canDelete}
        canCreatePayment={canCreatePayment}
        canVersion={canVersion}
      />
    </div>
  );
}
