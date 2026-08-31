#!/usr/bin/env node
/**
 * Suppression CIBLÉE d'un seul tenant de test — mode livraison efficace, phase 1.2 (2026-08-31).
 *
 * Distinct de scripts/reset-dev-data.js (qui purge TOUJOURS l'intégralité d'un environnement,
 * jamais un tenant précis) : cet outil n'accepte qu'une cible explicite (--tenant=<id> ou
 * --slug=<slug>), jamais un joker ni "tous les tenants". Réutilise le même ordre de suppression
 * que src/__tests__/helpers/fixtures.ts (deleteTestTenants), voir scripts/tenant-delete-order.mjs
 * — source de vérité unique partagée, pour ne jamais reproduire la divergence qui a causé
 * l'accumulation de tenants résiduels documentée par INCIDENTS.md INC-29.
 *
 * Usage :
 *   node scripts/delete-test-tenant.mjs --tenant=<id>            (dry-run : affiche le plan, rien supprimé)
 *   node scripts/delete-test-tenant.mjs --slug=<slug>             (idem, résolution par slug)
 *   node scripts/delete-test-tenant.mjs --tenant=<id> --yes       (exécute réellement la suppression)
 *
 * Garde-fous (aucun ne peut être contourné par un flag) :
 *   - Base cible : exclusivement `xrent_test` sur localhost/127.0.0.1 — .env.test chargé en dur,
 *     aucune option --env, refuse `xrent_dev`, la production et toute autre base.
 *   - Cible obligatoirement explicite : --tenant=<id> XOR --slug=<slug>, jamais les deux, jamais
 *     une valeur vide/joker ("*", "%", "all", "tous"...).
 *   - Tenants système protégés (refus inconditionnel, voir PROTECTED_TENANT_SLUGS/NAMES) : le
 *     tenant réel de la plateforme ("XRent Platform"/"xrent-platform") et l'environnement de
 *     validation manuelle curé TEST_XRENT ("test-xrent") — jamais supprimables par cet outil,
 *     quelle que soit la cible fournie.
 *   - Tout tenant contenant le compte réel interdit (saadscott123@gmail.com, CLAUDE.md règle 11)
 *     est refusé sans exception, même en dehors des deux cas ci-dessus.
 *   - Dry-run par défaut : sans --yes, affiche uniquement le plan (tenant résolu + comptages par
 *     table qui SERAIENT supprimées) — aucune écriture en base.
 *   - Une seule transaction Prisma, ordre de suppression identique et partagé avec les tests
 *     (scripts/tenant-delete-order.mjs).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { TENANT_MODEL_DELETE_ORDER } from "./tenant-delete-order.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Base autorisée : nom EXACT (pas seulement un suffixe `_test`) sur localhost/127.0.0.1 uniquement. */
export const ALLOWED_DB_NAME = "xrent_test";

export const PROTECTED_TENANT_SLUGS = new Set(["xrent-platform", "test-xrent"]);
export const PROTECTED_TENANT_NAMES = new Set(["XRent Platform", "TEST_XRENT"]);
/** CLAUDE.md règle 11 — jamais utilisé pour un test/une démonstration, jamais supprimable ici. */
export const FORBIDDEN_USER_EMAIL = "saadscott123@gmail.com";

const REJECTED_TARGET_VALUES = new Set(["", "*", "%", "all", "tous", "toutes", "tout"]);

/**
 * Vérification stricte de l'environnement — refuse tout ce qui n'est pas exactement
 * `xrent_test` en local. Aucune exception, aucun flag de contournement.
 */
export function assertTestDatabaseUrl(databaseUrl) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL introuvable.");
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL n'est pas une URL valide.");
  }
  const isLocalHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const dbName = parsed.pathname.slice(1);
  if (!isLocalHost || dbName !== ALLOWED_DB_NAME) {
    throw new Error(
      `Garde-fou : cette commande n'accepte que la base de test locale "${ALLOWED_DB_NAME}" ` +
        `(reçu : ${parsed.hostname || "(hôte vide)"}/${dbName || "(nom vide)"}). ` +
        `xrent_dev, la production et toute autre base sont refusées sans exception.`
    );
  }
  return { hostname: parsed.hostname, dbName };
}

/** Cible obligatoirement explicite : --tenant=<id> XOR --slug=<slug>, jamais de joker/valeur vide. */
export function parseArgs(argv) {
  const tenantArg = argv.find((a) => a.startsWith("--tenant="));
  const slugArg = argv.find((a) => a.startsWith("--slug="));
  const confirmed = argv.includes("--yes");

  if (tenantArg && slugArg) {
    throw new Error("Fournir --tenant=<id> OU --slug=<slug>, jamais les deux à la fois.");
  }
  if (!tenantArg && !slugArg) {
    throw new Error(
      "Usage : node scripts/delete-test-tenant.mjs (--tenant=<id> | --slug=<slug>) [--yes]"
    );
  }

  const rawValue = (tenantArg ?? slugArg).split("=").slice(1).join("=");
  const value = rawValue.trim();
  if (REJECTED_TARGET_VALUES.has(value.toLowerCase())) {
    throw new Error(
      `Valeur refusée pour ${tenantArg ? "--tenant" : "--slug"} : une cible explicite (id ou slug réel) ` +
        `est requise, jamais un joker ni une valeur vide.`
    );
  }

  return { tenantId: tenantArg ? value : null, slug: slugArg ? value : null, confirmed };
}

