-- CreateTable
CREATE TABLE "InvoiceNumberCounter" (
    "tenantId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceNumberCounter_pkey" PRIMARY KEY ("tenantId","year")
);

-- AddForeignKey
ALTER TABLE "InvoiceNumberCounter" ADD CONSTRAINT "InvoiceNumberCounter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
