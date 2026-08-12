-- CreateEnum
CREATE TYPE "ReservationSource" AS ENUM ('BROKER', 'DIRECT');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CONVERTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatar" TEXT,
ADD COLUMN     "permissionGroupId" TEXT,
ADD COLUMN     "phone" TEXT;

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "voucherNumber" TEXT NOT NULL,
    "confirmationNumber" TEXT,
    "receivedAt" TIMESTAMP(3),
    "source" "ReservationSource",
    "clientFirstName" TEXT NOT NULL,
    "clientLastName" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT,
    "endDate" TIMESTAMP(3) NOT NULL,
    "endTime" TEXT,
    "daysCount" INTEGER,
    "flightNumber" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "totalPrice" INTEGER,
    "pricePerDay" INTEGER,
    "vehicleCategory" TEXT,
    "pickupAgency" TEXT,
    "dropoffAgency" TEXT,
    "hasGps" BOOLEAN NOT NULL DEFAULT false,
    "gpsPrice" INTEGER,
    "hasBabySeat" BOOLEAN NOT NULL DEFAULT false,
    "babySeatPrice" INTEGER,
    "hasExtraDriver" BOOLEAN NOT NULL DEFAULT false,
    "extraDriverPrice" INTEGER,
    "mileage" INTEGER,
    "includedKm" INTEGER,
    "clientPhone" TEXT,
    "notes" TEXT,
    "status" "ReservationStatus" NOT NULL DEFAULT 'PENDING',
    "convertedLocationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermissionGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PermissionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupPermission" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPermission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reservation_tenantId_idx" ON "Reservation"("tenantId");

-- CreateIndex
CREATE INDEX "Reservation_status_idx" ON "Reservation"("status");

-- CreateIndex
CREATE INDEX "Reservation_voucherNumber_idx" ON "Reservation"("voucherNumber");

-- CreateIndex
CREATE INDEX "PermissionGroup_tenantId_idx" ON "PermissionGroup"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PermissionGroup_tenantId_name_key" ON "PermissionGroup"("tenantId", "name");

-- CreateIndex
CREATE INDEX "GroupPermission_groupId_idx" ON "GroupPermission"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupPermission_groupId_permissionKey_key" ON "GroupPermission"("groupId", "permissionKey");

-- CreateIndex
CREATE INDEX "UserPermission_userId_idx" ON "UserPermission"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPermission_userId_permissionKey_key" ON "UserPermission"("userId", "permissionKey");

-- CreateIndex
CREATE INDEX "User_permissionGroupId_idx" ON "User"("permissionGroupId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_permissionGroupId_fkey" FOREIGN KEY ("permissionGroupId") REFERENCES "PermissionGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionGroup" ADD CONSTRAINT "PermissionGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupPermission" ADD CONSTRAINT "GroupPermission_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PermissionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermission" ADD CONSTRAINT "UserPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
