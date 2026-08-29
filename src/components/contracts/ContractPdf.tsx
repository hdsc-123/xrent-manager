import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";

/** pricePerDay/totalPrice/deposit sont en plus petite unité monétaire (centimes) — voir src/lib/format.ts. */
function formatMoneyPdf(amountInSmallestUnit: number, currency: string): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(amountInSmallestUnit / 100);
}

function formatDatePdf(date: Date): string {
  return date.toLocaleString("fr-FR");
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: "En attente",
  CONFIRMED: "Confirmée",
  ACTIVE: "En cours",
  COMPLETED: "Terminée",
  CANCELLED: "Annulée",
};

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", color: "#1a1a1a" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 24 },
  tenantName: { fontSize: 16, fontWeight: 700 },
  agencyName: { fontSize: 10, color: "#555555", marginTop: 2 },
  docTitle: { fontSize: 20, fontWeight: 700, textAlign: "right" },
  docMeta: { fontSize: 10, color: "#555555", textAlign: "right", marginTop: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
  section: { marginBottom: 16 },
  sectionTitle: { fontSize: 9, color: "#888888", marginBottom: 4, textTransform: "uppercase" },
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
  signatures: { flexDirection: "row", justifyContent: "space-between", marginTop: 48 },
  signatureBox: { width: 200, borderTop: "1 solid #1a1a1a", paddingTop: 4, textAlign: "center", color: "#555555" },
});

export interface ContractPdfProps {
  tenantName: string;
  agencyName: string;
  contractNumber: string;
  status: string;
  createdAt: Date;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  clientIdNumber: string | null;
  clientLicenseNumber: string | null;
  vehicleName: string;
  vehicleLicensePlate: string;
  locationStart: Date;
  locationEnd: Date;
  pricePerDay: number;
  totalPrice: number;
  deposit: number | null;
  startOdometer: number | null;
  endOdometer: number | null;
  currency: string;
  notes: string | null;
  /** Surclassement (LocationUpgrade) — `null` si aucun n'a été enregistré pour ce contrat.
   * `totalSupplement` est purement descriptif ici : déjà compris dans `totalPrice` (voir
   * POST /api/reservations/[id]/convert, étape 7bis), jamais rajouté une seconde fois au total
   * affiché en bas de page. */
  upgrade: {
    typeLabel: string;
    reservedCategory: string;
    assignedCategory: string;
    dailySupplement: number;
    daysCount: number;
    totalSupplement: number;
  } | null;
}

/**
 * Template PDF du contrat (Sprint 14B) — même style visuel que InvoicePdf (pas de logo,
 * aucun asset de marque n'existe dans ce dépôt). Le numéro de contrat (Location.contractNumber)
 * est toujours présent : cette page n'est jamais rendue pour une Location sans numéro (voir
 * GET /api/locations/[id]/pdf, qui refuse la génération sinon).
 */
export function ContractPdfPage(props: ContractPdfProps) {
  const days = Math.max(
    1,
    Math.ceil((props.locationEnd.getTime() - props.locationStart.getTime()) / (24 * 60 * 60 * 1000))
  );

  return (
    <Page size="A4" style={styles.page}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.tenantName}>{props.tenantName}</Text>
          <Text style={styles.agencyName}>{props.agencyName}</Text>
        </View>
        <View>
          <Text style={styles.docTitle}>CONTRAT DE LOCATION</Text>
          <Text style={styles.docMeta}>{props.contractNumber}</Text>
          <Text style={styles.docMeta}>{STATUS_LABELS[props.status] ?? props.status}</Text>
        </View>
      </View>

      <View style={styles.row}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Client</Text>
          <Text>{props.clientName}</Text>
          {props.clientEmail && <Text>{props.clientEmail}</Text>}
          {props.clientPhone && <Text>{props.clientPhone}</Text>}
          {props.clientIdNumber && <Text>Pièce d&apos;identité : {props.clientIdNumber}</Text>}
          {props.clientLicenseNumber && <Text>Permis : {props.clientLicenseNumber}</Text>}
        </View>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Contrat</Text>
          <Text>Généré le {formatDatePdf(props.createdAt)}</Text>
          <Text>
            {formatDatePdf(props.locationStart)} → {formatDatePdf(props.locationEnd)} ({days} jour(s))
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Véhicule</Text>
        <View style={styles.table}>
          <View style={styles.tableHeaderRow}>
            <Text style={styles.colDescription}>Description</Text>
            <Text style={styles.colAmount}>Montant</Text>
          </View>
          <View style={styles.tableRow}>
            <Text style={styles.colDescription}>
              {props.vehicleName} ({props.vehicleLicensePlate}) — {days} jour(s) ×{" "}
              {formatMoneyPdf(props.pricePerDay, props.currency)}
            </Text>
            <Text style={styles.colAmount}>{formatMoneyPdf(props.totalPrice, props.currency)}</Text>
          </View>
        </View>
        {(props.startOdometer !== null || props.endOdometer !== null) && (
          <Text style={{ marginTop: 6, color: "#555555" }}>
            Kilométrage : {props.startOdometer ?? "—"} km → {props.endOdometer ?? "—"} km
          </Text>
        )}
        {props.upgrade && (
          <Text style={{ marginTop: 6, color: "#555555" }}>
            Surclassement ({props.upgrade.typeLabel}) : {props.upgrade.reservedCategory} →{" "}
            {props.upgrade.assignedCategory} — {props.upgrade.daysCount} jour(s) ×{" "}
            {formatMoneyPdf(props.upgrade.dailySupplement, props.currency)} ={" "}
            {formatMoneyPdf(props.upgrade.totalSupplement, props.currency)} (inclus dans le total)
          </Text>
        )}
      </View>

      <View style={styles.totalsBlock}>
        <View style={styles.grandTotalRow}>
          <Text style={styles.grandTotalLabel}>Total</Text>
          <Text style={styles.grandTotalValue}>{formatMoneyPdf(props.totalPrice, props.currency)}</Text>
        </View>
        {props.deposit !== null && (
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Caution</Text>
            <Text>{formatMoneyPdf(props.deposit, props.currency)}</Text>
          </View>
        )}
      </View>

      {props.notes && (
        <View style={styles.notes}>
          <Text style={styles.sectionTitle}>Notes</Text>
          <Text>{props.notes}</Text>
        </View>
      )}

      <View style={styles.signatures}>
        <Text style={styles.signatureBox}>Signature du client</Text>
        <Text style={styles.signatureBox}>Signature de l&apos;agence</Text>
      </View>
    </Page>
  );
}

export function ContractPdf(props: ContractPdfProps) {
  return (
    <Document title={`Contrat ${props.contractNumber}`}>
      <ContractPdfPage {...props} />
    </Document>
  );
}
