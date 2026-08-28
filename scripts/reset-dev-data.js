/**
 * Réinitialise les données métier/test d'un environnement dev ou test, sans toucher au
 * schéma/migrations et sans supprimer la configuration indispensable au fonctionnement
 * du SaaS (Tenant, Agency, User, UserAgency, permissions, ExpenseCategory, NextAuth).
 *
 * Usage :
 *   node scripts/reset-dev-data.js --env=dev             (dry-run : affiche les comptages)
 *   node scripts/reset-dev-data.js --env=dev --yes        (exécute réellement la suppression)
 *   node scripts/reset-dev-data.js --env=test --yes
 *
 * Refuse de s'exécuter si DATABASE_URL ne pointe pas vers une base nommée *_dev/*_test
 * sur localhost — garde-fou contre une exécution accidentelle ailleurs.
 */

const path = require("path");
const dotenv = require("dotenv");

const args = process.argv.slice(2);
const envArg = args.find((a) => a.startsWith("--env="));
const env = envArg ? envArg.split("=")[1] : null;
const confirmed = args.includes("--yes");

if (env !== "dev" && env !== "test") {
  console.error("Usage: node scripts/reset-dev-data.js --env=dev|test [--yes]");
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
    `Garde-fou : DATABASE_URL (${parsed.hostname}/${dbName}) ne ressemble pas à une base ` +
      `dev/test locale (attendu : localhost, nom se terminant par _dev ou _test). Abandon.`
  );
  process.exit(1);
}

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Ordre de suppression respectant les contraintes de clé étrangère (enfants avant parents).
// Corrigé (sprint "statut opérationnel automatique", 2026-08-28) : cashEntry, damage,
// damageInvoice, damageInvoiceLine et locationUpgrade (Sprints 32/33 et campagne QA
// 2026-08-27) manquaient de cette liste ou étaient mal ordonnés, jamais mis à jour depuis
// leur introduction — échec en présence de données réelles pour ces modèles (créditNoteId
// sur cashEntry restreint vers Invoice ; damage/damageInvoice/locationUpgrade restreints
// vers Location/Vehicle/Invoice). Aucune de ces tables n'est référencée en retour par une
// autre table de cette liste (aucune FK ne pointe vers elles comme parent), donc les
// positionner tôt est sans risque pour le reste de l'ordre.
const WIPE_ORDER = [
  "cashEntry",
  "damageInvoiceLine",
  "payment",
  "damage",
  "damageInvoice",
  "locationUpgrade",
  "invoice",
  "maintenance",
  "vehicleTransfer",
  "vehicleTrip",
  "location",
  "vehicle",
  "client",
  "reservation",
  "alert",
  "invitation",
  "auditLog",
];

const PRESERVED_MODELS = [
  "tenant",
  "agency",
  "user",
  "userAgency",
  "permissionGroup",
  "groupPermission",
  "userPermission",
  "expenseCategory",
  "account",
  "session",
  "verificationToken",
  "cashRegister",
];

async function countAll(models) {
  const counts = {};
  for (const model of models) {
    counts[model] = await prisma[model].count();
  }
  return counts;
}

async function main() {
  console.log(`Environnement : ${env} (${envFile}) — base : ${dbName}@${parsed.hostname}`);

  const beforeWipe = await countAll(WIPE_ORDER);
  const beforePreserved = await countAll(PRESERVED_MODELS);

  console.log("\nDonnées métier/test à réinitialiser :");
  for (const model of WIPE_ORDER) {
    console.log(`  ${model.padEnd(18)} ${beforeWipe[model]}`);
  }

  console.log("\nConfiguration préservée (comptage actuel, inchangé) :");
  for (const model of PRESERVED_MODELS) {
    console.log(`  ${model.padEnd(18)} ${beforePreserved[model]}`);
  }

  if (!confirmed) {
    console.log("\nDry-run (aucune suppression effectuée). Relancer avec --yes pour exécuter.");
    return;
  }

  console.log("\nSuppression en cours...");

  await prisma.$transaction(async (tx) => {
    for (const model of WIPE_ORDER) {
      await tx[model].deleteMany({});
    }
    // CashRegister.currentBalance/previousBalance sont toujours recalculés à partir des
    // CashEntry réels (jamais un compteur incrémenté, voir src/lib/cash-register.ts) —
    // comme CashEntry vient d'être vidée, le solde recalculé est nécessairement 0.
    await tx.cashRegister.updateMany({
      data: { currentBalance: 0, previousBalance: 0, currentMonth: monthKey(new Date()) },
    });
    // Compteur de numérotation des contrats : déplacé de Tenant vers Agency au Sprint 15
    // (voir DOMAINRULES.md section 29) — ce script référençait encore Tenant.lastContractNumber
    // (champ qui n'existe plus), jamais mis à jour depuis ce déplacement, corrigé ici (sprint
    // "statut opérationnel automatique", 2026-08-28). Remis à zéro pour rester cohérent avec la
    // suppression de toutes les Location. contractNumberPrefix fait partie de la configuration
    // et n'est pas touché.
    await tx.agency.updateMany({ data: { lastContractNumber: 0 } });
  });

  const afterWipe = await countAll(WIPE_ORDER);
  const afterPreserved = await countAll(PRESERVED_MODELS);

  console.log("\nTerminé. Comptages après réinitialisation :");
  for (const model of WIPE_ORDER) {
    console.log(`  ${model.padEnd(18)} ${afterWipe[model]}`);
  }
  console.log("\nConfiguration (inchangée) :");
  for (const model of PRESERVED_MODELS) {
    console.log(`  ${model.padEnd(18)} ${afterPreserved[model]}`);
  }
}

main()
  .catch((error) => {
    console.error("Échec de la réinitialisation :", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
