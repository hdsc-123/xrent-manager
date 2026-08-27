-- CreateEnum
CREATE TYPE "LocationUpgradeType" AS ENUM ('CUSTOMER_REQUEST', 'UNAVAILABILITY', 'COMMERCIAL_GESTURE');

-- CreateTable
CREATE TABLE "LocationUpgrade" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "reservationId" TEXT,
    "vehicleId" TEXT NOT NULL,
    "type" "LocationUpgradeType" NOT NULL,
    "reservedCategory" TEXT NOT NULL,
    "assignedCategory" TEXT NOT NULL,
    "dailySupplement" INTEGER NOT NULL,
    "daysCount" INTEGER NOT NULL,
    "totalSupplement" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "customerConsent" BOOLEAN NOT NULL DEFAULT false,
    "operationalReason" TEXT,
    "validatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocationUpgrade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LocationUpgrade_locationId_key" ON "LocationUpgrade"("locationId");

-- CreateIndex
CREATE INDEX "LocationUpgrade_tenantId_idx" ON "LocationUpgrade"("tenantId");

-- CreateIndex
CREATE INDEX "LocationUpgrade_reservationId_idx" ON "LocationUpgrade"("reservationId");

-- CreateIndex
CREATE INDEX "LocationUpgrade_vehicleId_idx" ON "LocationUpgrade"("vehicleId");

-- AddForeignKey
ALTER TABLE "LocationUpgrade" ADD CONSTRAINT "LocationUpgrade_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationUpgrade" ADD CONSTRAINT "LocationUpgrade_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationUpgrade" ADD CONSTRAINT "LocationUpgrade_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationUpgrade" ADD CONSTRAINT "LocationUpgrade_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationUpgrade" ADD CONSTRAINT "LocationUpgrade_validatedByUserId_fkey" FOREIGN KEY ("validatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
