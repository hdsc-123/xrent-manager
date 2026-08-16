/*
  Warnings:

  - You are about to drop the column `damageId` on the `Payment` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "DamageInvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

-- AlterEnum
ALTER TYPE "DamageStatus" ADD VALUE 'CANCELLED';

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_damageId_fkey";

-- DropIndex
DROP INDEX "Payment_damageId_idx";

-- AlterTable
ALTER TABLE "Damage" ADD COLUMN     "damageInvoiceId" TEXT;

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "damageId",
ADD COLUMN     "damageInvoiceId" TEXT,
ALTER COLUMN "invoiceId" DROP NOT NULL;

-- Sprint 33 (DOMAINRULES.md section 48) : un Payment pointe soit invoiceId (paiement locatif),
-- soit damageInvoiceId (paiement de dégât facturé séparément), jamais les deux, jamais aucun des
-- deux — défense en profondeur en plus de la validation applicative (src/lib/payments.ts,
-- src/lib/damage-invoices.ts). Non exprimable dans le schéma Prisma (pas de CHECK multi-colonnes
-- généré depuis schema.prisma) : ajouté ici en SQL brut, à la main, après la migration générée.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoice_xor_damage_invoice_check" CHECK (
  ("invoiceId" IS NOT NULL AND "damageInvoiceId" IS NULL)
  OR
  ("invoiceId" IS NULL AND "damageInvoiceId" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "DamageInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "DamageInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" INTEGER NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "amountPaid" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DamageInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DamageInvoiceLine" (
    "id" TEXT NOT NULL,
    "damageInvoiceId" TEXT NOT NULL,
    "damageId" TEXT NOT NULL,
    "nature" TEXT NOT NULL,
    "description" TEXT,
    "billableAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DamageInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DamageInvoice_tenantId_idx" ON "DamageInvoice"("tenantId");

-- CreateIndex
CREATE INDEX "DamageInvoice_agencyId_idx" ON "DamageInvoice"("agencyId");

-- CreateIndex
CREATE INDEX "DamageInvoice_locationId_idx" ON "DamageInvoice"("locationId");

-- CreateIndex
CREATE INDEX "DamageInvoice_clientId_idx" ON "DamageInvoice"("clientId");

-- CreateIndex
CREATE INDEX "DamageInvoice_status_idx" ON "DamageInvoice"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DamageInvoice_tenantId_number_key" ON "DamageInvoice"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "DamageInvoiceLine_damageId_key" ON "DamageInvoiceLine"("damageId");

-- CreateIndex
CREATE INDEX "DamageInvoiceLine_damageInvoiceId_idx" ON "DamageInvoiceLine"("damageInvoiceId");

-- CreateIndex
CREATE INDEX "DamageInvoiceLine_damageId_idx" ON "DamageInvoiceLine"("damageId");

-- CreateIndex
CREATE INDEX "Damage_damageInvoiceId_idx" ON "Damage"("damageInvoiceId");

-- CreateIndex
CREATE INDEX "Payment_damageInvoiceId_idx" ON "Payment"("damageInvoiceId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_damageInvoiceId_fkey" FOREIGN KEY ("damageInvoiceId") REFERENCES "DamageInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Damage" ADD CONSTRAINT "Damage_damageInvoiceId_fkey" FOREIGN KEY ("damageInvoiceId") REFERENCES "DamageInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageInvoice" ADD CONSTRAINT "DamageInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageInvoice" ADD CONSTRAINT "DamageInvoice_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageInvoice" ADD CONSTRAINT "DamageInvoice_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageInvoice" ADD CONSTRAINT "DamageInvoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageInvoiceLine" ADD CONSTRAINT "DamageInvoiceLine_damageInvoiceId_fkey" FOREIGN KEY ("damageInvoiceId") REFERENCES "DamageInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DamageInvoiceLine" ADD CONSTRAINT "DamageInvoiceLine_damageId_fkey" FOREIGN KEY ("damageId") REFERENCES "Damage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
