import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { BCRYPT_COST } from "@/lib/bcrypt-cost";
import { ensureDefaultGroups } from "@/lib/permissions";
import { apiFetch, extractSessionCookie } from "./http";
import { TENANT_MODEL_DELETE_ORDER } from "../../../scripts/tenant-delete-order.mjs";

export interface AuthenticatedTestUser {
  tenantId: string;
  userId: string;
  email: string;
  sessionCookie: string;
}

export interface CreatedTenantAdmin {
  tenantId: string;
  userId: string;
  email: string;
}

/**
 * Bootstrap de tenant pour les tests — création directe via Prisma, pas via HTTP, sans
 * connexion. Séparée de `registerTenantAdmin` ci-dessous pour les rares cas où la connexion
 * immédiate serait ambiguë (ex. deux tenants partageant volontairement le même email, voir
 * auth.test.ts « Résolution du tenant à la connexion »).
 *
 * Jusqu'au 2026-08-29, la création de tenant passait par `POST /api/auth/register` (auto-
 * inscription publique). Cette route a été retirée (DOMAINRULES.md, création de tenant réservée
 * au Super Admin plateforme, voir src/lib/super-admin.ts) : la création de tenant n'est plus un
 * parcours public à exercer depuis un test HTTP. Reproduit ici exactement ce que faisait
 * l'ancienne route (tenant + premier ADMIN + groupes de permissions par défaut), même précédent
 * que `createAndLoginMember` ci-dessous qui crée déjà un MEMBER directement via Prisma.
 */
// INC-3-DIAG (2026-09-03) — instrumentation temporaire, à retirer après diagnostic (voir
// src/__tests__/helpers/http.ts, même tag, même convention de sortie sur stderr).
function diagInc3(event: string, data: Record<string, unknown> = {}): void {
  process.stderr.write(`[INC-3-DIAG] ${Date.now()} ${event} ${JSON.stringify(data)}\n`);
}

export async function createTenantAdmin(params: {
  tenantName: string;
  tenantSlug: string;
  name: string;
  email: string;
  password: string;
}): Promise<CreatedTenantAdmin> {
  diagInc3("createTenantAdmin:enter", { email: params.email });

  diagInc3("bcrypt.hash:start", { email: params.email, cost: BCRYPT_COST });
  const passwordHash = await bcrypt.hash(params.password, BCRYPT_COST);
  diagInc3("bcrypt.hash:end", { email: params.email });

  diagInc3("prisma.$transaction:start", { email: params.email });
  const { tenant, user } = await prisma.$transaction(async (tx) => {
    diagInc3("prisma.tenant.create:start", { email: params.email, slug: params.tenantSlug });
    const tenant = await tx.tenant.create({
      data: { name: params.tenantName, slug: params.tenantSlug },
    });
    diagInc3("prisma.tenant.create:end", { email: params.email, tenantId: tenant.id });

    diagInc3("prisma.user.create:start", { email: params.email, tenantId: tenant.id });
    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: params.email,
        name: params.name,
        passwordHash,
        role: "ADMIN",
      },
    });
    diagInc3("prisma.user.create:end", { email: params.email, userId: user.id });
    return { tenant, user };
  });
  diagInc3("prisma.$transaction:end", { email: params.email, tenantId: tenant.id, userId: user.id });

  diagInc3("ensureDefaultGroups:start", { email: params.email, tenantId: tenant.id });
  await ensureDefaultGroups(tenant.id);
  diagInc3("ensureDefaultGroups:end", { email: params.email, tenantId: tenant.id });

  diagInc3("createTenantAdmin:exit", { email: params.email, tenantId: tenant.id, userId: user.id });
  return { tenantId: tenant.id, userId: user.id, email: params.email };
}

/** `createTenantAdmin` ci-dessus, suivi d'une vraie connexion HTTP (`/api/auth/login`) — pour
 * garder réaliste tout ce qui dépend du comportement de connexion (session, rate limiting,
 * etc.). Ne pas utiliser si l'email fourni existe déjà dans un autre tenant : la connexion
 * deviendrait ambiguë (voir `createTenantAdmin`). */
