/**
 * Procédure opérateur hors bande de récupération MFA du Super Admin (2026-08-30, brief
 * explicite du propriétaire du projet, politique MFA point 7).
 *
 * Aucune route HTTP ne peut jamais réinitialiser la MFA d'un compte Super Admin (voir
 * POST /api/mfa/admin-reset et POST /api/mfa/disable, src/app/api/mfa/*) — un Super Admin étant
 * généralement seul ADMIN de son propre tenant dédié (src/lib/super-admin.ts), il n'existe
 * souvent aucun pair capable de déclencher un reset assisté ordinaire, et l'exposer en HTTP
 * romprait le principe "aucun bypass HTTP pour un Super Admin unique sans pair ADMIN" déjà
 * documenté (SECURITY.md section 45). Ce script est donc le seul moyen de récupération —
 * jamais exposé en HTTP, exécuté uniquement en local par un opérateur, même précédent que
 * scripts/bootstrap-superadmin.js.
 *
 * Effectue exactement la même purge que purgeMfaAndRevokeSessions (src/lib/mfa-session.ts),
 * dupliquée ici en Prisma brut pour la même raison que le reste de ce script (module TypeScript
 * non importable depuis ce script CommonJS autonome, voir bootstrap-superadmin.js) :
 * mfaEnabled=false, secret/date de confirmation/dernier pas TOTP purgés, tous les
 * MfaRecoveryCode/MfaStepUpProof supprimés, mfaSecurityStamp roté, sessionRevokedAt renseigné —
 * révoque donc aussi la session courante de la cible au prochain appel (comportement voulu,
 * même garantie que la désactivation MFA personnelle).
 *
 * Vérification renforcée : la cible doit être résolue par email exact ET doit correspondre à
 * SUPER_ADMIN_EMAILS (même logique que isSuperAdminEmail, src/lib/super-admin.ts, dupliquée ici
 * pour la même raison) — refuse d'agir sur un compte qui ne serait pas réellement Super Admin
 * (ce script n'est pas un raccourci générique de reset MFA, seulement la procédure dédiée à ce
 * cas précis). Confirmation explicite par ressaisie de l'email cible avant toute écriture, en
 * plus de --yes — aucun mot de passe/code n'est demandé (l'opérateur agit hors bande, avec un
 * accès direct à la base, pas via une preuve d'identité applicative).
 *
 * Usage :
 *   node scripts/superadmin-mfa-recovery.js --env=dev \
 *     --admin-email="toi@exemple.test" --reason="Téléphone perdu, TOTP inaccessible" \
 *     --yes
 *
 * Dry-run par défaut (sans --yes) : affiche l'état actuel de la MFA de la cible sans rien
 * écrire, sans demander de confirmation.
 *
 * Même garde-fou que scripts/reset-dev-data.js/bootstrap-superadmin.js : refuse de s'exécuter
 * si DATABASE_URL ne pointe pas vers une base *_dev/*_test locale.
 */

const path = require("path");
const readline = require("readline");
const crypto = require("crypto");
const { parseEnvFlag, loadEnvFileForEnv, assertDatabaseMatchesEnv, EnvironmentGuardError } = require("./env-guard");

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

