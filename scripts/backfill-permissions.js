/**
 * Rattrape, une seule fois et explicitement, les clés de permission introduites par un sprint
 * pour les groupes MEMBER/AGENCE déjà existants d'un environnement dev/test (voir
 * src/lib/permissions.ts, PAST_PERMISSION_BACKFILLS, et son commentaire — le mécanisme
 * automatique équivalent a été retiré au Sprint 19 car il réinjectait ces clés à chaque
 * chargement de la page permissions, annulant silencieusement tout retrait volontaire fait
 * par un ADMIN). Fusion additive uniquement (skipDuplicates) — ne retire jamais une clé,
 * ne touche jamais un groupe personnalisé ne portant pas exactement le nom "MEMBER"/"AGENCE".
 *
 * Usage :
 *   node scripts/backfill-permissions.js --env=dev             (dry-run : affiche ce qui serait ajouté)
 *   node scripts/backfill-permissions.js --env=dev --yes        (exécute réellement)
 *   node scripts/backfill-permissions.js --env=test --yes
 *
 * Même garde-fou que scripts/reset-dev-data.js : refuse de s'exécuter si DATABASE_URL ne
 * pointe pas vers une base *_dev/*_test locale.
 */

const path = require("path");
const dotenv = require("dotenv");

const args = process.argv.slice(2);
const envArg = args.find((a) => a.startsWith("--env="));
const env = envArg ? envArg.split("=")[1] : null;
const confirmed = args.includes("--yes");

if (env !== "dev" && env !== "test") {
  console.error("Usage: node scripts/backfill-permissions.js --env=dev|test [--yes]");
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

// Doit rester synchronisé manuellement avec PAST_PERMISSION_BACKFILLS (src/lib/permissions.ts)
// — script autonome en CommonJS (même convention que reset-dev-data.js), ne peut pas importer
// directement le module TS applicatif.
const BACKFILLS = {
  MEMBER: [
    "cash_register.edit",
    "cash_register.delete",
  ],
  AGENCE: [
    "cash_register.edit",
    "cash_register.delete",
  ],
};

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  console.log(`Environnement : ${env} (${envFile}) — base : ${dbName}@${parsed.hostname}`);

  const groups = await prisma.permissionGroup.findMany({
    where: { name: { in: Object.keys(BACKFILLS) } },
    include: { groupPermissions: { select: { permissionKey: true } } },
  });

  let totalToAdd = 0;
  const plan = [];
  for (const group of groups) {
    const existingKeys = new Set(group.groupPermissions.map((gp) => gp.permissionKey));
    const missing = BACKFILLS[group.name].filter((key) => !existingKeys.has(key));
    if (missing.length > 0) {
      plan.push({ groupId: group.id, tenantId: group.tenantId, name: group.name, missing });
      totalToAdd += missing.length;
    }
  }

  console.log(`\n${groups.length} groupe(s) MEMBER/AGENCE trouvé(s), ${plan.length} à mettre à jour :`);
  for (const item of plan) {
    console.log(`  tenant=${item.tenantId} groupe=${item.name} (${item.groupId}) : +${item.missing.join(", +")}`);
  }

  if (!confirmed) {
    console.log(`\nDry-run (${totalToAdd} clé(s) au total, aucune écriture). Relancer avec --yes pour exécuter.`);
    return;
  }

  for (const item of plan) {
    await prisma.groupPermission.createMany({
      data: item.missing.map((permissionKey) => ({ groupId: item.groupId, permissionKey })),
      skipDuplicates: true,
    });
  }
  console.log(`\nTerminé. ${totalToAdd} clé(s) ajoutée(s) au total.`);
}

main()
  .catch((error) => {
    console.error("Échec du backfill de permissions :", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
