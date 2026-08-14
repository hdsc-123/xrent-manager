-- Sprint 15: reservation source becomes free text (was a closed enum BROKER/DIRECT,
-- silently dropping real broker codes like TJS/DCH/CT on import); Reservation gains a
-- separate optionsCurrency for gpsPrice/babySeatPrice/extraDriverPrice; contract
-- numbering (prefix + last number) moves from Tenant (global) to Agency (per-agency).

-- AlterTable: Reservation.source enum -> text, preserving existing values (no data loss)
ALTER TABLE "Reservation" ALTER COLUMN "source" TYPE TEXT USING "source"::TEXT;

-- AlterTable: Reservation gains optionsCurrency
ALTER TABLE "Reservation" ADD COLUMN "optionsCurrency" TEXT NOT NULL DEFAULT 'MAD';

-- AlterTable: Agency gains its own contract numbering sequence
ALTER TABLE "Agency" ADD COLUMN "contractNumberPrefix" TEXT NOT NULL DEFAULT '',
ADD COLUMN "lastContractNumber" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: Tenant-level contract numbering removed (per-agency now, see above)
ALTER TABLE "Tenant" DROP COLUMN "contractNumberPrefix",
DROP COLUMN "lastContractNumber";

-- DropEnum: no longer used now that Reservation.source is free text
DROP TYPE "ReservationSource";
