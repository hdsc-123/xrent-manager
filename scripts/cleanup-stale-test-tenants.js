#!/usr/bin/env node
/**
 * Nettoyage EN MASSE des tenants de test résiduels de xrent_test — Phase 6.2 (2026-09-01),
 * étape 2 du contrôle post-Phase 6.1 : `npx vitest run` (et `test-grouped.mjs`) créent des
 * dizaines de tenants par exécution, nettoyés en principe par `deleteTestTenants`
 * (src/__tests__/helpers/fixtures.ts) dans chaque `afterAll` — mais un fichier de test qui
 * timeout/crash avant son `afterAll`, ou une interruption manuelle (Ctrl+C) de la suite, laisse
 * ce tenant orphelin en base indéfiniment (cause déjà documentée par INCIDENTS.md INC-29 pour
 * l'ordre de suppression lui-même ; ce script traite la même famille de symptôme mais pour des
 * tenants jamais nettoyés du tout, pas mal ordonnés).
 *
 * Distinct de `scripts/delete-test-tenant.mjs` (une seule cible explicite --tenant/--slug) :
 * celui-ci cible TOUS les tenants non protégés de xrent_test à la fois. Réutilise sans les
 * dupliquer les mêmes primitives déjà testées et validées (jamais une seconde implémentation
 * divergente, cause racine d'INC-29) :
 *   - scripts/tenant-delete-order.mjs (TENANT_MODEL_DELETE_ORDER, via delete-test-tenant.mjs)
 *   - scripts/delete-test-tenant.mjs : PROTECTED_TENANT_SLUGS/NAMES, FORBIDDEN_USER_EMAIL,
 *     checkProtectedTenant, countTenantGraph, deleteTenantGraph — importés dynamiquement (ce
 *     fichier est CommonJS comme ses pairs opérationnels, delete-test-tenant.mjs est ESM).
 *
 * Garde-fous (aucun ne peut être contourné par un flag) :
 *   - env-guard.js, exactement comme les 5 autres scripts opérationnels CommonJS de ce projet —
 *     mais avec l'environnement figé en dur à "test" (jamais de flag --env ici : ce script ne
 *     doit *jamais* pouvoir cibler xrent_dev, même par une erreur de frappe sur la ligne de
 *     commande).
 *   - Tenants protégés exclus inconditionnellement (voir checkProtectedTenant) : le tenant réel
 *     de la plateforme, TEST_XRENT (environnement de validation manuelle curé), et tout tenant
 *     contenant le compte réel interdit (saadscott123@gmail.com, CLAUDE.md règle 11).
 *   - `--min-age-hours` (défaut 1) : exclut les tenants créés trop récemment pour être
 *     raisonnablement considérés comme orphelins — une suite de tests légitime peut être en
 *     cours d'exécution ailleurs au moment où ce script tourne ; ses tenants pas encore nettoyés
 *     par leur propre `afterAll` ne doivent jamais être supprimés sous ses pieds.
 *   - Dry-run par défaut : sans --yes, affiche uniquement le plan (tenants ciblés, comptages
 *     agrégés par table qui SERAIENT supprimés) — aucune écriture en base.
 *   - Une seule transaction Prisma pour l'ensemble du lot (deleteTenantGraph, comportement
 *     inchangé et déjà validé — seule la taille du lot de tenantIds change par rapport à
 *     delete-test-tenant.mjs).
 *
 * Usage :
 *   node scripts/cleanup-stale-test-tenants.js                        (dry-run, min-age 1h)
 *   node scripts/cleanup-stale-test-tenants.js --min-age-hours=24     (dry-run, min-age 24h)
 *   node scripts/cleanup-stale-test-tenants.js --min-age-hours=24 --yes   (exécute réellement)
 */
const path = require("path");
const {
  EnvironmentGuardError,
  loadEnvFileForEnv,
  assertDatabaseMatchesEnv,
} = require("./env-guard");

const DEFAULT_MIN_AGE_HOURS = 1;

