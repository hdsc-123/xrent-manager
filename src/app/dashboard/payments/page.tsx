import Link from "next/link";
import type { PaymentMethod } from "@prisma/client";
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { Button, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { PaymentsTable, type PaymentRow } from "./PaymentsTable";

const METHOD_OPTIONS: { value: PaymentMethod; label: string }[] = [
  { value: "CASH", label: "Espèces" },
  { value: "CARD", label: "Carte" },
  { value: "BANK_TRANSFER", label: "Virement" },
  { value: "CHECK", label: "Chèque" },
  { value: "OTHER", label: "Autre" },
];

const TYPE_OPTIONS = [
  { value: "LOCATION", label: "Location" },
  { value: "DEGAT", label: "Dégât" },
] as const;

interface PageProps {
  searchParams: Promise<{ method?: string; from?: string; to?: string; type?: string }>;
}

/**
 * Sprint 33 (DOMAINRULES.md section 48) — un paiement pointe désormais soit `invoiceId`
 * (locatif) soit `damageInvoiceId` (dégât), jamais les deux (contrainte CHECK, voir
 * prisma/schema.prisma). Ce listing regroupe les deux pour la recherche transversale (filtre
 * Type, badge distinct — objectif 12) mais lit chaque type depuis sa propre facture, sans jamais
 * additionner leurs montants ensemble ni traiter `include: { invoice }` comme garanti non-null
 * (un `Payment.invoiceId` null casserait `payment.invoice.number` — bug réel corrigé ce sprint,
 * la requête précédente ne scopait jamais par type et aurait planté sur un paiement de dégât).
 */
export default async function PaymentsPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "payments.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Paiements</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter les paiements.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const params = await searchParams;
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const canViewDamageInvoices = await can(user, "damage_invoices.view");
  const type = params.type === "LOCATION" || params.type === "DEGAT" ? params.type : undefined;

  const commonWhere = {
    tenantId: user.tenantId,
    ...(params.method ? { method: params.method as PaymentMethod } : {}),
    ...(params.from ? { paidAt: { gte: new Date(params.from) } } : {}),
    ...(params.to ? { paidAt: { lte: new Date(params.to) } } : {}),
  };

  const rentalPayments =
    type === "DEGAT"
      ? []
      : await prisma.payment.findMany({
          where: {
            ...commonWhere,
            invoiceId: { not: null },
            ...(accessibleAgencyIds ? { invoice: { agencyId: { in: accessibleAgencyIds } } } : {}),
          },
          include: {
            invoice: {
              select: { number: true, client: { select: { name: true } }, location: { select: { contractNumber: true } } },
            },
          },
          orderBy: { paidAt: "desc" },
        });

  // Un paiement de dégât n'est affiché ici que si l'appelant a aussi damage_invoices.view —
  // jamais un contournement de cette permission via le listing général des paiements.
  const damagePayments =
    type === "LOCATION" || !canViewDamageInvoices
      ? []
      : await prisma.payment.findMany({
          where: {
            ...commonWhere,
            damageInvoiceId: { not: null },
            ...(accessibleAgencyIds ? { damageInvoice: { agencyId: { in: accessibleAgencyIds } } } : {}),
          },
          include: {
            damageInvoice: {
              select: { number: true, client: { select: { name: true } }, location: { select: { contractNumber: true } } },
            },
          },
          orderBy: { paidAt: "desc" },
        });

  const rows: PaymentRow[] = [
    ...rentalPayments.map(
      (payment): PaymentRow => ({
        id: payment.id,
        type: "LOCATION",
        invoiceId: payment.invoiceId as string,
        invoiceNumber: payment.invoice!.number,
        contractNumber: payment.invoice!.location.contractNumber,
        clientName: payment.invoice!.client.name,
        method: payment.method,
        paidAt: payment.paidAt.toISOString(),
        amount: payment.amount,
        currency: payment.currency,
        reference: payment.reference,
      })
    ),
    ...damagePayments.map(
      (payment): PaymentRow => ({
        id: payment.id,
        type: "DEGAT",
        invoiceId: payment.damageInvoiceId as string,
        invoiceNumber: payment.damageInvoice!.number,
        contractNumber: payment.damageInvoice!.location.contractNumber,
        clientName: payment.damageInvoice!.client.name,
        method: payment.method,
        paidAt: payment.paidAt.toISOString(),
        amount: payment.amount,
        currency: payment.currency,
        reference: payment.reference,
      })
    ),
  ].sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime());

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Paiements</h1>
        <p className="text-sm text-muted-foreground">
          Paiements enregistrés manuellement — locatifs et dégâts, toujours distincts (jamais additionnés ensemble).
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3" method="get">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="type" className="text-xs font-medium text-muted-foreground">
            Type
          </label>
          <select
            id="type"
            name="type"
            defaultValue={params.type ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Tous</option>
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="method" className="text-xs font-medium text-muted-foreground">
            Méthode
          </label>
          <select
            id="method"
            name="method"
            defaultValue={params.method ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Toutes</option>
            {METHOD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="from" className="text-xs font-medium text-muted-foreground">
            Du
          </label>
          <input
            id="from"
            type="date"
            name="from"
            defaultValue={params.from ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="to" className="text-xs font-medium text-muted-foreground">
            Au
          </label>
          <input
            id="to"
            type="date"
            name="to"
            defaultValue={params.to ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </div>

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {(params.method || params.from || params.to || params.type) && (
          <Button render={<Link href="/dashboard/payments" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      <PaymentsTable payments={rows} />
    </div>
  );
}
