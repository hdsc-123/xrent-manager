/**
 * Réinitialisation contrôlée du mot de passe d'un utilisateur de test existant dans
 * `xrent_test` (2026-09-16, brief explicite du propriétaire du projet ; revue de sécurité et
 * durcissement le 2026-09-17, également brief explicite).
 *
 * Comble un vide structurel constaté pendant la campagne QA MFA : `PATCH /api/users/[id]`
 * (mécanisme officiel de réinitialisation par un ADMIN, `src/lib/users.ts`) exige une session
 * déjà authentifiée appartenant à un `ADMIN` du même tenant — inutilisable si le mot de passe
 * de TOUS les comptes connus d'un tenant de test (ex. `TEST_XRENT`) est perdu, faute de compte
 * de départ pour s'y connecter. `scripts/bootstrap-superadmin.js` ne sait créer qu'un tout
 * nouveau tenant/premier compte, jamais réinitialiser un compte déjà existant (refuse tout
 * email déjà pris). Ce script comble exactement cet écart, jamais exposé en HTTP — même
 * principe que `scripts/superadmin-mfa-recovery.js`.
 *
 * Usage :
 *   node scripts/reset-test-user-password.js --env=test \
 *     --user-email="admin@test-xrent.local" \
 *     --yes
 *   (le mot de passe est demandé de façon interactive, jamais en argument — voir ci-dessous)
 *
 * Dry-run par défaut (sans --yes) : affiche l'utilisateur/tenant/rôle résolus sans rien écrire,
 * sans demander de mot de passe, sans demander de confirmation d'adresse.
 *
 * **Réservé strictement à `xrent_test`** : `--env=test` obligatoire (aucun défaut implicite),
 * et refusé explicitement si une autre valeur est fournie — ce script n'accepte jamais
 * `--env=dev`, contrairement aux autres scripts de ce dépôt qui acceptent les deux. Double
 * protection avec `scripts/env-guard.js` (`assertDatabaseMatchesEnv`), qui vérifie en plus que
 * `DATABASE_URL` pointe réellement sur une base nommée exactement `xrent_test` en
 * localhost/127.0.0.1 — aucune des deux vérifications n'est contournable par un flag.
 *
 * **Comptes autorisés — allowlist explicite, pas un accès ouvert à tout email** : seuls les
 * domaines synthétiques déjà en usage dans `xrent_test` (`ALLOWED_TEST_EMAIL_DOMAINS`
 * ci-dessous) peuvent être ciblés. Toute autre adresse est refusée avant toute lecture en base.
 * Le compte réel `saadscott123@gmail.com` est de plus explicitement et inconditionnellement
 * interdit (CLAUDE.md règle 11), en défense en profondeur au-delà de l'allowlist (qui
 * l'exclurait de toute façon, aucun des domaines autorisés ne correspondant à ce compte).
 *
 * **Confirmation explicite de la cible avant écriture (2026-09-17)** : une fois la cible
 * résolue et affichée, et uniquement si `--yes` est fourni (jamais en dry-run, qui n'écrit
 * rien), l'opérateur doit retaper l'adresse exacte affichée avant que le mot de passe ne soit
 * demandé — abandon immédiat si la ressaisie ne correspond pas, aucune écriture. Même principe
 * que `scripts/superadmin-mfa-recovery.js` (`promptVisible` + comparaison stricte) : une simple
 * relecture rapide du dry-run ne suffisait pas à garantir qu'un opérateur pressé confirme bien
 * la cible qu'il croit viser avant de taper un nouveau mot de passe.
 *
 * **Sécurité du mot de passe** : jamais accepté en argument de ligne de commande (refusé
 * explicitement si `--password=`/`--new-password=` est fourni, même motif que
 * `bootstrap-superadmin.js` — exposition dans l'historique shell et la liste des processus).
 * Saisie interactive masquée (`promptHidden`, lecture caractère par caractère en mode raw
 * stdin), avec confirmation par double saisie — abandon si les deux ne correspondent pas,
 * aucune écriture. Politique de mot de passe (`validatePassword`, dupliquée depuis
 * `src/lib/password-policy.ts` pour la même raison que le reste de ce script — module
 * TypeScript non importable depuis un script CommonJS autonome) appliquée avant tout hachage.
 * Le mot de passe en clair n'est jamais journalisé (aucun `console.*`) ni écrit sur disque —
 * seule sa forme hachée (bcrypt) quitte la mémoire du process, dans l'écriture Prisma finale.
 *
 * **Préservation de la révocation de session** : `resetUserPassword()` (`src/lib/users.ts`,
 * politique MFA du 2026-08-30) ne se contente pas de hacher le nouveau mot de passe — elle
 * renseigne aussi `sessionRevokedAt`, pour qu'un changement de mot de passe invalide
 * immédiatement toute session déjà ouverte (`getSessionUser()`, `src/lib/authz.ts`, la revérifie
 * à chaque requête). Cette fonction TypeScript n'est pas importable ici (même contrainte que le
 * reste de ce script) — sa logique exacte est dupliquée fidèlement dans `performPasswordReset()`
 * ci-dessous : même hachage bcrypt (coût résolu par `resolveBcryptCost()`, dupliqué depuis
 * `src/lib/bcrypt-cost.ts`, même défaut 12), et le même `sessionRevokedAt: new Date()` dans la
 * même écriture — jamais l'un sans l'autre, pour ne jamais laisser une session déjà ouverte
 * valide après une réinitialisation. **Maintenance requise** : si `resetUserPassword()` évolue
 * (nouveau champ écrit, nouvelle notification de sécurité créée, nouvelle condition),
 * `performPasswordReset()` ci-dessous doit être mise à jour en miroir dans le même changement —
 * cette duplication n'est pas automatiquement synchronisée, elle dérivera silencieusement sinon.
 *
 * **Vérification préalable, jamais d'écriture à l'aveugle** : l'utilisateur cible est résolu et
 * affiché (email, tenant, rôle — jamais son `passwordHash`) avant toute demande de confirmation
 * ou de mot de passe. Abandon immédiat si l'email ne correspond à aucun utilisateur de
 * `xrent_test`.
 *
 * **Traçabilité** : une entrée `AuditLog` (`user.password_reset`, `userId: null` — action hors
 * bande, pas un acteur applicatif, même convention que `superadmin-mfa-recovery.js`) est créée
 * dans la même transaction que la réinitialisation, marquée `viaOutOfBandScript: true`.
 *
 * Même garde-fou que les autres scripts opérationnels : refuse de s'exécuter si `DATABASE_URL`
 * ne pointe pas vers `xrent_test` en local.
 *
 * **Structure du fichier (2026-09-17)** : la logique de validation, de résolution et d'écriture
 * est exportée en fonctions pures/injectées (voir `module.exports` en fin de fichier) pour être
 * testée directement (`src/__tests__/reset-test-user-password.test.ts`), même patron que
 * `scripts/env-guard.js`/`scripts/delete-test-tenant.mjs` — aucune de ces fonctions n'exécute
 * `process.exit`, ne lit `process.argv`/`process.stdin`, ni n'instancie `PrismaClient` : seul
 * `main()`, gardé par `require.main === module`, orchestre l'exécution CLI réelle. Importer ce
 * module (comme le fait le fichier de test) n'exécute donc jamais le script.
 */

