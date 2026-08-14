-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AlertType" ADD VALUE 'INSURANCE_EXPIRING';
ALTER TYPE "AlertType" ADD VALUE 'VIGNETTE_EXPIRING';
ALTER TYPE "AlertType" ADD VALUE 'TECHNICAL_INSPECTION_DUE';
ALTER TYPE "AlertType" ADD VALUE 'OIL_CHANGE_DUE';

-- AlterTable
ALTER TABLE "Agency" ADD COLUMN     "cashStartingBalance" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "dropoffAgencyId" TEXT,
ADD COLUMN     "secondDriverId" TEXT;

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "dropoffAgencyId" TEXT,
ADD COLUMN     "pickupAgencyId" TEXT;

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "insuranceExpiryDate" TIMESTAMP(3),
ADD COLUMN     "nextOilChangeDate" TIMESTAMP(3),
ADD COLUMN     "nextOilChangeKm" INTEGER,
ADD COLUMN     "technicalInspectionExpiryDate" TIMESTAMP(3),
ADD COLUMN     "vignetteExpiryDate" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Location_dropoffAgencyId_idx" ON "Location"("dropoffAgencyId");

-- CreateIndex
CREATE INDEX "Location_secondDriverId_idx" ON "Location"("secondDriverId");

-- CreateIndex
CREATE INDEX "Reservation_pickupAgencyId_idx" ON "Reservation"("pickupAgencyId");

-- CreateIndex
CREATE INDEX "Reservation_dropoffAgencyId_idx" ON "Reservation"("dropoffAgencyId");

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_dropoffAgencyId_fkey" FOREIGN KEY ("dropoffAgencyId") REFERENCES "Agency"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_secondDriverId_fkey" FOREIGN KEY ("secondDriverId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_pickupAgencyId_fkey" FOREIGN KEY ("pickupAgencyId") REFERENCES "Agency"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_dropoffAgencyId_fkey" FOREIGN KEY ("dropoffAgencyId") REFERENCES "Agency"("id") ON DELETE SET NULL ON UPDATE CASCADE;
