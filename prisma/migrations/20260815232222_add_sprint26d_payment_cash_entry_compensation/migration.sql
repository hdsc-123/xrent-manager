-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('ACTIVE', 'REFUNDED');

-- AlterTable
ALTER TABLE "CashEntry" ADD COLUMN     "parentEntryId" TEXT,
ADD COLUMN     "paymentId" TEXT,
ADD COLUMN     "performedByUserId" TEXT,
ADD COLUMN     "reason" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "status" "PaymentStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateIndex
CREATE INDEX "CashEntry_paymentId_idx" ON "CashEntry"("paymentId");

-- CreateIndex
CREATE INDEX "CashEntry_parentEntryId_idx" ON "CashEntry"("parentEntryId");

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_parentEntryId_fkey" FOREIGN KEY ("parentEntryId") REFERENCES "CashEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