function parseArgs(argv) {
  const confirmed = argv.includes("--yes");
  const minAgeArg = argv.find((a) => a.startsWith("--min-age-hours="));
  const minAgeHours = minAgeArg ? Number(minAgeArg.split("=")[1]) : DEFAULT_MIN_AGE_HOURS;
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) {
    throw new EnvironmentGuardError("--min-age-hours doit être un nombre positif ou nul.");
  }
  return { confirmed, minAgeHours };
}

function printCounts(counts) {
  for (const [model, count] of Object.entries(counts)) {
    console.log(`  ${model.padEnd(18)} ${count}`);
  }
}

async function main() {
  let envFile, dbName, hostname;
  try {
    envFile = loadEnvFileForEnv("test", path.resolve(__dirname, ".."));
    ({ dbName, hostname } = assertDatabaseMatchesEnv(process.env.DATABASE_URL, "test"));
  } catch (error) {
    if (error instanceof EnvironmentGuardError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  console.log(`Environnement : test (${envFile}) — base : ${dbName}@${hostname}.`);

  const { confirmed, minAgeHours } = parseArgs(process.argv.slice(2));

  const {
    PROTECTED_TENANT_SLUGS,
    checkProtectedTenant,
    countTenantGraph,
    deleteTenantGraph,
  } = await import("./delete-test-tenant.mjs");

  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();

  try {
    const tenants = await prisma.tenant.findMany({
      select: { id: true, name: true, slug: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    console.log(`\nTotal tenants dans ${dbName} : ${tenants.length}`);

    const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000);
    const candidates = [];
    const skippedProtected = [];
    const skippedTooRecent = [];

    for (const tenant of tenants) {
      const users = await prisma.user.findMany({ where: { tenantId: tenant.id }, select: { email: true } });
      const { protected: isProtected, reasons } = checkProtectedTenant(tenant, users);
      if (isProtected) {
        skippedProtected.push({ tenant, reasons });
        continue;
      }
      if (tenant.createdAt > cutoff) {
        skippedTooRecent.push(tenant);
        continue;
      }
      candidates.push(tenant);
    }

    console.log(`\nTenants protégés exclus (jamais candidats) : ${skippedProtected.length}`);
    for (const { tenant, reasons } of skippedProtected) {
      console.log(`  - "${tenant.name}" (slug=${tenant.slug ?? "(aucun)"}) — ${reasons.join(", ")}`);
    }

    console.log(
      `\nTenants trop récents exclus (< ${minAgeHours}h, suite de tests potentiellement en cours) : ${skippedTooRecent.length}`
    );

    console.log(`\nTenants candidats à la suppression (> ${minAgeHours}h, non protégés) : ${candidates.length}`);
    if (candidates.length === 0) {
      console.log("Aucun tenant candidat — rien à faire.");
      return;
    }

    const candidateIds = candidates.map((t) => t.id);
    const before = await countTenantGraph(prisma, candidateIds);
    console.log("\nLignes qui seront supprimées (agrégé sur tous les tenants candidats) :");
    printCounts(before);

    if (!confirmed) {
      console.log(
        "\nDry-run (aucune suppression effectuée). Relancer avec --yes pour exécuter réellement la suppression " +
          `de ces ${candidates.length} tenant(s).`
      );
      return;
    }

    console.log(`\nSuppression en cours (${candidates.length} tenant(s), une seule transaction)...`);
    await deleteTenantGraph(prisma, candidateIds);

    const after = await countTenantGraph(prisma, candidateIds);
    console.log("\nTerminé. Comptages après suppression (attendu : 0 partout) :");
    printCounts(after);

    const anyNonZero = Object.values(after).some((count) => count !== 0);
    if (anyNonZero) {
      throw new Error("Au moins une table n'est pas vide après suppression — voir le détail ci-dessus.");
    }

    const remainingTenants = await prisma.tenant.count();
    console.log(
      `\n${candidates.length} tenant(s) supprimé(s) de ${dbName}. Tenants restants : ${remainingTenants} ` +
        `(protégés + trop récents).`
    );
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = require.main === module;
if (isMainModule) {
  main().catch((error) => {
    console.error("Échec :", error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs };
