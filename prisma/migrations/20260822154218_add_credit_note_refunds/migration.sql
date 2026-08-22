-- Sprint 13E tâche 3, sous-phase 2c2-C : lien optionnel entre une CashEntry de remboursement et
-- l'avoir (Invoice, type=CREDIT_NOTE) qu'elle rembourse (refundCreditNote, src/lib/invoices.ts).
-- Purement additive : nouvelle colonne nullable, aucune colonne existante modifiée, aucune donnée
-- supprimée, toutes les CashEntry déjà existantes conservées telles quelles (creditNoteId = NULL).

-- AlterTable
ALTER TABLE "CashEntry" ADD COLUMN     "creditNoteId" TEXT;

-- CreateIndex
CREATE INDEX "CashEntry_creditNoteId_idx" ON "CashEntry"("creditNoteId");

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
