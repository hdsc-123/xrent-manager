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
 *     --admin-name="Ton Nom" --admin-email="toi@exemple.test" \
 *     --yes
 *   (le mot de passe est demandé de façon interactive, jamais en argument — voir ci-dessous)
 *
 * Dry-run par défaut (sans --yes) : affiche ce qui serait créé sans rien écrire, sans demander
 * de mot de passe (rien n'est haché ni stocké tant que --yes n'est pas fourni).
 *
 * **Sécurité du mot de passe (2026-08-29, durcissement)** : `--admin-password` n'est plus
 * accepté — un mot de passe passé en argument de ligne de commande reste visible dans
 * l'historique du shell (`~/.bash_history`/`~/.zsh_history`) et dans la liste des processus du
 * système (`ps aux`) pendant toute la durée d'exécution, deux surfaces d'exposition inutiles
 * pour un secret. Le mot de passe est désormais saisi interactivement, écho masqué au terminal
 * (`promptHidden`, ci-dessous — lecture caractère par caractère en mode raw stdin, aucune
 * dépendance ajoutée), avec une seconde saisie de confirmation. Jamais affiché, jamais journalisé,
 * jamais écrit sur disque en clair — seul le hash bcrypt (même mécanisme que
 * `src/lib/password-policy.ts`/`src/app/api/tenants/route.ts`) est persisté.
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

if ("admin-password" in flags) {
  console.error(
    "Refusé : --admin-password n'est plus accepté (exposition dans l'historique shell et " +
      "la liste des processus). Relancer sans ce paramètre — le mot de passe sera demandé " +
      "de façon interactive, écho masqué, avec confirmation."
  );
  process.exit(1);
}

if (env !== "dev" && env !== "test") {
  console.error("Usage: node scripts/bootstrap-superadmin.js --env=dev|test [options] [--yes]");
  process.exit(1);
}

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = "\u007f";

/**
 * Saisie interactive avec écho masqué (aucun caractère, y compris des astérisques, n'est
 * réaffiché — évite même de révéler la longueur du mot de passe). Lecture brute de stdin
 * caractère par caractère (mode raw), jamais via `readline`'s question() standard (qui
 * réaffiche systématiquement la frappe). Gère backspace/Ctrl-C/Ctrl-D explicitement.
 */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("Entrée standard non interactive (TTY requis) — impossible de saisir un mot de passe masqué."));
      return;
    }
    process.stdout.write(question);
    const stdin = process.stdin;
    let input = "";

    const onData = (charBuffer) => {
      const char = charBuffer.toString("utf8");
      switch (char) {
        case "\n":
        case "\r":
        case CTRL_D:
          cleanup();
          process.stdout.write("\n");
          resolve(input);
          break;
        case CTRL_C:
          cleanup();
          process.stdout.write("\n");
          process.exit(1);
          break;
        case BACKSPACE:
        case "\b":
          input = input.slice(0, -1);
          break;
        default:
          input += char;
          break;
      }
    };

    function cleanup() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

async function promptPasswordWithConfirmation() {
  const first = await promptHidden("Mot de passe du Super Admin (saisie masquée) : ");
  const second = await promptHidden("Confirmer le mot de passe : ");
  if (first !== second) {
    console.error("Les deux saisies ne correspondent pas. Abandon — aucune écriture effectuée.");
    process.exit(1);
  }
  return first;
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

if (!tenantName || !tenantSlug || !adminName || !adminEmail) {
  console.error("Requis : --tenant-name, --tenant-slug, --admin-name, --admin-email");
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

  const normalizedEmail = adminEmail.trim().toLowerCase();
  const existingUser = await prisma.user.findFirst({ where: { email: normalizedEmail } });
  if (existingUser) {
    console.error(`Un utilisateur avec l'email "${normalizedEmail}" existe déjà (id ${existingUser.id}, tenant ${existingUser.tenantId}). Abandon — aucun doublon créé.`);
    process.exit(1);
  }

  console.log("\nÀ créer :");
  console.log(`  Tenant : ${tenantName} (slug: ${normalizedSlug})`);
  console.log(`  Admin  : ${adminName} <${normalizedEmail}>`);

  if (!confirmed) {
    console.log("\nDry-run (aucune écriture effectuée, aucun mot de passe demandé). Relancer avec --yes pour exécuter.");
    return;
  }

  const password = await promptPasswordWithConfirmation();
  const passwordErrors = validatePassword(password);
  if (passwordErrors.length > 0) {
    console.error("Mot de passe invalide :");
    for (const error of passwordErrors) console.error(`  - ${error}`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, resolveBcryptCost());

  const { tenant, user } = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({ data: { name: tenantName, slug: normalizedSlug } });
    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: normalizedEmail,
        name: adminName,
        passwordHash,
        role: "ADMIN",
      },
    });
    return { tenant, user };
  });

  console.log(`\nTenant créé : ${tenant.id}`);
  console.log(`Admin créé  : ${user.id} (role=${user.role})`);
  console.log(
    `\nÉtape restante (manuelle) : ajouter "${normalizedEmail}" à SUPER_ADMIN_EMAILS dans ${envFile} ` +
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
