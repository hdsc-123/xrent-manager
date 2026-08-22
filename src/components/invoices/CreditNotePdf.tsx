import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";

/** Montants en plus petite unité monétaire (centimes) — voir src/lib/format.ts. */
function formatMoneyPdf(amountInSmallestUnit: number, currency: string): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(amountInSmallestUnit / 100);
}

function formatDatePdf(date: Date): string {
  return date.toLocaleDateString("fr-FR");
}

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", color: "#1a1a1a" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 24 },
  tenantName: { fontSize: 16, fontWeight: 700 },
  agencyName: { fontSize: 10, color: "#555555", marginTop: 2 },
  invoiceTitle: { fontSize: 20, fontWeight: 700, textAlign: "right" },
  invoiceMeta: { fontSize: 10, color: "#555555", textAlign: "right", marginTop: 4 },
  section: { marginBottom: 16 },
  sectionTitle: { fontSize: 9, color: "#888888", marginBottom: 4, textTransform: "uppercase" },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
  totalsBlock: { marginTop: 16, alignItems: "flex-end" },
  totalsRow: { flexDirection: "row", width: 260, justifyContent: "space-between", paddingVertical: 3 },
  totalsLabel: { color: "#555555" },
  grandTotalRow: {
    flexDirection: "row",
    width: 260,
    justifyContent: "space-between",
    paddingTop: 6,
    marginTop: 4,
    borderTop: "1 solid #1a1a1a",
  },
  grandTotalLabel: { fontWeight: 700 },
  grandTotalValue: { fontWeight: 700 },
  statusBanner: {
    marginTop: 16,
    padding: 8,
    borderRadius: 4,
    border: "1 solid #dddddd",
    backgroundColor: "#f5f5f5",
  },
  statusText: { fontWeight: 700 },
  notes: { marginTop: 24, fontSize: 9, color: "#555555" },
});

export interface CreditNotePdfProps {
  tenantName: string;
  agencyName: string;
  /** Numéro de l'avoir lui-même (jamais celui de la facture source). */
  creditNoteNumber: string;
  issuedAt: Date;
  /** Motif de l'avoir — toujours renseigné en pratique (validé à la création, createCreditNote),
   * `string | null` uniquement parce que la colonne Invoice.reason est nullable en base
   * (partagée avec l'annulation logique d'une facture ordinaire). */
  reason: string | null;
  totalAmount: number;
  currency: string;
  contractNumber: string | null;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  /** Numéro de la facture source référencée par cet avoir — toujours affiché (jamais un avoir
   * sans sa source, voir DOMAINRULES.md section 55). */
  sourceInvoiceNumber: string;
  sourceTotalAmount: number;
  sourceAmountPaid: number;
  /** Somme de TOUS les avoirs actifs de la source (pas seulement celui-ci) — voir
   * getTotalCreditedAmount, src/lib/invoices.ts. */
  sourceCreditedAmount: number;
  /** max(0, sourceTotalAmount - sourceCreditedAmount) — voir getInvoiceNetAmounts. */
  sourceNetAmount: number;
  /** Déjà remboursé pour CET avoir précis (voir getCreditNoteRefundableAmount). */
  refundedAmount: number;
  /** Encore remboursable pour CET avoir précis, à l'instant de la génération du PDF — jamais
   * une garantie figée (recalculé à chaque téléchargement, jamais stocké). */
  refundableAmount: number;
}

function refundStatusLabel(refundedAmount: number, totalAmount: number): string {
  if (refundedAmount <= 0) return "Non remboursé";
  if (refundedAmount < totalAmount) return "Partiellement remboursé";
  return "Remboursé intégralement";
}

/**
 * Gabarit PDF dédié à un avoir (CREDIT_NOTE) — sous-phase 2c2-D. Jamais le gabarit InvoicePdf
 * (facture ordinaire) : un avoir n'a ni jours de location, ni prix/jour, ni "solde dû" au sens
 * d'une facture à encaisser — seulement un montant, un motif, une facture source, et un statut
 * de remboursement dérivé en lecture seule (jamais stocké, jamais recalculé différemment d'ici
 * à getCreditNoteRefundableAmount/src/lib/invoices.ts). Ce composant ne lit ni n'écrit rien :
 * tous les montants sont reçus déjà calculés par l'appelant (route pdf, Phase 3).
 */
export function CreditNotePdf(props: CreditNotePdfProps) {
  const status = refundStatusLabel(props.refundedAmount, props.totalAmount);

  return (
    <Document title={`Avoir ${props.creditNoteNumber}`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.tenantName}>{props.tenantName}</Text>
            <Text style={styles.agencyName}>{props.agencyName}</Text>
          </View>
          <View>
            <Text style={styles.invoiceTitle}>AVOIR</Text>
            <Text style={styles.invoiceMeta}>{props.creditNoteNumber}</Text>
            {props.contractNumber && <Text style={styles.invoiceMeta}>Contrat {props.contractNumber}</Text>}
            <Text style={styles.invoiceMeta}>Émis le {formatDatePdf(props.issuedAt)}</Text>
          </View>
        </View>

        <View style={styles.row}>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Client</Text>
            <Text>{props.clientName}</Text>
            {props.clientEmail && <Text>{props.clientEmail}</Text>}
            {props.clientPhone && <Text>{props.clientPhone}</Text>}
          </View>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Facture source</Text>
            <Text>{props.sourceInvoiceNumber}</Text>
            <Text>Total : {formatMoneyPdf(props.sourceTotalAmount, props.currency)}</Text>
            <Text>Encaissé : {formatMoneyPdf(props.sourceAmountPaid, props.currency)}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Motif</Text>
          <Text>{props.reason ?? "—"}</Text>
        </View>

        <View style={styles.totalsBlock}>
          <View style={styles.grandTotalRow}>
            <Text style={styles.grandTotalLabel}>Montant de l&apos;avoir</Text>
            <Text style={styles.grandTotalValue}>{formatMoneyPdf(props.totalAmount, props.currency)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Total crédité sur la facture source</Text>
            <Text>{formatMoneyPdf(props.sourceCreditedAmount, props.currency)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Solde net de la facture source</Text>
            <Text>{formatMoneyPdf(props.sourceNetAmount, props.currency)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Déjà remboursé (cet avoir)</Text>
            <Text>{formatMoneyPdf(props.refundedAmount, props.currency)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Encore remboursable (cet avoir)</Text>
            <Text>{formatMoneyPdf(props.refundableAmount, props.currency)}</Text>
          </View>
        </View>

        <View style={styles.statusBanner}>
          <Text style={styles.statusText}>Statut de remboursement : {status}</Text>
          {props.refundedAmount <= 0 && (
            <Text>
              Aucun remboursement n&apos;a été effectué à ce jour pour cet avoir. Un avoir n&apos;entraîne jamais de
              remboursement automatique — seule une action de remboursement distincte, explicitement enregistrée, le
              fait apparaître ici.
            </Text>
          )}
        </View>
      </Page>
    </Document>
  );
}
