import Link from "next/link";
import { Plus } from "lucide-react";
import type { InvoiceStatus, DamageInvoiceStatus } from "@prisma/client";
// Sprint 13E tâche 3 (correctif) : même liste que src/app/api/damage-invoices/route.ts —
// nécessaire depuis le renommage InvoiceStatus.SENT/CANCELLED -> ISSUED/VOID, voir le
// commentaire détaillé plus bas sur le filtre Statut partagé par les deux sections de cette
// page.
const DAMAGE_INVOICE_STATUSES: DamageInvoiceStatus[] = ["DRAFT", "SENT", "PARTIALLY_PAID", "PAID", "CANCELLED"];
import { getSessionUser, getAccessibleAgencyIds } from "@/lib/authz";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getDamageInvoices } from "@/lib/damage-invoices";
import { Button, Card, CardDescription, CardHeader, CardTitle, Icon } from "@/components/ui";
import { InvoicesTable, type InvoiceRow } from "./InvoicesTable";

// Sprint 13E tâche 3 : ISSUED/VOID (ex-SENT/CANCELLED) — voir le commentaire sur le filtre
// combiné Invoice/DamageInvoice plus bas : ces deux valeurs ne correspondent plus à rien côté
// DamageInvoiceStatus (resté SENT/CANCELLED), contrairement à DRAFT/PARTIALLY_PAID/PAID qui
// restent partagées entre les deux énumérations.
const STATUS_OPTIONS: { value: InvoiceStatus; label: string }[] = [
  { value: "DRAFT", label: "Brouillon" },
  { value: "ISSUED", label: "Envoyée" },
  { value: "PARTIALLY_PAID", label: "Partiellement payée" },
  { value: "PAID", label: "Payée" },
  { value: "VOID", label: "Annulée" },
];

const TYPE_OPTIONS = [
  { value: "LOCATION", label: "Location" },
  { value: "DEGAT", label: "Dégât" },
] as const;

interface PageProps {
  searchParams: Promise<{ status?: string; from?: string; to?: string; showHistory?: string; type?: string }>;
}

/**
 * Sprint 33 (DOMAINRULES.md section 48, objectif 12) — regroupe factures locatives (Invoice) et
 * factures de dégâts (DamageInvoice) pour la recherche transversale (filtre Type, badge distinct,
 * numéro FACT-DEG visible), sans jamais les confondre : deux requêtes séparées, deux totaux
 * jamais additionnés (le tableau affiche chaque ligne avec son propre montant, aucune somme
 * globale calculée sur cet écran) — une DamageInvoice s'ouvre toujours dans son écran dédié
 * (/dashboard/damage-invoices/[id]), jamais dans /dashboard/invoices/[id].
 */
