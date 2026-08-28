/**
 * Recalcule et réécrit Vehicle.status pour tous les véhicules d'un environnement dev/test
 * (sprint "statut opérationnel automatique", 2026-08-28) — corrige toute divergence héritée de
 * l'ancien modèle où ce champ était saisi manuellement (DOMAINRULES.md section 5, décision
 * Sprint 5, révisée par ce sprint). Même logique de calcul que getVehicleOperationalStatus
 * (src/lib/vehicle-status.ts) — dupliquée ici en JavaScript simple faute de pouvoir importer un
 * module TypeScript depuis un script CommonJS autonome (même contrainte que
 * scripts/reset-dev-data.js/backfill-permissions.js) : toute évolution de la priorité RENTED >
 * TRANSFERRING > MAINTENANCE > ON_TRIP > AVAILABLE doit être répercutée ici à l'identique.
 *
 * L'ancien statut manuel `INACTIVE` a été retiré de l'enum VehicleStatus par la migration de
 * schéma de ce sprint (remplacé par l'état administratif séparé Vehicle.deactivatedAt) — aucune
 * ligne ne peut donc plus porter cette valeur une fois la migration appliquée (Postgres refuse
 * qu'une colonne enum contienne une valeur retirée du type). Ce script n'a donc rien à migrer
 * pour ce cas précis ; il ne fait que corriger une éventuelle divergence entre le statut
 * opérationnel persisté et le statut réellement calculé.
 *
 * Usage :
 *   node scripts/resync-vehicle-status.js --env=dev             (dry-run : affiche les écarts)
 *   node scripts/resync-vehicle-status.js --env=dev --yes        (corrige réellement)
 *   node scripts/resync-vehicle-status.js --env=test --yes
 *
 * Même garde-fou que scripts/reset-dev-data.js : refuse de s'exécuter si DATABASE_URL ne
 * pointe pas vers une base *_dev/*_test locale. N'utilise que le client Prisma applicatif
 * (aucune requête SQL brute) — chaque écriture est une action applicative équivalente à
 * syncVehicleStatus, jamais une correction directe en base.
 */

const path = require("path");
const dotenv = require("dotenv");

const args = process.argv.slice(2);
const envArg = args.find((a) => a.startsWith("--env="));
const env = envArg ? envArg.split("=")[1] : null;
const confirmed = args.includes("--yes");

if (env !== "dev" && env !== "test") {
  console.error("Usage: node scripts/resync-vehicle-status.js --env=dev|test [--yes]");
  process.exit(1);
}

const envFile = env === "dev" ? ".env" : ".env.test";
dotenv.config({ path: path.resolve(__dirname, "..", envFile), override: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(`DATABASE_URL introuvable après chargement de ${envFile}.`);
  process.exit(1);
}

const parsed = new URL(databaseUrl);
const dbName = parsed.pathname.slice(1);
const isLocalHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
const looksLikeDevOrTest = /_dev$|_test$/.test(dbName);

if (!isLocalHost || !looksLikeDevOrTest) {
  console.error(
    `Refus : DATABASE_URL (${parsed.hostname}/${dbName}) ne ressemble pas à une base de développement/test locale (*_dev/*_test sur localhost).`
  );
  process.exit(1);
}

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const BLOCKING_MAINTENANCE_STATUSES = ["SCHEDULED", "IN_PROGRESS"];

function getMaintenanceEffectiveEnd(maintenance) {
  if (maintenance.scheduledEndDate) {
    return maintenance.scheduledEndDate;
  }
  const endOfDay = new Date(maintenance.scheduledDate);
  endOfDay.setHours(23, 59, 59, 999);
  return endOfDay;
}

async function getVehicleOperationalStatus(vehicleId, referenceDate) {
  const activeLocation = await prisma.location.findFirst({
    where: { vehicleId, status: "ACTIVE" },
    select: { id: true },
  });
  if (activeLocation) return "RENTED";

  const activeTransfer = await prisma.vehicleTransfer.findFirst({
    where: { vehicleId, status: "IN_TRANSIT" },
    select: { id: true },
  });
  if (activeTransfer) return "TRANSFERRING";

  const candidateMaintenances = await prisma.maintenance.findMany({
    where: { vehicleId, status: { in: BLOCKING_MAINTENANCE_STATUSES }, scheduledDate: { lte: referenceDate } },
    select: { scheduledDate: true, scheduledEndDate: true },
  });
  const hasActiveMaintenance = candidateMaintenances.some(
    (maintenance) => referenceDate < getMaintenanceEffectiveEnd(maintenance)
  );
  if (hasActiveMaintenance) return "MAINTENANCE";

  const activeTrip = await prisma.vehicleTrip.findFirst({
    where: { vehicleId, status: "IN_PROGRESS" },
    select: { id: true },
  });
  if (activeTrip) return "ON_TRIP";

  return "AVAILABLE";
}

async function main() {
  console.log(`Environnement : ${env} (${envFile}) — base : ${dbName}@${parsed.hostname}`);

  const vehicles = await prisma.vehicle.findMany({
    select: { id: true, name: true, licensePlate: true, status: true },
    orderBy: { createdAt: "asc" },
  });

  const now = new Date();
  const drifts = [];

  for (const vehicle of vehicles) {
    const computed = await getVehicleOperationalStatus(vehicle.id, now);
    if (computed !== vehicle.status) {
      drifts.push({ vehicle, computed });
    }
  }

  console.log(`\nVéhicules examinés : ${vehicles.length}`);
  console.log(`Écarts statut calculé vs statut enregistré : ${drifts.length}`);
  for (const { vehicle, computed } of drifts) {
    console.log(`  - ${vehicle.name} (${vehicle.licensePlate}) : enregistré=${vehicle.status} calculé=${computed}`);
  }

  if (drifts.length === 0) {
    console.log("\nAucune correction nécessaire.");
    await prisma.$disconnect();
    return;
  }

  if (!confirmed) {
    console.log("\nDry-run (aucune écriture effectuée). Relancer avec --yes pour corriger.");
    await prisma.$disconnect();
    return;
  }

  console.log("\nCorrection en cours...");
  for (const { vehicle, computed } of drifts) {
    await prisma.vehicle.update({ where: { id: vehicle.id }, data: { status: computed } });
  }

  console.log("Terminé.");
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("Échec de la resynchronisation :", error);
  process.exit(1);
});