let env, envFile, dbName, hostname;
try {
  env = parseEnvFlag(
    args,
    "Usage: node scripts/superadmin-mfa-recovery.js --env=dev|test --admin-email=... --reason=... [--yes]"
  );
  envFile = loadEnvFileForEnv(env, path.resolve(__dirname, ".."));
  ({ dbName, hostname } = assertDatabaseMatchesEnv(process.env.DATABASE_URL, env));
} catch (error) {
  if (error instanceof EnvironmentGuardError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const adminEmail = flags["admin-email"];
const reason = flags.reason;

if (!adminEmail || !reason || !reason.trim()) {
  console.error("Requis : --admin-email, --reason (motif obligatoire, conservé dans l'audit).");
  process.exit(1);
}

// Même logique que isSuperAdminEmail (src/lib/super-admin.ts), dupliquée ici (voir le
// commentaire d'en-tête). Ne lit jamais SUPER_ADMIN_EMAILS ailleurs que depuis l'env chargé
// ci-dessus (mêmes fichiers .env que l'application elle-même).
function isSuperAdminEmail(email) {
  const raw = process.env.SUPER_ADMIN_EMAILS;
  if (!raw || !email) return false;
  const normalizedEmail = email.trim().toLowerCase();
  const entries = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return entries.some((entry) => (entry.startsWith("@") ? normalizedEmail.endsWith(entry) : normalizedEmail === entry));
}

function promptVisible(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const SECURITY_NOTIFICATION_MESSAGE_MFA_RESET =
  "La MFA de votre compte a été réinitialisée par un administrateur. Une reconnexion est nécessaire.";

async function main() {
  console.log(`Environnement : ${env} (${envFile}) — base : ${dbName}@${hostname}`);

  const normalizedEmail = adminEmail.trim().toLowerCase();

  if (!isSuperAdminEmail(normalizedEmail)) {
    console.error(
      `Refusé : "${normalizedEmail}" ne correspond à aucune entrée de SUPER_ADMIN_EMAILS dans ${envFile}. ` +
        "Cette procédure est réservée à la récupération MFA d'un Super Admin — pour tout autre compte, " +
        "utiliser POST /api/mfa/admin-reset (reset assisté par un pair ADMIN) depuis l'application."
    );
    process.exit(1);
  }

  const target = await prisma.user.findFirst({ where: { email: normalizedEmail } });
  if (!target) {
    console.error(`Aucun utilisateur avec l'email "${normalizedEmail}". Abandon.`);
    process.exit(1);
  }

  console.log(`\nCible : ${target.name} <${target.email}> (id ${target.id}, tenant ${target.tenantId})`);
  console.log(`  MFA activée : ${target.mfaEnabled ? "oui" : "non"}`);
  console.log(`  Motif fourni : ${reason}`);

  if (!target.mfaEnabled) {
    console.log("\nMFA déjà désactivée sur ce compte — rien à faire.");
    return;
  }

  if (!confirmed) {
    console.log("\nDry-run (aucune écriture effectuée). Relancer avec --yes pour exécuter la purge MFA + révocation de session.");
    return;
  }

  const typedEmail = await promptVisible(`\nPour confirmer, retaper l'email exact de la cible (${normalizedEmail}) : `);
  if (typedEmail.trim().toLowerCase() !== normalizedEmail) {
    console.error("Email de confirmation différent. Abandon — aucune écriture effectuée.");
    process.exit(1);
  }

  const now = new Date();
  const newStamp = crypto.randomUUID();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: target.id },
      data: {
        mfaEnabled: false,
        mfaSecretCiphertext: null,
        mfaSecretConfirmedAt: null,
        mfaLastUsedStep: null,
        mfaSecurityStamp: newStamp,
        sessionRevokedAt: now,
      },
    });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: target.id } });
    await tx.mfaStepUpProof.deleteMany({ where: { userId: target.id } });

    // userId: null — aucun acteur applicatif, cette action est déclenchée hors bande par un
    // opérateur avec accès direct à la base (voir le commentaire d'en-tête). Le motif et le
    // marqueur `viaOutOfBandScript` distinguent cette entrée de POST /api/mfa/admin-reset.
    await tx.auditLog.create({
      data: {
        tenantId: target.tenantId,
        userId: null,
        action: "mfa.admin_reset",
        resource: "User",
        resourceId: target.id,
        metadata: { targetUserId: target.id, reason, viaOutOfBandScript: true },
      },
    });

    await tx.securityNotification.create({
      data: {
        tenantId: target.tenantId,
        userId: target.id,
        type: "MFA_RESET",
        message: SECURITY_NOTIFICATION_MESSAGE_MFA_RESET,
      },
    });
  });

  console.log(`\nMFA réinitialisée pour ${target.email} — sessions actives révoquées, notification de sécurité créée.`);
}

main()
  .catch((error) => {
    console.error("Échec de la récupération MFA :", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
