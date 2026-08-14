-- AlterEnum
ALTER TYPE "ReservationStatus" ADD VALUE 'NO_SHOW';

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "endFuelLevel" INTEGER,
ADD COLUMN     "startFuelLevel" INTEGER;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "lastAlertCheckAt" TIMESTAMP(3);
