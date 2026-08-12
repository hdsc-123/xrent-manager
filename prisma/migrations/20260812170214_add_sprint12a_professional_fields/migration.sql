-- CreateEnum
CREATE TYPE "IdType" AS ENUM ('CIN', 'PASSEPORT', 'CARTE_SEJOUR');

-- CreateEnum
CREATE TYPE "TransmissionType" AS ENUM ('MANUELLE', 'AUTOMATIQUE');

-- CreateEnum
CREATE TYPE "FuelType" AS ENUM ('ESSENCE', 'DIESEL', 'HYBRIDE', 'ELECTRIQUE');

-- AlterTable
ALTER TABLE "Agency" ADD COLUMN     "address" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "managerName" TEXT,
ADD COLUMN     "managerPhone" TEXT,
ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "address" TEXT,
ADD COLUMN     "altPhone" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "idNumber" TEXT,
ADD COLUMN     "idType" "IdType",
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "licenseExpiryDate" TIMESTAMP(3),
ADD COLUMN     "licenseIssueDate" TIMESTAMP(3),
ADD COLUMN     "licenseNumber" TEXT,
ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "deposit" INTEGER,
ADD COLUMN     "endOdometer" INTEGER,
ADD COLUMN     "startOdometer" INTEGER;

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "ac" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "chassisNumber" TEXT,
ADD COLUMN     "color" TEXT,
ADD COLUMN     "doors" INTEGER,
ADD COLUMN     "engineSize" DOUBLE PRECISION,
ADD COLUMN     "fuel" "FuelType",
ADD COLUMN     "gps" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "horsepower" INTEGER,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "powerKW" INTEGER,
ADD COLUMN     "seats" INTEGER,
ADD COLUMN     "transmission" "TransmissionType",
ADD COLUMN     "ww" TEXT;
