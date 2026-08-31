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
 *
 * --full (2026-08-29, tâche « sécurisation Super Admin/MFA ») : réinitialisation totale —
 * vide en plus TOUTE la configuration normalement préservée ci-dessus (Tenant/User/Agency/
 * PermissionGroup/GroupPermission/UserAgency/CashRegister/ExpenseCategory/NextAuth) ainsi que
 * `LoginThrottle` (nouveau depuis le Sprint « rate limiting », jamais ajouté à ce script — gap
 * comblé ici). Utilisé quand un environnement doit repartir strictement vide (schéma/migrations
 * intacts, aucune ligne de données) — cas d'usage : `xrent_test` avait accumulé des milliers de
 * lignes résiduelles de sessions de test interrompues, sans rapport avec le schéma lui-même.
 *
 * Mécanisme différent du mode par défaut, sur demande explicite : un unique `TRUNCATE ...
 * CASCADE` (une seule instruction Postgres) au lieu d'une boucle de `deleteMany` ordonnée à la
 * main — élimine structurellement le risque de bug d'ordre de suppression déjà rencontré deux
 * fois sur ce script (INC-18) : `CASCADE` résout lui-même les dépendances de clé étrangère,
 * quel que soit l'ordre dans lequel les tables sont listées. Ne touche jamais
 * `_prisma_migrations` (jamais listée, jamais dans le schéma applicatif de toute façon) —
 * vérifié explicitement après exécution (voir plus bas).
 */

const path = require("path");
const { parseEnvFlag, loadEnvFileForEnv, assertDatabaseMatchesEnv, EnvironmentGuardError } = require("./env-guard");

const args = process.argv.slice(2);
const confirmed = args.includes("--yes");
const full = args.includes("--full");

let env, envFile, dbName, hostname;
try {
  env = parseEnvFlag(args, "Usage: node scripts/reset-dev-data.js --env=dev|test [--full] [--yes]");
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

// --full uniquement : modèles ci-dessus + LoginThrottle (absent de PRESERVED_MODELS, jamais
// ajouté depuis son introduction — voir le commentaire d'en-tête). Nom de table Postgres réel
// identique au nom de modèle Prisma dans tout ce schéma (aucun `@@map`, vérifié).
const FULL_ONLY_MODELS = [...PRESERVED_MODELS, "loginThrottle"];

const MODEL_TO_TABLE = {
  tenant: "Tenant",
  agency: "Agency",
  user: "User",
  userAgency: "UserAgency",
  permissionGroup: "PermissionGroup",
  groupPermission: "GroupPermission",
  userPermission: "UserPermission",
  expenseCategory: "ExpenseCategory",
  account: "Account",
  session: "Session",
  verificationToken: "VerificationToken",
  cashRegister: "CashRegister",
  loginThrottle: "LoginThrottle",
  cashEntry: "CashEntry",
  damageInvoiceLine: "DamageInvoiceLine",
  payment: "Payment",
  damage: "Damage",
  damageInvoice: "DamageInvoice",
  locationUpgrade: "LocationUpgrade",
  invoice: "Invoice",
  maintenance: "Maintenance",
  vehicleTransfer: "VehicleTransfer",
  vehicleTrip: "VehicleTrip",
  location: "Location",
  vehicle: "Vehicle",
  client: "Client",
  reservation: "Reservation",
  alert: "Alert",
  invitation: "Invitation",
  auditLog: "AuditLog",
};

async function countAll(models) {
  const counts = {};
  for (const model of models) {
    counts[model] = await prisma[model].count();
  }
  return counts;
}

async function getPrismaMigrationsCount() {
  const rows = await prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "_prisma_migrations"');
  return rows[0].count;
}

async function mainDefault() {
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

async function mainFull() {
  const allModels = [...WIPE_ORDER, ...FULL_ONLY_MODELS];
  const tables = allModels.map((model) => MODEL_TO_TABLE[model]);

  const before = await countAll(allModels);
  const migrationsBefore = await getPrismaMigrationsCount();

  console.log("\n[--full] TOUTES les tables métier/auth seront vidées (aucune exception) :");
  for (const model of allModels) {
    console.log(`  ${model.padEnd(18)} ${before[model]}`);
  }
  console.log(`\n_prisma_migrations (jamais touchée) : ${migrationsBefore} ligne(s)`);

  console.log("\nInstruction qui sera exécutée :");
  const truncateSql = `TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`;
  console.log(`  ${truncateSql};`);

  if (!confirmed) {
    console.log("\nDry-run (aucune suppression effectuée). Relancer avec --full --yes pour exécuter.");
    return;
  }

  console.log("\nTRUNCATE en cours...");
  await prisma.$executeRawUnsafe(truncateSql);

  const after = await countAll(allModels);
  const migrationsAfter = await getPrismaMigrationsCount();

  console.log("\nTerminé. Comptages après réinitialisation complète :");
  let anyNonZero = false;
  for (const model of allModels) {
    console.log(`  ${model.padEnd(18)} ${after[model]}`);
    if (after[model] !== 0) anyNonZero = true;
  }

  if (anyNonZero) {
    throw new Error(
      "Au moins une table ciblée n'est pas vide après TRUNCATE — voir le détail ci-dessus."
    );
  }
  if (migrationsAfter !== migrationsBefore) {
    throw new Error(
      `_prisma_migrations a changé (${migrationsBefore} -> ${migrationsAfter}) alors qu'il ne devait jamais être touché.`
    );
  }

  console.log(`\n_prisma_migrations (confirmée inchangée) : ${migrationsAfter} ligne(s)`);
  console.log("Toutes les tables ciblées sont vides. Registre de migrations intact.");
}

async function main() {
  console.log(`Environnement : ${env} (${envFile}) — base : ${dbName}@${hostname}`);
  if (full) {
    await mainFull();
  } else {
    await mainDefault();
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