/** Résolution stricte : la cible doit exister, aucune suppression silencieuse d'une cible absente. */
export async function resolveTenant(prisma, { tenantId, slug }) {
  const tenant = tenantId
    ? await prisma.tenant.findUnique({ where: { id: tenantId } })
    : await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    throw new Error(
      `Aucun tenant trouvé pour ${tenantId ? `id="${tenantId}"` : `slug="${slug}"`} — aucune suppression possible.`
    );
  }
  return tenant;
}

/** Protection des tenants système — refus inconditionnel, aucun flag de contournement. */
export function checkProtectedTenant(tenant, users) {
  const reasons = [];
  if (tenant.slug && PROTECTED_TENANT_SLUGS.has(tenant.slug)) {
    reasons.push(`slug protégé ("${tenant.slug}")`);
  }
  if (tenant.name && PROTECTED_TENANT_NAMES.has(tenant.name)) {
    reasons.push(`nom protégé ("${tenant.name}")`);
  }
  const forbiddenUser = users.find(
    (u) => typeof u.email === "string" && u.email.toLowerCase() === FORBIDDEN_USER_EMAIL.toLowerCase()
  );
  if (forbiddenUser) {
    reasons.push(`contient le compte réel interdit (${FORBIDDEN_USER_EMAIL}, CLAUDE.md règle 11)`);
  }
  return { protected: reasons.length > 0, reasons };
}

/**
 * Comptages par table pour les tenants ciblés — utilisé pour le dry-run ET la vérification
 * post-suppression.
 * @returns {Promise<Record<string, number>>}
 */
export async function countTenantGraph(prisma, tenantIds) {
  const counts = {};
  for (const { model, where } of TENANT_MODEL_DELETE_ORDER) {
    counts[model] = await prisma[model].count({ where: where(tenantIds) });
  }
  counts.tenant = await prisma.tenant.count({ where: { id: { in: tenantIds } } });
  return counts;
}

/** Exécution réelle — une seule transaction, ordre partagé avec les tests (tenant-delete-order.mjs). */
export async function deleteTenantGraph(prisma, tenantIds) {
  await prisma.$transaction([
    ...TENANT_MODEL_DELETE_ORDER.map(({ model, where }) => prisma[model].deleteMany({ where: where(tenantIds) })),
    prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }),
  ]);
}

function printCounts(counts) {
  for (const [model, count] of Object.entries(counts)) {
    console.log(`  ${model.padEnd(18)} ${count}`);
  }
}

async function main() {
  loadDotenv({ path: path.resolve(__dirname, "..", ".env.test"), override: true });

  const { dbName, hostname } = assertTestDatabaseUrl(process.env.DATABASE_URL);
  console.log(`Base ciblée : ${dbName}@${hostname} (xrent_test uniquement, vérifié).`);

  const { tenantId, slug, confirmed } = parseArgs(process.argv.slice(2));

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  try {
    const tenant = await resolveTenant(prisma, { tenantId, slug });
    const users = await prisma.user.findMany({ where: { tenantId: tenant.id }, select: { email: true } });

    const { protected: isProtected, reasons } = checkProtectedTenant(tenant, users);
    if (isProtected) {
      console.error(
        `\nRefusé : tenant protégé ("${tenant.name}", slug="${tenant.slug}", id="${tenant.id}") — ${reasons.join(", ")}.`
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `\nTenant ciblé : "${tenant.name}" (slug="${tenant.slug}", id="${tenant.id}"), créé le ${tenant.createdAt.toISOString()}.`
    );

    const before = await countTenantGraph(prisma, [tenant.id]);
    console.log("\nLignes qui seront supprimées :");
    printCounts(before);

    if (!confirmed) {
      console.log(
        "\nDry-run (aucune suppression effectuée). Relancer avec --yes pour exécuter réellement la " +
          "suppression de CE tenant uniquement."
      );
      return;
    }

    console.log("\nSuppression en cours...");
    await deleteTenantGraph(prisma, [tenant.id]);

    const after = await countTenantGraph(prisma, [tenant.id]);
    console.log("\nTerminé. Comptages après suppression (attendu : 0 partout) :");
    printCounts(after);

    const anyNonZero = Object.values(after).some((count) => count !== 0);
    if (anyNonZero) {
      throw new Error("Au moins une table n'est pas vide après suppression — voir le détail ci-dessus.");
    }

    console.log(`\nTenant "${tenant.name}" (id="${tenant.id}") intégralement supprimé de xrent_test. Aucun autre tenant affecté.`);
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((error) => {
    console.error("Échec :", error?.message ?? error);
    process.exitCode = 1;
  });
}