const path = require("path");
const bcrypt = require("bcryptjs");
const readline = require("readline");
const { parseEnvFlag, loadEnvFileForEnv, assertDatabaseMatchesEnv, EnvironmentGuardError } = require("./env-guard");

/** Domaines synthétiques autorisés pour cette opération — allowlist explicite, jamais un accès
 * ouvert à n'importe quel email. Étendre cette liste est une décision délibérée, pas un défaut
 * permissif. */
const ALLOWED_TEST_EMAIL_DOMAINS = ["@test-xrent.local", "@superadmin.test.local"];

/** CLAUDE.md règle 11 — jamais utilisé pour un test/une démonstration, jamais ciblable ici,
 * même si un domaine autorisé venait un jour à le recouvrir par erreur (défense en profondeur,
 * indépendante de l'allowlist ci-dessus). */
const FORBIDDEN_REAL_SUPER_ADMIN_EMAIL = "saadscott123@gmail.com";

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

/** Refuse --password/--new-password en argument, quelle que soit leur valeur — jamais accepté
 * en ligne de commande (historique shell, liste des processus). Lève une Error simple (pas
 * EnvironmentGuardError : ceci ne concerne pas la sélection d'environnement). */
function assertNoPasswordArgFlags(flags) {
  if ("password" in flags || "new-password" in flags) {
    throw new Error(
      "Refusé : --password/--new-password ne sont jamais acceptés (exposition dans l'historique " +
        "shell et la liste des processus). Relancer sans ce paramètre — le mot de passe sera " +
        "demandé de façon interactive, écho masqué, avec confirmation."
    );
  }
}

