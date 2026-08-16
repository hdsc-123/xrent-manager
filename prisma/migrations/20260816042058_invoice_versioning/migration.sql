-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "replacesInvoiceId" TEXT,
ADD COLUMN     "rootInvoiceId" TEXT,
ADD COLUMN     "versionNumber" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_replacesInvoiceId_key" ON "Invoice"("replacesInvoiceId");

-- CreateIndex
CREATE INDEX "Invoice_rootInvoiceId_idx" ON "Invoice"("rootInvoiceId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_replacesInvoiceId_fkey" FOREIGN KEY ("replacesInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_rootInvoiceId_fkey" FOREIGN KEY ("rootInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
