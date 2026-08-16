-- CreateEnum
CREATE TYPE "DamageStatus" AS ENUM ('REPORTED', 'PARTIALLY_PAID', 'PAID');

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "actualReturnAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "damageId" TEXT;

-- CreateTable
CREATE TABLE "Damage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "nature" TEXT NOT NULL,
    "description" TEXT,
    "billableAmount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "status" "DamageStatus" NOT NULL DEFAULT 'REPORTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Damage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Damage_tenantId_idx" ON "Damage"("tenantId");

-- CreateIndex
CREATE INDEX "Damage_vehicleId_idx" ON "Damage"("vehicleId");

-- CreateIndex
CREATE INDEX "Damage_locationId_idx" ON "Damage"("locationId");

-- CreateIndex
CREATE INDEX "Damage_status_idx" ON "Damage"("status");

-- CreateIndex
CREATE INDEX "Payment_damageId_idx" ON "Payment"("damageId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_damageId_fkey" FOREIGN KEY ("damageId") REFERENCES "Damage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Damage" ADD CONSTRAINT "Damage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Damage" ADD CONSTRAINT "Damage_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Damage" ADD CONSTRAINT "Damage_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Damage" ADD CONSTRAINT "Damage_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