/** Restriction supplémentaire, au-delà de env-guard : ce script n'accepte jamais --env=dev,
 * même si assertDatabaseMatchesEnv finirait de toute façon par le refuser si .env pointait vers
 * xrent_dev — refus explicite et immédiat, avant tout chargement de fichier d'environnement. */
function assertTestEnvOnly(env) {
  if (env !== "test") {
    throw new EnvironmentGuardError(
      `Refusé : ce script est réservé à xrent_test (--env=test obligatoire, reçu "${env}"). ` +
        "Jamais xrent_dev, jamais une base de production."
    );
  }
}

function normalizeEmail(rawEmail) {
  return rawEmail.trim().toLowerCase();
}

function isForbiddenEmail(normalizedEmail) {
  return normalizedEmail === FORBIDDEN_REAL_SUPER_ADMIN_EMAIL;
}

function isAllowedEmailDomain(normalizedEmail) {
  return ALLOWED_TEST_EMAIL_DOMAINS.some((domain) => normalizedEmail.endsWith(domain));
}

/** Comparaison stricte (après recadrage/normalisation de la ressaisie uniquement, jamais de la
 * valeur de référence qui est déjà normalisée) utilisée par la confirmation d'adresse avant
 * écriture — voir docblock en tête de fichier. Pure, jamais d'E/S : le flux interactif réel
 * (lecture stdin) reste dans main(), non testé automatiquement (TTY requis). */
function emailConfirmationMatches(typedRaw, expectedNormalizedEmail) {
  return typedRaw.trim().toLowerCase() === expectedNormalizedEmail;
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

// Même politique que src/lib/bcrypt-cost.ts (resolveBcryptCost), dupliquée ici pour la même
// raison que le reste de ce script.
function resolveBcryptCost() {
  const raw = process.env.BCRYPT_COST;
  if (!raw) return 12;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 4 || parsed > 31) return 12;
  return parsed;
}

/** Résolution en lecture seule de la cible — jamais `passwordHash` sélectionné. `prisma` est
 * injecté (jamais un singleton de module) pour rester testable contre la base de test partagée
 * (`@/lib/prisma`) sans jamais instancier un second client depuis ce fichier lors des tests. */
async function resolveTargetUser(prisma, normalizedEmail) {
  return prisma.user.findFirst({
    where: { email: normalizedEmail },
    select: {
      id: true,
      email: true,
      role: true,
      tenantId: true,
      tenant: { select: { name: true, slug: true } },
    },
  });
}

/**
 * Écriture réelle — réplique exactement resetUserPassword() (src/lib/users.ts) : hachage déjà
 * effectué par l'appelant (jamais recalculé ici) + révocation de session dans la même écriture,
 * jamais l'un sans l'autre, plus l'entrée d'audit hors bande. Voir l'avertissement de
 * maintenance dans le docblock en tête de fichier : à garder synchronisée avec
 * resetUserPassword() si celle-ci évolue. `prisma`/`target`/`passwordHash` sont tous injectés —
 * cette fonction ne lit jamais process.argv/process.stdin et n'écrit jamais le mot de passe en
 * clair (seul le hash, déjà calculé, est écrit).
 */
async function performPasswordReset(prisma, target, passwordHash) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: target.id },
      data: { passwordHash, sessionRevokedAt: now },
    });

    await tx.auditLog.create({
      data: {
        tenantId: target.tenantId,
        userId: null,
        action: "user.password_reset",
        resource: "User",
        resourceId: target.id,
        metadata: { viaOutOfBandScript: true },
      },
    });
  });
  return { sessionRevokedAt: now };
}

const CTRL_C = "";
const CTRL_D = "";
const BACKSPACE = "";

/** Identique à scripts/bootstrap-superadmin.js — lecture brute de stdin caractère par
 * caractère (mode raw), aucun caractère (y compris des astérisques) n'est réaffiché. Jamais
 * appelée par les tests automatisés (TTY requis) — voir docblock en tête de fichier. */
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

/** Saisie visible (l'adresse email n'est pas un secret) — même patron que
 * scripts/superadmin-mfa-recovery.js. Jamais appelée par les tests automatisés. */