export async function registerTenantAdmin(params: {
  tenantName: string;
  tenantSlug: string;
  name: string;
  email: string;
  password: string;
}): Promise<AuthenticatedTestUser> {
  diagInc3("registerTenantAdmin:enter", { email: params.email });
  const created = await createTenantAdmin(params);
  diagInc3("registerTenantAdmin:createTenantAdmin-done", { email: params.email, tenantId: created.tenantId });

  diagInc3("registerTenantAdmin:before-login-apiFetch", { email: params.email });
  const loginResponse = await apiFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: params.email, password: params.password }),
  });
  diagInc3("registerTenantAdmin:after-login-apiFetch", { email: params.email, status: loginResponse.status });
  const sessionCookie = extractSessionCookie(loginResponse);

  if (!sessionCookie) {
    throw new Error("Échec de la connexion de test : aucun cookie de session reçu.");
  }

  return { ...created, sessionCookie };
}

/**
 * Suppression complète et déterministe d'un ou plusieurs tenants de test, dans l'ordre imposé
 * par les contraintes de clé étrangère réelles de prisma/schema.prisma (vérifiées une à une par
 * lecture directe des migrations, pas supposées) — un seul endroit à maintenir plutôt qu'une
 * liste dupliquée dans chaque fichier de test, recopiée et adaptée au fil des sprints sans
 * jamais être revérifiée contre le schéma complet. Cause racine de l'accumulation de tenants
 * résiduels dans xrent_test (voir HANDOFF.md, nettoyage du 2026-08-31) : cette divergence
 * silencieuse — une liste locale oubliant une table ajoutée par un sprint ultérieur (Damage/
 * DamageInvoice/LocationUpgrade/SecurityNotification...) — fait échouer un `deleteMany`
 * intermédiaire (contrainte de clé étrangère non respectée), ce qui interrompt tout le reste de
 * la chaîne `await` séquentielle et empêche `prisma.tenant.deleteMany()` (toujours en dernier)
 * de jamais s'exécuter — le tenant entier reste alors orphelin, silencieusement, sans qu'aucun
 * test n'échoue de façon visible. Quatre fichiers avaient même perdu toute suppression réelle du
 * tenant (un unique `deleteMany` partiel avalé par un `.catch(() => undefined)`).
 *
 * Ordre ci-dessous (enfants avant parents) : les relations obligatoires sans `onDelete` explicite
 * sont RESTRICT par défaut (bloquent la suppression du parent tant qu'une ligne y fait encore
 * référence) ; les relations optionnelles sans surcharge sont SET NULL par défaut (gérées
 * automatiquement par Postgres, pas besoin d'ordre) ; UserPermission/Account/Session/
 * SecurityNotification/MfaRecoveryCode/MfaStepUpProof (onDelete: Cascade sur `user`) et
 * GroupPermission (onDelete: Cascade sur `group`) sont donc purgées automatiquement à la
 * suppression de User/PermissionGroup ci-dessous, sans ligne dédiée ici.
 *
 * L'ordre lui-même vit dans scripts/tenant-delete-order.mjs (TENANT_MODEL_DELETE_ORDER),
 * partagé avec scripts/delete-test-tenant.mjs (suppression ciblée opérationnelle d'un seul
 * tenant) — exactement pour ne plus jamais reproduire la divergence qui a causé INC-29.
 */
export async function deleteTestTenants(tenantIds: string[]): Promise<void> {
  const ids = [...new Set(tenantIds)].filter(Boolean);
  if (ids.length === 0) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- délégué Prisma dynamique, partagé avec scripts/delete-test-tenant.mjs (JS, non typé).
  const client = prisma as any;
  await prisma.$transaction([
    ...TENANT_MODEL_DELETE_ORDER.map(({ model, where }: { model: string; where: (ids: string[]) => object }) =>
      client[model].deleteMany({ where: where(ids) })
    ),
    prisma.tenant.deleteMany({ where: { id: { in: ids } } }),
  ]);
}

export async function createAndLoginMember(params: {
  tenantId: string;
  name: string;
  email: string;
  password: string;
}): Promise<AuthenticatedTestUser> {
  const passwordHash = await bcrypt.hash(params.password, BCRYPT_COST);
  const user = await prisma.user.create({
    data: {
      tenantId: params.tenantId,
      email: params.email,
      name: params.name,
      passwordHash,
      role: "MEMBER",
    },
  });

  const loginResponse = await apiFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: params.email, password: params.password }),
  });
  const sessionCookie = extractSessionCookie(loginResponse);

  if (!sessionCookie) {
    throw new Error("Échec de la connexion du membre de test.");
  }

  return { tenantId: params.tenantId, userId: user.id, email: params.email, sessionCookie };
}
