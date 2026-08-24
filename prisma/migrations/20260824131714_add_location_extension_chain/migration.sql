-- Sprint technique 1 (DOMAINRULES.md section 60) : chaînage de contrats liés (prolongations).
-- Migration additive uniquement : aucune colonne existante modifiée, aucune ligne supprimée,
-- aucun numéro de contrat existant réécrit, aucune facture EXTENSION déjà émise réinterprétée.

-- CreateEnum
CREATE TYPE "ContractKind" AS ENUM ('INITIAL', 'EXTENSION');

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "contractKind" "ContractKind" NOT NULL DEFAULT 'INITIAL',
ADD COLUMN     "parentLocationId" TEXT,
ADD COLUMN     "rootLocationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Location_parentLocationId_key" ON "Location"("parentLocationId");

-- CreateIndex
CREATE INDEX "Location_parentLocationId_idx" ON "Location"("parentLocationId");

-- CreateIndex
CREATE INDEX "Location_rootLocationId_idx" ON "Location"("rootLocationId");

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_parentLocationId_fkey" FOREIGN KEY ("parentLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_rootLocationId_fkey" FOREIGN KEY ("rootLocationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill (DOMAINRULES.md section 60, section « Stratégie de migration ») : chaque Location déjà
-- existante devient conceptuellement un contrat INITIAL (déjà la valeur par défaut ci-dessus,
-- aucune écriture nécessaire pour cette colonne) et sa propre racine — parentLocationId reste
-- NULL (déjà la valeur par défaut, aucune écriture nécessaire). Aucune ligne, aucun
-- contractNumber, aucune Invoice de type EXTENSION déjà émise n'est modifiée par cette
-- instruction : seule la nouvelle colonne rootLocationId est renseignée.
UPDATE "Location" SET "rootLocationId" = "id" WHERE "rootLocationId" IS NULL;

-- Contrainte d'intégrité de la chaîne (non exprimable en DSL Prisma, voir le même principe déjà
-- appliqué pour Invoice — prisma/migrations/*/migration.sql antérieures) : empêche l'auto-
-- rattachement (un contrat ne peut jamais être son propre parent direct) et garantit la
-- cohérence contractKind/parentLocationId/rootLocationId dans les deux sens :
--   - INITIAL  : parentLocationId NULL, rootLocationId NULL (fenêtre transitoire juste après
--                l'INSERT, avant le second appel applicatif qui le fixe à son propre id dans la
--                même transaction) ou égal à son propre id (état final).
--   - EXTENSION : parentLocationId renseigné et différent de son propre id, rootLocationId
--                 renseigné et différent de son propre id (une prolongation n'est jamais sa
--                 propre racine).
-- Un cycle plus long qu'un auto-rattachement direct (A -> B -> A) est structurellement
-- impossible sans cette contrainte : parentLocationId n'est jamais modifié après création
-- (DOMAINRULES.md section 60) et ne peut référencer, à la création, qu'une ligne déjà existante
-- — une ligne ne peut donc jamais pointer vers une ligne créée après elle.
ALTER TABLE "Location" ADD CONSTRAINT "location_extension_chain_check" CHECK (
  ("contractKind" = 'INITIAL' AND "parentLocationId" IS NULL AND ("rootLocationId" IS NULL OR "rootLocationId" = "id"))
  OR
  ("contractKind" = 'EXTENSION' AND "parentLocationId" IS NOT NULL AND "parentLocationId" != "id" AND "rootLocationId" IS NOT NULL AND "rootLocationId" != "id")
);