function promptVisible(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function promptPasswordWithConfirmation() {
  const first = await promptHidden("Nouveau mot de passe (saisie masquée) : ");
  const second = await promptHidden("Confirmer le nouveau mot de passe : ");
  if (first !== second) {
    console.error("Les deux saisies ne correspondent pas. Abandon — aucune écriture effectuée.");
    process.exit(1);
  }
  return first;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = parseArgs(args);
  const confirmed = args.includes("--yes");

  try {
    assertNoPasswordArgFlags(flags);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  let env;
  try {
    env = parseEnvFlag(args, "Usage: node scripts/reset-test-user-password.js --env=test --user-email=<email> [--yes]");
    assertTestEnvOnly(env);
  } catch (error) {
    if (error instanceof EnvironmentGuardError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  let envFile, dbName, hostname;
  try {
    envFile = loadEnvFileForEnv(env, path.resolve(__dirname, ".."));
    ({ dbName, hostname } = assertDatabaseMatchesEnv(process.env.DATABASE_URL, env));
  } catch (error) {
    if (error instanceof EnvironmentGuardError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const targetEmailRaw = flags["user-email"];
  if (!targetEmailRaw) {
    console.error("Requis : --user-email=<email cible>");
    process.exit(1);
  }

  const normalizedEmail = normalizeEmail(targetEmailRaw);

  if (isForbiddenEmail(normalizedEmail)) {
    console.error(
      `Refusé : "${normalizedEmail}" est le compte réel de la plateforme — jamais ciblable par ` +
        "ce script, en aucune circonstance (CLAUDE.md règle 11)."
    );
    process.exit(1);
  }

  if (!isAllowedEmailDomain(normalizedEmail)) {
    console.error(
      `Refusé : "${normalizedEmail}" ne correspond à aucun domaine explicitement autorisé pour ` +
        `cette opération (${ALLOWED_TEST_EMAIL_DOMAINS.join(", ")}). Aucune écriture effectuée.`
    );
    process.exit(1);
  }

  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();

  try {
    console.log(`Environnement : ${env} (${envFile}) — base : ${dbName}@${hostname}`);

    const target = await resolveTargetUser(prisma, normalizedEmail);
    if (!target) {
      console.error(`Aucun utilisateur avec l'email "${normalizedEmail}" dans ${dbName}. Abandon.`);
      process.exitCode = 1;
      return;
    }

    console.log("\nCible résolue :");
    console.log(`  Email  : ${target.email}`);
    console.log(`  Tenant : ${target.tenant.name} (slug: ${target.tenant.slug})`);
    console.log(`  Rôle   : ${target.role}`);

    if (!confirmed) {
      console.log(
        "\nDry-run (aucune écriture effectuée, aucune confirmation demandée, aucun mot de passe " +
          "demandé). Relancer avec --yes pour réinitialiser réellement le mot de passe de ce compte."
      );
      return;
    }

    const typedEmail = await promptVisible(`\nPour confirmer, retaper l'email exact de la cible (${target.email}) : `);
    if (!emailConfirmationMatches(typedEmail, normalizedEmail)) {
      console.error("Email de confirmation différent. Abandon — aucune écriture effectuée.");
      process.exitCode = 1;
      return;
    }

    const password = await promptPasswordWithConfirmation();
    const passwordErrors = validatePassword(password);
    if (passwordErrors.length > 0) {
      console.error("Mot de passe invalide :");
      for (const error of passwordErrors) console.error(`  - ${error}`);
      process.exitCode = 1;
      return;
    }

    const passwordHash = await bcrypt.hash(password, resolveBcryptCost());
    await performPasswordReset(prisma, target, passwordHash);

    console.log(
      `\nMot de passe réinitialisé pour ${target.email} — toute session déjà ouverte a été ` +
        "révoquée (sessionRevokedAt renseigné), une reconnexion sera nécessaire."
    );
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = {
  ALLOWED_TEST_EMAIL_DOMAINS,
  FORBIDDEN_REAL_SUPER_ADMIN_EMAIL,
  parseArgs,
  assertNoPasswordArgFlags,
  assertTestEnvOnly,
  normalizeEmail,
  isForbiddenEmail,
  isAllowedEmailDomain,
  emailConfirmationMatches,
  validatePassword,
  resolveBcryptCost,
  resolveTargetUser,
  performPasswordReset,
};

if (require.main === module) {
  main().catch((error) => {
    console.error("Échec de la réinitialisation :", error);
    process.exitCode = 1;
  });
}
