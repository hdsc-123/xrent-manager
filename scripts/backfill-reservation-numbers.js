/**
 * Attribue rétroactivement `reservationNumber` (Phase 6.1, 2026-08-31) aux réservations créées
 * avant cette phase, qui n'en ont jamais reçu (le champ est nullable précisément pour ce cas —
 * voir le commentaire du modèle `Reservation`, `prisma/schema.prisma`). Jamais exécuté
 * automatiquement par aucun autre script/route — un choix délibéré, pas un oubli : contrairement
 * à la génération à la création (toujours dans la même transaction que l'écriture qui la motive,
 * voir `generateReservationNumber`/`createReservation`, `src/lib/reservations.ts`), un backfill
 * historique est une opération ponctuelle qui doit rester sous contrôle explicite de l'opérateur.
 *
 * Même primitive atomique que la génération en direct (`INSERT ... ON CONFLICT ... DO UPDATE ...
 * RETURNING` sur `ReservationNumberCounter`, jamais un `SELECT MAX(...)+1`) — dupliquée ici en
 * JavaScript simple, faute de pouvoir importer un module TypeScript depuis un script CommonJS
 * autonome (même contrainte déjà documentée pour `resync-vehicle-status.js`/
 * `backfill-permissions.js`). Toute évolution du format (`RES-{année}-{6 chiffres}`) ou de la clé
 * du compteur (`tenantId` + `year`) doit être répercutée ici à l'identique.
 *
 * Différence volontaire avec la génération en direct : l'année utilisée pour un backfill est
 * celle de la date de création RÉELLE de la réservation (`createdAt.getFullYear()`), jamais
 * l'année courante — pour ne pas numéroter en `RES-2027-...` une réservation réellement créée en
 * 2026 simplement parce que le backfill est exécuté l'année suivante. Traitement par tenant, par
 * ordre chronologique de création (`createdAt` croissant) : la numérotation attribuée reflète
 * ainsi l'ordre de création réel au sein de chaque année, sans que ce soit une garantie contractuelle
 * (un « trou » dans la séquence reste possible et sans conséquence, comme pour tout compteur de ce
 * type dans ce projet).
 *
 * Chaque ligne est traitée dans sa propre transaction (compteur + écriture de la réservation) —
 * un échec sur une ligne ne bloque jamais les suivantes ni n'affecte les lignes déjà corrigées
 * (même philosophie que `resync-vehicle-status.js` : jamais de transaction unique englobant tout
 * le lot, pour ne jamais perdre un travail partiel déjà valide en cas d'erreur isolée).
 *
 * Usage :
 *   node scripts/backfill-reservation-numbers.js --env=dev             (dry-run : affiche le plan)
 *   node scripts/backfill-reservation-numbers.js --env=dev --yes        (attribue réellement)
 *   node scripts/backfill-reservation-numbers.js --env=test --yes
 *
 * Même garde-fou que resync-vehicle-status.js/reset-dev-data.js (scripts/env-guard.js) : refuse
 * de s'exécuter si DATABASE_URL ne pointe pas vers une base *_dev/*_test locale exacte pour
 * l'environnement demandé. N'utilise que le client Prisma applicatif pour la lecture/écriture des
 * réservations (aucune requête SQL brute sur `Reservation` elle-même) ; seul l'incrément du
 * compteur passe par SQL brut, strictement identique à `generateReservationNumber`.
 */

const path = require("path");
const { parseEnvFlag, loadEnvFileForEnv, assertDatabaseMatchesEnv, EnvironmentGuardError } = require("./env-guard");

const args = process.argv.slice(2);
const confirmed = args.includes("--yes");

let env, envFile, dbName, hostname;
try {
  env = parseEnvFlag(args, "Usage: node scripts/backfill-reservation-numbers.js --env=dev|test [--yes]");
  envFile = loadEnvFileForEnv(env, path.resolve(__dirname, ".."));
  ({ dbName, hostname } = assertDatabaseMatchesEnv(process.env.DATABASE_URL, env));
} catch (error) {
  if (error instanceof EnvironmentGuardError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

/** Même instruction SQL, même sémantique que `generateReservationNumber`
 * (src/lib/reservations.ts) — voir son commentaire pour la justification de l'atomicité. */
async function generateReservationNumber(tx, tenantId, year) {
  const rows = await tx.$queryRaw`
    INSERT INTO "ReservationNumberCounter" ("tenantId", "year", "lastNumber")
    VALUES (${tenantId}, ${year}, 1)
    ON CONFLICT ("tenantId", "year")
    DO UPDATE SET "lastNumber" = "ReservationNumberCounter"."lastNumber" + 1
    RETURNING "lastNumber"
  `;
  const lastNumber = rows[0].lastNumber;
  return `RES-${year}-${String(lastNumber).padStart(6, "0")}`;
}

async function main() {
  console.log(`Environnement : ${env} (${envFile}) — base : ${dbName}@${hostname}`);

  const missing = await prisma.reservation.findMany({
    where: { reservationNumber: null },
    select: { id: true, tenantId: true, voucherNumber: true, createdAt: true },
    orderBy: [{ tenantId: "asc" }, { createdAt: "asc" }],
  });

  console.log(`\nRéservations sans reservationNumber : ${missing.length}`);
  if (missing.length === 0) {
    console.log("Aucune correction nécessaire.");
    await prisma.$disconnect();
    return;
  }

  const byTenant = new Map();
  for (const reservation of missing) {
    const year = reservation.createdAt.getFullYear();
    console.log(
      `  - [${reservation.tenantId}] ${reservation.id} (voucher "${reservation.voucherNumber}", créée ${reservation.createdAt.toISOString().slice(0, 10)}) → RES-${year}-......`
    );
    if (!byTenant.has(reservation.tenantId)) byTenant.set(reservation.tenantId, 0);
    byTenant.set(reservation.tenantId, byTenant.get(reservation.tenantId) + 1);
  }
  console.log(`\nRépartition par tenant : ${byTenant.size} tenant(s) concerné(s).`);

  if (!confirmed) {
    console.log("\nDry-run (aucune écriture effectuée). Relancer avec --yes pour attribuer réellement les numéros.");
    await prisma.$disconnect();
    return;
  }

  console.log("\nAttribution en cours...");
  let done = 0;
  let failed = 0;
  for (const reservation of missing) {
    const year = reservation.createdAt.getFullYear();
    try {
      await prisma.$transaction(async (tx) => {
        const reservationNumber = await generateReservationNumber(tx, reservation.tenantId, year);
        await tx.reservation.update({
          where: { id: reservation.id },
          data: { reservationNumber },
        });
      });
      done += 1;
    } catch (error) {
      failed += 1;
      console.error(`  Échec sur ${reservation.id} : ${error.message}`);
    }
  }

  console.log(`\nTerminé — ${done} réservation(s) numérotée(s), ${failed} échec(s).`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("Échec du backfill :", error);
  process.exit(1);
});
