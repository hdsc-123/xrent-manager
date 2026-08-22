-- Sprint 13E tâche 3, sous-phase 2b : clés d'idempotence pour les factures additionnelles
-- SUPPLEMENT/EXTENSION. Colonnes nullables, jamais utilisées par RENTAL/CREDIT_NOTE (comportement
-- RENTAL strictement inchangé). Voir DOMAINRULES.md section 17 pour la décision complète et la
-- limite explicite documentée sur extensionEndDate (clé provisoire, pas un historique
-- d'événements d'extension).

ALTER TABLE "Invoice"
  ADD COLUMN "supplementKey" TEXT,
  ADD COLUMN "extensionEndDate" TIMESTAMP(3);

-- Cohérence type <-> champs, exhaustive sur les 4 valeurs d'InvoiceType. Défense en profondeur :
-- doublée par une validation applicative équivalente (POST /api/invoices, createSupplementInvoice/
-- createExtensionInvoice, src/lib/invoices.ts) — jamais la seule ligne de défense.
ALTER TABLE "Invoice"
ADD CONSTRAINT "Invoice_supplement_extension_fields_consistency"
CHECK (
  (
    "type" = 'SUPPLEMENT'
    AND "supplementKey" IS NOT NULL
    AND btrim("supplementKey") <> ''
    AND "extensionEndDate" IS NULL
  )
  OR (
    "type" = 'EXTENSION'
    AND "extensionEndDate" IS NOT NULL
    AND "supplementKey" IS NULL
  )
  OR (
    "type" IN ('RENTAL', 'CREDIT_NOTE')
    AND "supplementKey" IS NULL
    AND "extensionEndDate" IS NULL
  )
);

-- Idempotence — même double protection que Invoice_one_active_rental_per_location (migration
-- 20260821230601) : verrou applicatif SELECT ... FOR UPDATE sur la Location (voir
-- getOrCreateSupplementInvoice/getOrCreateExtensionInvoice) ET cet index unique partiel Postgres,
-- jamais l'un sans l'autre. VOID exclu du périmètre d'unicité active (une facture SUPPLEMENT/
-- EXTENSION annulée ne bloque plus une nouvelle facture pour la même clé métier).
CREATE UNIQUE INDEX "Invoice_one_active_supplement_per_key"
  ON "Invoice" ("locationId", "supplementKey")
  WHERE "type" = 'SUPPLEMENT'
    AND "supplementKey" IS NOT NULL
    AND "status" IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID');

CREATE UNIQUE INDEX "Invoice_one_active_extension_per_end_date"
  ON "Invoice" ("locationId", "extensionEndDate")
  WHERE "type" = 'EXTENSION'
    AND "extensionEndDate" IS NOT NULL
    AND "status" IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID');
