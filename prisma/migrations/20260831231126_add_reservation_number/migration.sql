-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "reservationNumber" TEXT;

-- CreateTable
CREATE TABLE "ReservationNumberCounter" (
    "tenantId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ReservationNumberCounter_pkey" PRIMARY KEY ("tenantId","year")
);

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_tenantId_reservationNumber_key" ON "Reservation"("tenantId", "reservationNumber");

-- AddForeignKey
ALTER TABLE "ReservationNumberCounter" ADD CONSTRAINT "ReservationNumberCounter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