export default async function InvoicesPage({ searchParams }: PageProps) {
  const user = await getSessionUser();
  if (!user) return null;

  if (!(await can(user, "invoices.view"))) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Factures</CardTitle>
          <CardDescription>Vous n&apos;avez pas la permission de consulter les factures.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const params = await searchParams;
  const accessibleAgencyIds = await getAccessibleAgencyIds(user);
  const canViewDamageInvoices = await can(user, "damage_invoices.view");
  const type = params.type === "LOCATION" || params.type === "DEGAT" ? params.type : undefined;
  // Sprint 26E : masque par défaut les factures remplacées par une nouvelle version —
  // comportement propre à cet écran uniquement, jamais un changement du comportement par défaut
  // de GET /api/invoices/getInvoices (voir src/lib/invoices.ts, filtre excludeReplaced, jamais
  // appliqué sans opt-in explicite). Filtre sur la relation inverse `replacedBy` (aucune colonne
  // physique dupliquée — voir prisma/schema.prisma, Invoice.replacesInvoiceId).
  const showHistory = params.showHistory === "true";

  const invoices =
    type === "DEGAT"
      ? []
      : await prisma.invoice.findMany({
          where: {
            tenantId: user.tenantId,
            ...(accessibleAgencyIds ? { agencyId: { in: accessibleAgencyIds } } : {}),
            ...(params.status ? { status: params.status as InvoiceStatus } : {}),
            ...(params.from ? { issuedAt: { gte: new Date(params.from) } } : {}),
            ...(params.to ? { issuedAt: { lte: new Date(params.to) } } : {}),
            ...(showHistory ? {} : { replacedBy: null }),
          },
          include: { client: { select: { name: true } }, location: { select: { contractNumber: true } } },
          orderBy: { issuedAt: "desc" },
        });

  const damageInvoices =
    type === "LOCATION" || !canViewDamageInvoices
      ? []
      : await getDamageInvoices(user.tenantId, {
          agencyIds: accessibleAgencyIds,
          // Sprint 13E tâche 3 (correctif nécessaire, pas une nouvelle fonctionnalité) :
          // DamageInvoiceStatus (SENT/CANCELLED, inchangé) et InvoiceStatus (renommé ISSUED/VOID)
          // ne partagent plus le même jeu de valeurs — seuls DRAFT/PARTIALLY_PAID/PAID restent
          // communs. Avant ce correctif, un simple `as InvoiceStatus` laissait passer n'importe
          // quelle valeur de params.status telle quelle vers getDamageInvoices ; avec l'ancien
          // enum (identique à DamageInvoiceStatus), ça ne posait pas de problème. Depuis le
          // renommage, sélectionner "Envoyée"/"Annulée" (ISSUED/VOID) sur cette page enverrait
          // une valeur invalide pour DamageInvoiceStatus à Prisma — érreur runtime (Prisma valide
          // les enums côté client avant la requête), pas un simple résultat vide. D'où la
          // validation explicite ci-dessous (même liste/idiome que
          // src/app/api/damage-invoices/route.ts, DAMAGE_INVOICE_STATUSES) : la section Dégâts
          // ignore silencieusement un filtre Statut qui ne lui correspond pas (affiche alors tous
          // les statuts pour ce cas précis) plutôt que de planter la page — comportement dégradé
          // documenté, pas une extension du filtre.
          status:
            params.status && DAMAGE_INVOICE_STATUSES.includes(params.status as DamageInvoiceStatus)
              ? (params.status as DamageInvoiceStatus)
              : undefined,
          from: params.from ? new Date(params.from) : undefined,
          to: params.to ? new Date(params.to) : undefined,
        });
  const damageInvoiceLocationIds = damageInvoices.map((invoice) => invoice.locationId);
  const damageInvoiceLocations =
    damageInvoiceLocationIds.length > 0
      ? await prisma.location.findMany({
          where: { id: { in: damageInvoiceLocationIds } },
          select: { id: true, contractNumber: true },
        })
      : [];
  const contractNumberByLocationId = new Map(damageInvoiceLocations.map((location) => [location.id, location.contractNumber]));
  const damageInvoiceClientIds = damageInvoices.map((invoice) => invoice.clientId);
  const damageInvoiceClients =
    damageInvoiceClientIds.length > 0
      ? await prisma.client.findMany({ where: { id: { in: damageInvoiceClientIds } }, select: { id: true, name: true } })
      : [];
  const clientNameById = new Map(damageInvoiceClients.map((client) => [client.id, client.name]));

  const rows: InvoiceRow[] = [
    ...invoices.map(
      (invoice): InvoiceRow => ({
        id: invoice.id,
        type: "LOCATION",
        number: invoice.number,
        contractNumber: invoice.location.contractNumber,
        clientName: invoice.client.name,
        status: invoice.status,
        issuedAt: invoice.issuedAt.toISOString(),
        totalAmount: invoice.totalAmount,
        amountPaid: invoice.amountPaid,
        currency: invoice.currency,
        versionNumber: invoice.versionNumber,
      })
    ),
    ...damageInvoices.map(
      (invoice): InvoiceRow => ({
        id: invoice.id,
        type: "DEGAT",
        number: invoice.number,
        contractNumber: contractNumberByLocationId.get(invoice.locationId) ?? null,
        clientName: clientNameById.get(invoice.clientId) ?? "—",
        status: invoice.status,
        issuedAt: invoice.issuedAt.toISOString(),
        totalAmount: invoice.totalAmount,
        amountPaid: invoice.amountPaid,
        currency: invoice.currency,
        versionNumber: 1,
      })
    ),
  ].sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime());

  const canCreate = (accessibleAgencyIds === null || accessibleAgencyIds.length > 0) && (await can(user, "invoices.create"));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Factures</h1>
          <p className="text-sm text-muted-foreground">
            Factures locatives et factures de dégâts — deux documents distincts, jamais mêlés dans leurs soldes.
          </p>
        </div>
        {canCreate && (
          <Button render={<Link href="/dashboard/invoices/new" />}>
            <Icon icon={Plus} className="size-4" />
            Créer une facture
          </Button>
        )}
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
          <label htmlFor="status" className="text-xs font-medium text-muted-foreground">
            Statut
          </label>
          <select
            id="status"
            name="status"
            defaultValue={params.status ?? ""}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Tous</option>
            {STATUS_OPTIONS.map((option) => (
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
        <input type="hidden" name="showHistory" value={showHistory ? "true" : "false"} />

        <Button type="submit" variant="outline" size="sm">
          Filtrer
        </Button>
        {(params.status || params.from || params.to || params.type) && (
          <Button render={<Link href="/dashboard/invoices" />} variant="ghost" size="sm">
            Réinitialiser
          </Button>
        )}
      </form>

      {/* Sprint 26E : par défaut, seule la dernière version active de chaque facture
          versionnée est affichée — bascule explicite pour voir aussi les versions
          remplacées (CANCELLED, une autre facture pointe vers elle via replacesInvoiceId).
          Ne s'applique qu'aux factures locatives (les DamageInvoice n'ont pas de
          versionnement, voir DOMAINRULES.md section 48). */}
      <div>
        <Link
          href={{
            pathname: "/dashboard/invoices",
            query: { ...params, showHistory: showHistory ? "false" : "true" },
          }}
          className="text-sm text-primary hover:underline"
        >
          {showHistory ? "Masquer les versions remplacées" : "Afficher l'historique des versions"}
        </Link>
      </div>

      <InvoicesTable invoices={rows} />
    </div>
  );
}
