-- CreateEnum
CREATE TYPE "VehicleTransferStatus" AS ENUM ('IN_TRANSIT', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VehicleTripStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AlertType" ADD VALUE 'CONTRACT_AT_RISK';
ALTER TYPE "AlertType" ADD VALUE 'PAYMENT_DUE';
ALTER TYPE "AlertType" ADD VALUE 'VEHICLE_UNAVAILABLE';
ALTER TYPE "AlertType" ADD VALUE 'RETURN_OVERDUE';
ALTER TYPE "AlertType" ADD VALUE 'DOCUMENT_EXPIRED';
ALTER TYPE "AlertType" ADD VALUE 'STOCK_INCONSISTENCY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VehicleStatus" ADD VALUE 'TRANSFERRING';
ALTER TYPE "VehicleStatus" ADD VALUE 'ON_TRIP';

-- CreateTable
CREATE TABLE "VehicleTransfer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "fromAgencyId" TEXT NOT NULL,
    "toAgencyId" TEXT NOT NULL,
    "fromCity" TEXT,
    "toCity" TEXT,
    "departureDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "arrivalDate" TIMESTAMP(3),
    "startOdometer" INTEGER,
    "endOdometer" INTEGER,
    "startFuelLevel" INTEGER,
    "endFuelLevel" INTEGER,
    "responsibleUserId" TEXT NOT NULL,
    "reason" TEXT,
    "status" "VehicleTransferStatus" NOT NULL DEFAULT 'IN_TRANSIT',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleTrip" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "employeeUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "departureDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnDate" TIMESTAMP(3),
    "startOdometer" INTEGER NOT NULL,
    "endOdometer" INTEGER,
    "startFuelLevel" INTEGER,
    "endFuelLevel" INTEGER,
    "remarks" TEXT,
    "status" "VehicleTripStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleTrip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VehicleTransfer_tenantId_idx" ON "VehicleTransfer"("tenantId");

-- CreateIndex
CREATE INDEX "VehicleTransfer_vehicleId_idx" ON "VehicleTransfer"("vehicleId");

-- CreateIndex
CREATE INDEX "VehicleTransfer_status_idx" ON "VehicleTransfer"("status");

-- CreateIndex
CREATE INDEX "VehicleTransfer_fromAgencyId_idx" ON "VehicleTransfer"("fromAgencyId");

-- CreateIndex
CREATE INDEX "VehicleTransfer_toAgencyId_idx" ON "VehicleTransfer"("toAgencyId");

-- CreateIndex
CREATE INDEX "VehicleTrip_tenantId_idx" ON "VehicleTrip"("tenantId");

-- CreateIndex
CREATE INDEX "VehicleTrip_vehicleId_idx" ON "VehicleTrip"("vehicleId");

-- CreateIndex
CREATE INDEX "VehicleTrip_agencyId_idx" ON "VehicleTrip"("agencyId");

-- CreateIndex
CREATE INDEX "VehicleTrip_status_idx" ON "VehicleTrip"("status");

-- AddForeignKey
ALTER TABLE "VehicleTransfer" ADD CONSTRAINT "VehicleTransfer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTransfer" ADD CONSTRAINT "VehicleTransfer_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTransfer" ADD CONSTRAINT "VehicleTransfer_fromAgencyId_fkey" FOREIGN KEY ("fromAgencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTransfer" ADD CONSTRAINT "VehicleTransfer_toAgencyId_fkey" FOREIGN KEY ("toAgencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTransfer" ADD CONSTRAINT "VehicleTransfer_responsibleUserId_fkey" FOREIGN KEY ("responsibleUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTrip" ADD CONSTRAINT "VehicleTrip_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTrip" ADD CONSTRAINT "VehicleTrip_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTrip" ADD CONSTRAINT "VehicleTrip_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTrip" ADD CONSTRAINT "VehicleTrip_employeeUserId_fkey" FOREIGN KEY ("employeeUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
