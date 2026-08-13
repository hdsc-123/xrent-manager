-- CreateEnum
CREATE TYPE "CashEntryType" AS ENUM ('ENTRY', 'EXPENSE');

-- CreateTable
CREATE TABLE "CashRegister" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "currentBalance" INTEGER NOT NULL DEFAULT 0,
    "currentMonth" TEXT NOT NULL,
    "previousBalance" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashRegister_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cashRegisterId" TEXT NOT NULL,
    "type" "CashEntryType" NOT NULL,
    "category" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "description" TEXT,
    "contractId" TEXT,
    "clientName" TEXT,
    "paymentMethod" "PaymentMethod",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashRegister_tenantId_key" ON "CashRegister"("tenantId");

-- CreateIndex
CREATE INDEX "CashRegister_tenantId_idx" ON "CashRegister"("tenantId");

-- CreateIndex
CREATE INDEX "CashEntry_tenantId_idx" ON "CashEntry"("tenantId");

-- CreateIndex
CREATE INDEX "CashEntry_cashRegisterId_idx" ON "CashEntry"("cashRegisterId");

-- CreateIndex
CREATE INDEX "CashEntry_type_idx" ON "CashEntry"("type");

-- CreateIndex
CREATE INDEX "CashEntry_createdAt_idx" ON "CashEntry"("createdAt");

-- CreateIndex
CREATE INDEX "ExpenseCategory_tenantId_idx" ON "ExpenseCategory"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_tenantId_name_key" ON "ExpenseCategory"("tenantId", "name");

-- AddForeignKey
ALTER TABLE "CashRegister" ADD CONSTRAINT "CashRegister_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_cashRegisterId_fkey" FOREIGN KEY ("cashRegisterId") REFERENCES "CashRegister"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
