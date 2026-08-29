/**
 * Crée le tout premier tenant plateforme et son Super Admin (2026-08-29, DOMAINRULES.md —
 * révision de la décision d'auto-inscription publique, voir src/lib/super-admin.ts).
 *
 * La création de tenant n'est plus un parcours HTTP public (`POST /api/auth/register` a été
 * retiré) : `POST /api/tenants` exige désormais une session existante appartenant à un email
 * listé dans `SUPER_ADMIN_EMAILS`. Ce script est donc le seul moyen de créer le premier
 * tenant/compte d'un environnement neuf — jamais exposé en HTTP, exécuté uniquement en local
 * par le propriétaire du projet.
 *
 * Usage :
 *   node scripts/bootstrap-superadmin.js --env=dev \
 *     --tenant-name="XRent Platform" --tenant-slug="xrent-platform" \
 *     --admin-name="Ton Nom" --admin-email="toi@exemple.test" --admin-password="Mot2Passe!" \
 *     --yes
 *
 * Dry-run par défaut (sans --yes) : affiche ce qui serait créé sans rien écrire.
 *
 * Après exécution : ajouter l'email fourni à `SUPER_ADMIN_EMAILS` dans le fichier .env
 * correspondant (`.env` pour dev, `.env.test` pour test) — ce script ne modifie jamais ces
 * fichiers lui-même (les secrets restent une décision explicite du propriétaire du projet,
 * CLAUDE.md règle 3).
 *
 * Les groupes de permissions par défaut ne sont volontairement pas créés ici (ils dépendent de
 * `src/lib/permissions.ts`, un module TypeScript non importable depuis ce script CommonJS
 * autonome — même contrainte que scripts/reset-dev-data.js/resync-vehicle-status.js). Sans
 * impact : un `role: "ADMIN"` contourne toujours les groupes de permissions (`can()`,
 * SECURITY.md section 4) ; ils seront créés paresseusement (backfill déjà existant) à la
 * première visite de /dashboard/permission-groups si ce tenant invite un jour un MEMBER.
 *
 * Même garde-fou que scripts/reset-dev-data.js : refuse de s'exécuter si DATABASE_URL ne
 * pointe pas vers une base *_dev/*_test locale.
 */

const path = require("path");
const dotenv = require("dotenv");
const bcrypt = require("bcryptjs");

function parseArgs(args) {
  const parsed = {};
  for (const arg of args) {
    const match = arg.match(/^--([a-z-]+)=(.*)$/);
    if (match) {
      parsed[match[1]] = match[2];
    }
  }
  return parsed;
}

const args = process.argv.slice(2);
const flags = parseArgs(args);
const confirmed = args.includes("--yes");
const env = flags.env;

if (env !== "dev" && env !== "test") {
  console.error("Usage: node scripts/bootstrap-superadmin.js --env=dev|test [options] [--yes]");
  process.exit(1);
}

const envFile = env === "dev" ? ".env" : ".env.test";
dotenv.config({ path: path.resolve(__dirname, "..", envFile), override: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(`DATABASE_URL introuvable après chargement de ${envFile}.`);
  process.exit(1);
}

const parsedUrl = new URL(databaseUrl);
const dbName = parsedUrl.pathname.slice(1);
const isLocalHost = parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1";
const looksLikeDevOrTest = /_dev$|_test$/.test(dbName);

if (!isLocalHost || !looksLikeDevOrTest) {
  console.error(
    `Garde-fou : DATABASE_URL (${parsedUrl.hostname}/${dbName}) ne ressemble pas à une base ` +
      `dev/test locale (attendu : localhost, nom se terminant par _dev ou _test). Abandon.`
  );
  process.exit(1);
}

const tenantName = flags["tenant-name"];
const tenantSlug = flags["tenant-slug"];
const adminName = flags["admin-name"];
const adminEmail = flags["admin-email"];
const adminPassword = flags["admin-password"];

if (!tenantName || !tenantSlug || !adminName || !adminEmail || !adminPassword) {
  console.error(
    "Requis : --tenant-name, --tenant-slug, --admin-name, --admin-email, --admin-password"
  );
  process.exit(1);
}

// Même politique que src/lib/password-policy.ts (validatePassword), dupliquée ici pour la même
// raison que le reste de ce script (module TypeScript non importable en CommonJS autonome).
function validatePassword(password) {
  const errors = [];
  if (password.length < 8) errors.push("Le mot de passe doit contenir au moins 8 caractères.");
  if (!/[A-Z]/.test(password)) errors.push("Le mot de passe doit contenir au moins une majuscule.");
  if (!/[0-9]/.test(password)) errors.push("Le mot de passe doit contenir au moins un chiffre.");
  if (!/[^A-Za-z0-9]/.test(password))
    errors.push("Le mot de passe doit contenir au moins un caractère spécial.");
  return errors;
}

const passwordErrors = validatePassword(adminPassword);
if (passwordErrors.length > 0) {
  console.error("Mot de passe invalide :");
  for (const error of passwordErrors) console.error(`  - ${error}`);
  process.exit(1);
}

function resolveBcryptCost() {
  const raw = process.env.BCRYPT_COST;
  if (!raw) return 12;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 4 || parsed > 31) return 12;
  return parsed;
}

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

async function main() {
  console.log(`Environnement : ${env} (${envFile}) — base : ${dbName}@${parsedUrl.hostname}`);

  const normalizedSlug = slugify(tenantSlug);

  const existingTenant = await prisma.tenant.findUnique({ where: { slug: normalizedSlug } });
  if (existingTenant) {
    console.error(`Un tenant avec le slug "${normalizedSlug}" existe déjà (id ${existingTenant.id}). Abandon.`);
    process.exit(1);
  }

  console.log("\nÀ créer :");
  console.log(`  Tenant : ${tenantName} (slug: ${normalizedSlug})`);
  console.log(`  Admin  : ${adminName} <${adminEmail}>`);

  if (!confirmed) {
    console.log("\nDry-run (aucune écriture effectuée). Relancer avec --yes pour exécuter.");
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, resolveBcryptCost());

  const { tenant, user } = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({ data: { name: tenantName, slug: normalizedSlug } });
    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: adminEmail,
        name: adminName,
        passwordHash,
        role: "ADMIN",
      },
    });
    return { tenant, user };
  });

  console.log(`\nTenant créé : ${tenant.id}`);
  console.log(`Admin créé  : ${user.id}`);
  console.log(
    `\nÉtape restante (manuelle) : ajouter "${adminEmail}" à SUPER_ADMIN_EMAILS dans ${envFile} ` +
      "pour que ce compte puisse créer d'autres tenants via POST /api/tenants."
  );
}

main()
  .catch((error) => {
    console.error("Échec du bootstrap :", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
