/**
 * Source de vérité UNIQUE pour l'ordre de suppression d'un ou plusieurs tenants, dans le respect
 * des contraintes de clé étrangère réelles de prisma/schema.prisma (vérifiées une à une par
 * lecture directe des migrations, pas supposées — voir src/__tests__/helpers/fixtures.ts pour le
 * détail du raisonnement modèle par modèle).
 *
 * Partagée entre deux consommateurs qui avaient auparavant chacun leur propre liste, jamais
 * resynchronisée entre elles ni avec le schéma (cause racine de l'accumulation de tenants
 * résiduels dans xrent_test, voir INCIDENTS.md INC-29) :
 *   - src/__tests__/helpers/fixtures.ts (deleteTestTenants, nettoyage `afterAll` des tests)
 *   - scripts/delete-test-tenant.mjs (suppression ciblée opérationnelle d'un seul tenant)
 *
 * Fichier `.mjs` plutôt que `.ts` : scripts/ est exécuté directement par `node` (sans étape de
 * compilation, comme scripts/reset-dev-data.js/test-grouped.mjs), alors que
 * src/__tests__/helpers/fixtures.ts est compilé par Vitest/esbuild — les deux savent importer un
 * module ESM `.mjs` par chemin relatif explicite (déjà le cas pour scripts/test-grouped.mjs,
 * importé depuis src/__tests__/test-grouped-integrity.test.ts).
 *
 * Chaque entrée décrit un modèle Prisma et la clause `where` (fonction pure des tenantId ciblés)
 * à utiliser pour ne supprimer QUE les lignes de ces tenants. Les tables en cascade réelle
 * (`onDelete: Cascade` sur `User`/`PermissionGroup` — UserPermission, Account, Session,
 * SecurityNotification, MfaRecoveryCode, MfaStepUpProof, GroupPermission) ne sont pas listées,
 * gérées automatiquement par Postgres à la suppression de User/PermissionGroup ci-dessous.
 * `tenant` lui-même n'est pas dans cette liste (filtré par `id`, pas par `tenantId` — géré à part
 * par chaque appelant, toujours en tout dernier).
 */
export const TENANT_MODEL_DELETE_ORDER = [
  { model: "damageInvoiceLine", where: (ids) => ({ damage: { tenantId: { in: ids } } }) },
  { model: "locationUpgrade", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "payment", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "damage", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "cashEntry", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "damageInvoice", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "invoice", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "location", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "reservation", where: (ids) => ({ tenantId: { in: ids } }) },
  // Phase 6.1 (2026-08-31) — compteur du numéro de réservation interne, FK directe vers Tenant
  // (ReservationNumberCounter_tenantId_fkey) : doit être supprimé avant `tenant` lui-même, comme
  // toute autre table de cette liste (voir INCIDENTS.md INC-29, cause racine déjà documentée —
  // une entrée manquante ici bloque la suppression du tenant avec une violation de contrainte).
  { model: "reservationNumberCounter", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "maintenance", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "vehicleTransfer", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "vehicleTrip", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "alert", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "vehicle", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "cashRegister", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "client", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "invitation", where: (ids) => ({ tenantId: { in: ids } }) },
  {
    model: "userAgency",
    where: (ids) => ({ OR: [{ user: { tenantId: { in: ids } } }, { agency: { tenantId: { in: ids } } }] }),
  },
  { model: "permissionGroup", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "auditLog", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "user", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "agency", where: (ids) => ({ tenantId: { in: ids } }) },
  { model: "expenseCategory", where: (ids) => ({ tenantId: { in: ids } }) },
];
