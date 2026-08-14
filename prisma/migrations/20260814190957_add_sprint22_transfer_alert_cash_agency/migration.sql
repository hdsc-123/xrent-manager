-- AlterEnum
ALTER TYPE "AlertType" ADD VALUE 'VEHICLE_TRANSFER_INCOMING';

-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "nextDueDate" TIMESTAMP(3),
ADD COLUMN     "resolutionAction" TEXT,
ADD COLUMN     "resolutionCost" INTEGER,
ADD COLUMN     "resolutionCurrency" TEXT,
ADD COLUMN     "resolutionDate" TIMESTAMP(3),
ADD COLUMN     "resolutionIntervenant" TEXT;

-- AlterTable
ALTER TABLE "CashEntry" ADD COLUMN     "agencyId" TEXT;

-- AlterTable
ALTER TABLE "VehicleTransfer" ADD COLUMN     "arrivalDriverName" TEXT;

-- CreateIndex
CREATE INDEX "CashEntry_agencyId_idx" ON "CashEntry"("agencyId");

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE SET NULL ON UPDATE CASCADE;
