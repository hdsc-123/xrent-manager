-- CreateTable
CREATE TABLE "CreditNoteNumberCounter" (
    "tenantId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CreditNoteNumberCounter_pkey" PRIMARY KEY ("tenantId","year")
);

-- AddForeignKey
ALTER TABLE "CreditNoteNumberCounter" ADD CONSTRAINT "CreditNoteNumberCounter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
