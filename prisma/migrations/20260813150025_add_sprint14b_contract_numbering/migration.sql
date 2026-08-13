-- AlterTable
ALTER TABLE "CashEntry" ADD COLUMN     "contractNumber" TEXT;

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "contractNumber" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "contractNumberPrefix" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "lastContractNumber" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "Location_tenantId_contractNumber_key" ON "Location"("tenantId", "contractNumber");
