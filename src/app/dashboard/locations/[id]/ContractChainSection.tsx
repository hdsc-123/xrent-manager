import Link from "next/link";
import type { LocationChainResult, LocationChainNode } from "@/lib/location-chains";
import { formatMoney } from "@/lib/format";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { StatusBadge } from "@/components/ui/StatusBadge";

/**
 * Sprint technique 2 (DOMAINRULES.md section 60, règle 12) : affichage de la chaîne
 * contractuelle et des soldes (individuel par contrat + consolidé de la chaîne). Composant de
 * présentation pur (Server Component, aucune donnée chargée ici) — toute la lecture/le filtrage
 * tenant+agence+solde est fait en amont par getLocationChain (src/lib/location-chains.ts),
 * appelé depuis page.tsx. Ne révèle jamais aucun champ (numéro, dates, montants, véhicule,
 * agence) d'un contrat de la chaîne auquel l'utilisateur n'a pas accès — seul un compte agrégé
 * (`hiddenCount`/`hiddenChildrenCount`) est affiché pour ces contrats-là.
 */

const KIND_LABELS: Record<string, string> = {
  INITIAL: "Initial",
  EXTENSION: "Prolongation",
};

function ContractLink({ node, label }: { node: LocationChainNode; label?: string }) {
  if (node.isCurrent) {
    return (
      <span className="font-medium">
        {label ?? node.contractNumber ?? `Location #${node.id.slice(-8)}`}
        <span className="ml-1.5 text-xs text-muted-foreground">(contrat actuel)</span>
      </span>
    );
  }
  return (
    <Link href={`/dashboard/locations/${node.id}`} className="font-medium text-primary hover:underline">
      {label ?? node.contractNumber ?? `Location #${node.id.slice(-8)}`}
    </Link>
  );
}

function RestrictedNote() {
  return <p className="text-sm text-muted-foreground">Accès restreint (agence non autorisée).</p>;
}

function ChainNodeSummary({ node }: { node: LocationChainNode }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <ContractLink node={node} />
        <Badge variant="outline">{KIND_LABELS[node.contractKind] ?? node.contractKind}</Badge>
        <StatusBadge status={node.status} />
      </div>
      <p className="text-muted-foreground">
        {node.vehicleLabel} · {node.agencyName}
      </p>
      <p className="text-muted-foreground">
        {node.startDate.toLocaleString("fr-FR")} → {node.endDate.toLocaleString("fr-FR")}
      </p>
      <p>
        Total {formatMoney(node.totalPrice, node.currency)} · Solde{" "}
        <span className={node.balance.remainingBalance > 0 ? "font-medium text-destructive" : "font-medium"}>
          {formatMoney(node.balance.remainingBalance, node.currency)}
        </span>
      </p>
    </div>
  );
}

export function ContractChainSection({ chain }: { chain: LocationChainResult }) {
  const isEmptyChain = chain.nodes.length <= 1 && chain.hiddenCount === 0;
  const consolidatedEntries = Object.entries(chain.consolidated);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Chaîne contractuelle</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">Contrat parent</p>
            {chain.parent ? (
              <ChainNodeSummary node={chain.parent} />
            ) : chain.parentRestricted ? (
              <RestrictedNote />
            ) : (
              <p className="text-sm text-muted-foreground">Aucun (contrat initial).</p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">Contrat racine</p>
            {chain.root ? (
              <ChainNodeSummary node={chain.root} />
            ) : chain.rootRestricted ? (
              <RestrictedNote />
            ) : (
              <p className="text-sm text-muted-foreground">Ce contrat est déjà le contrat racine.</p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Prolongations directes</p>
          {chain.children.length > 0 ? (
            <div className="flex flex-col gap-3">
              {chain.children.map((child) => (
                <ChainNodeSummary key={child.id} node={child} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Aucune prolongation.</p>
          )}
          {chain.hiddenChildrenCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {chain.hiddenChildrenCount} prolongation(s) supplémentaire(s) non accessible(s) avec vos permissions actuelles.
            </p>
          )}
        </div>

        {isEmptyChain ? (
          <p className="text-sm text-muted-foreground">
            Ce contrat ne fait partie d&apos;aucune chaîne de prolongation.
          </p>
        ) : (
          <div className="flex flex-col gap-3 border-t pt-4">
            <p className="text-xs font-medium text-muted-foreground">Chaîne complète ({chain.nodes.length} contrat(s))</p>
            <div className="flex flex-col divide-y">
              {chain.nodes.map((node) => (
                <div key={node.id} className="py-3 first:pt-0 last:pb-0">
                  <ChainNodeSummary node={node} />
                </div>
              ))}
            </div>
          </div>
        )}

        {chain.hiddenCount > 0 && (
          <p className="text-xs text-muted-foreground">
            {chain.hiddenCount} contrat(s) de cette chaîne ne sont pas accessibles avec vos permissions actuelles — non
            inclus dans le solde consolidé ci-dessous.
          </p>
        )}

        <div className="flex flex-col gap-2 border-t pt-4">
          <p className="text-xs font-medium text-muted-foreground">Solde consolidé de la chaîne</p>
          {consolidatedEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun contrat accessible.</p>
          ) : (
            consolidatedEntries.map(([currency, totals]) => (
              <div key={currency} className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground">Facturé ({totals.contractCount} contrat(s))</p>
                  <p>{formatMoney(totals.totalInvoiced, currency)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Payé</p>
                  <p>{formatMoney(totals.totalPaid, currency)}</p>
                </div>
                {totals.totalCredited > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground">Avoirs</p>
                    <p>{formatMoney(totals.totalCredited, currency)}</p>
                  </div>
                )}
                {totals.totalRefunded > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground">Remboursé</p>
                    <p>{formatMoney(totals.totalRefunded, currency)}</p>
                  </div>
                )}
                <div>
                  <p className="text-xs text-muted-foreground">Solde consolidé</p>
                  <p className={totals.remainingBalance > 0 ? "font-medium text-destructive" : "font-medium"}>
                    {formatMoney(totals.remainingBalance, currency)}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
