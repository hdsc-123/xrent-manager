-- Sprint 13E tâche 3 (règles métier de facturation, décision validée du propriétaire du projet).
-- Renommage sans perte de données : les lignes Invoice existantes conservent leur valeur de
-- statut, seul le libellé affiché change (RENAME VALUE ne réécrit aucune ligne). N'affecte que
-- l'énumération InvoiceStatus (Invoice) — DamageInvoiceStatus (DamageInvoice), qui partage les
-- mêmes libellés par coïncidence, n'est jamais touchée.
ALTER TYPE "InvoiceStatus" RENAME VALUE 'SENT' TO 'ISSUED';
ALTER TYPE "InvoiceStatus" RENAME VALUE 'CANCELLED' TO 'VOID';

-- Isolée dans cette migration (sa propre transaction) : PostgreSQL interdit d'utiliser une
-- valeur d'enum nouvellement ajoutée dans la même transaction que celle qui l'a ajoutée. Aucune
-- autre instruction de ce fichier ne référence 'CREDIT_NOTE' — la migration suivante, dans une
-- transaction séparée, est libre de l'utiliser (contrainte CHECK, valeurs par défaut, etc.).
ALTER TYPE "InvoiceStatus" ADD VALUE 'CREDIT_NOTE';
