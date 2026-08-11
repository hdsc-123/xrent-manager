import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";

/** pricePerDay/subtotal/etc. sont en plus petite unité monétaire (centimes) — voir src/lib/format.ts. */
function formatMoneyPdf(amountInSmallestUnit: number, currency: string): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(amountInSmallestUnit / 100);
}

function formatDatePdf(date: Date): string {
  return date.toLocaleDateString("fr-FR");
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Brouillon",
  SENT: "Envoyée",
  PARTIALLY_PAID: "Partiellement payée",
  PAID: "Payée",
  CANCELLED: "Annulée",
};

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
  table: { marginTop: 8, borderTop: "1 solid #dddddd" },
  tableRow: { flexDirection: "row", paddingVertical: 6, borderBottom: "1 solid #eeeeee" },
  tableHeaderRow: { flexDirection: "row", paddingVertical: 6, borderBottom: "1 solid #dddddd" },
  colDescription: { flex: 3 },
  colAmount: { flex: 1, textAlign: "right" },
  totalsBlock: { marginTop: 16, alignItems: "flex-end" },
  totalsRow: { flexDirection: "row", width: 220, justifyContent: "space-between", paddingVertical: 3 },
  totalsLabel: { color: "#555555" },
  grandTotalRow: {
    flexDirection: "row",
    width: 220,
    justifyContent: "space-between",
    paddingTop: 6,
    marginTop: 4,
    borderTop: "1 solid #1a1a1a",
  },
  grandTotalLabel: { fontWeight: 700 },
  grandTotalValue: { fontWeight: 700 },
  notes: { marginTop: 24, fontSize: 9, color: "#555555" },
});

export interface InvoicePdfProps {
  tenantName: string;
  agencyName: string;
  invoiceNumber: string;
  status: string;
  issuedAt: Date;
  dueDate: Date | null;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  vehicleName: string;
  vehicleLicensePlate: string;
  locationStart: Date;
  locationEnd: Date;
  pricePerDay: number;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  amountPaid: number;
  currency: string;
  notes: string | null;
}

/** Template PDF simple (pas de logo image — aucun asset de marque n'existe dans ce dépôt). */
export function InvoicePdf(props: InvoicePdfProps) {
  const days = Math.max(
    1,
    Math.ceil((props.locationEnd.getTime() - props.locationStart.getTime()) / (24 * 60 * 60 * 1000))
  );
  const remainingBalance = props.totalAmount - props.amountPaid;

  return (
    <Document title={`Facture ${props.invoiceNumber}`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.tenantName}>{props.tenantName}</Text>
            <Text style={styles.agencyName}>{props.agencyName}</Text>
          </View>
          <View>
            <Text style={styles.invoiceTitle}>FACTURE</Text>
            <Text style={styles.invoiceMeta}>{props.invoiceNumber}</Text>
            <Text style={styles.invoiceMeta}>{STATUS_LABELS[props.status] ?? props.status}</Text>
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
            <Text style={styles.sectionTitle}>Facture</Text>
            <Text>Émise le {formatDatePdf(props.issuedAt)}</Text>
            {props.dueDate && <Text>Échéance le {formatDatePdf(props.dueDate)}</Text>}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Location</Text>
          <View style={styles.table}>
            <View style={styles.tableHeaderRow}>
              <Text style={styles.colDescription}>Description</Text>
              <Text style={styles.colAmount}>Montant</Text>
            </View>
            <View style={styles.tableRow}>
              <Text style={styles.colDescription}>
                {props.vehicleName} ({props.vehicleLicensePlate}) — {formatDatePdf(props.locationStart)} →{" "}
                {formatDatePdf(props.locationEnd)} ({days} jour(s) × {formatMoneyPdf(props.pricePerDay, props.currency)})
              </Text>
              <Text style={styles.colAmount}>{formatMoneyPdf(props.subtotal, props.currency)}</Text>
            </View>
          </View>
        </View>

        <View style={styles.totalsBlock}>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Sous-total</Text>
            <Text>{formatMoneyPdf(props.subtotal, props.currency)}</Text>
          </View>
          {props.discountAmount > 0 && (
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>Remise</Text>
              <Text>-{formatMoneyPdf(props.discountAmount, props.currency)}</Text>
            </View>
          )}
          {props.taxRate > 0 && (
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>TVA ({(props.taxRate / 100).toFixed(2)}%)</Text>
              <Text>{formatMoneyPdf(props.taxAmount, props.currency)}</Text>
            </View>
          )}
          <View style={styles.grandTotalRow}>
            <Text style={styles.grandTotalLabel}>Total</Text>
            <Text style={styles.grandTotalValue}>{formatMoneyPdf(props.totalAmount, props.currency)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Payé</Text>
            <Text>{formatMoneyPdf(props.amountPaid, props.currency)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Solde dû</Text>
            <Text>{formatMoneyPdf(remainingBalance, props.currency)}</Text>
          </View>
        </View>

        {props.notes && (
          <View style={styles.notes}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text>{props.notes}</Text>
          </View>
        )}
      </Page>
    </Document>
  );
}
