-- Sprint 13E tâche 3 (règles métier de facturation, décision validée du propriétaire du projet).
-- Appliquée après 20260821230547_invoice_status_rename_and_credit_note (transaction séparée) :
-- 'CREDIT_NOTE' est donc déjà une valeur utilisable de InvoiceStatus à ce stade.

-- Distingue la nature du document financier (RENTAL/SUPPLEMENT/EXTENSION/CREDIT_NOTE),
-- orthogonale au statut. Volontairement sans valeur DAMAGE : la facturation des dégâts reste
-- exclusivement gérée par DamageInvoice/DamageInvoiceLine, jamais fusionnée ici.
CREATE TYPE "InvoiceType" AS ENUM ('RENTAL', 'SUPPLEMENT', 'EXTENSION', 'CREDIT_NOTE');

-- RENTAL par défaut : toute facture déjà existante au moment de cette migration *est* déjà
-- conceptuellement une facture principale — backfill sans ambiguïté, aucune ligne perdue.
ALTER TABLE "Invoice" ADD COLUMN "type" "InvoiceType" NOT NULL DEFAULT 'RENTAL';

-- Motif obligatoire (validé côté application, jamais par une contrainte NOT NULL ici car son
-- caractère obligatoire dépend du type/de la transition) pour deux usages mutuellement
-- exclusifs dans le temps sur une même ligne : l'annulation logique (voidInvoice) et la
-- création d'un avoir (createCreditNote, jamais réécrit ensuite — un avoir est immuable).
ALTER TABLE "Invoice" ADD COLUMN "reason" TEXT;

-- Référence la facture d'origine d'un avoir — obligatoire si type = CREDIT_NOTE (validé côté
-- application), toujours NULL sinon. Relation N:1 (plusieurs avoirs peuvent référencer la même
-- facture d'origine) — distincte de replacesInvoiceId (versionnement, remplace un document ;
-- un avoir référence sans jamais remplacer ni modifier).
ALTER TABLE "Invoice" ADD COLUMN "originalInvoiceId" TEXT;

-- onDelete: Restrict — la facture d'origine d'un avoir ne doit jamais pouvoir disparaître
-- silencieusement sous lui (même raisonnement que Payment.invoice/damageInvoice).
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_originalInvoiceId_fkey"
  FOREIGN KEY ("originalInvoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Invoice_locationId_type_idx" ON "Invoice" ("locationId", "type");
CREATE INDEX "Invoice_originalInvoiceId_idx" ON "Invoice" ("originalInvoiceId");

-- Deuxième couche de protection contre le doublon de facture principale, en plus du verrou
-- applicatif SELECT ... FOR UPDATE (getOrCreateMainInvoice, src/lib/invoices.ts) : au plus une
-- facture RENTAL active (non VOID) par Location, garanti par PostgreSQL lui-même.
CREATE UNIQUE INDEX "Invoice_one_active_rental_per_location"
  ON "Invoice" ("locationId")
  WHERE "type" = 'RENTAL' AND "status" IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID');

-- Cohérence type/statut d'un avoir garantie en base, jamais l'un sans l'autre — un avoir
-- (type = CREDIT_NOTE) est toujours créé directement à status = CREDIT_NOTE, et aucune autre
-- ligne ne doit jamais atteindre ce statut.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_credit_note_status_type_consistency"
  CHECK (("type" = 'CREDIT_NOTE') = ("status" = 'CREDIT_NOTE'));
