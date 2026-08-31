import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTenantAdmin, deleteTestTenants } from "./helpers/fixtures";
import {
  ALLOWED_DB_NAME,
  FORBIDDEN_USER_EMAIL,
  PROTECTED_TENANT_NAMES,
  PROTECTED_TENANT_SLUGS,
  assertTestDatabaseUrl,
  checkProtectedTenant,
  countTenantGraph,
  deleteTenantGraph,
  parseArgs,
  resolveTenant,
} from "../../scripts/delete-test-tenant.mjs";

/**
 * Mode livraison efficace, phase 1.2 (2026-08-31) — mécanisme de suppression CIBLÉE d'un seul
 * tenant de test (scripts/delete-test-tenant.mjs), distinct de scripts/reset-dev-data.js (purge
 * toujours l'environnement entier). Ce fichier prouve chaque garde-fou séparément (base autorisée,
 * cible explicite obligatoire, tenants système protégés) puis le mécanisme complet contre une
 * vraie base xrent_test, sur des tenants jetables créés par le test lui-même — jamais sur un
 * tenant réel préexistant.
 */
describe("scripts/delete-test-tenant.mjs — suppression ciblée d'un tenant de test", () => {
  describe("assertTestDatabaseUrl — vérification stricte de l'environnement", () => {
    it(`accepte exactement "${ALLOWED_DB_NAME}" sur localhost`, () => {
      expect(() => assertTestDatabaseUrl(`postgresql://sh@localhost:5432/${ALLOWED_DB_NAME}?schema=public`)).not.toThrow();
    });

    it(`accepte exactement "${ALLOWED_DB_NAME}" sur 127.0.0.1`, () => {
      expect(() => assertTestDatabaseUrl(`postgresql://sh@127.0.0.1:5432/${ALLOWED_DB_NAME}`)).not.toThrow();
    });

    it("refuse xrent_dev", () => {
      expect(() => assertTestDatabaseUrl("postgresql://sh@localhost:5432/xrent_dev")).toThrow(/xrent_test/);
    });

    it("refuse un nom se terminant par _test mais différent de xrent_test (pas de correspondance approximative)", () => {
      expect(() => assertTestDatabaseUrl("postgresql://sh@localhost:5432/other_test")).toThrow(/xrent_test/);
    });

    it("refuse un hôte distant même si le nom de base est xrent_test", () => {
      expect(() => assertTestDatabaseUrl(`postgresql://user:pass@prod.example.com:5432/${ALLOWED_DB_NAME}`)).toThrow();
    });

    it("refuse une DATABASE_URL vide/absente", () => {
      expect(() => assertTestDatabaseUrl("")).toThrow();
      expect(() => assertTestDatabaseUrl(undefined as unknown as string)).toThrow();
    });

    it("refuse une DATABASE_URL malformée", () => {
      expect(() => assertTestDatabaseUrl("pas-une-url")).toThrow();
    });
  });

  describe("parseArgs — cible explicite obligatoire, jamais de joker", () => {
    it("refuse --tenant et --slug fournis ensemble", () => {
      expect(() => parseArgs(["--tenant=abc", "--slug=abc"])).toThrow(/OU/);
    });

    it("refuse l'absence des deux", () => {
      expect(() => parseArgs(["--yes"])).toThrow(/Usage/);
    });

    it.each(["", "*", "%", "all", "ALL", "tous", "Toutes"])("refuse la valeur joker/vide %j pour --tenant", (value) => {
      expect(() => parseArgs([`--tenant=${value}`])).toThrow(/refusée/);
    });

    it.each(["", "*", "all"])("refuse la valeur joker/vide %j pour --slug", (value) => {
      expect(() => parseArgs([`--slug=${value}`])).toThrow(/refusée/);
    });

    it("accepte --tenant=<id> seul, confirmed=false sans --yes", () => {
      expect(parseArgs(["--tenant=abc123"])).toEqual({ tenantId: "abc123", slug: null, confirmed: false });
    });

    it("accepte --slug=<slug> avec --yes, confirmed=true", () => {
      expect(parseArgs(["--slug=mon-tenant", "--yes"])).toEqual({ tenantId: null, slug: "mon-tenant", confirmed: true });
    });
  });

  describe("checkProtectedTenant — tenants système, refus inconditionnel", () => {
    it.each([...PROTECTED_TENANT_SLUGS])("refuse un tenant dont le slug est %j", (slug) => {
      const result = checkProtectedTenant({ slug, name: "Autre nom" }, []);
      expect(result.protected).toBe(true);
      expect(result.reasons.join(" ")).toContain(slug);
    });

    it.each([...PROTECTED_TENANT_NAMES])("refuse un tenant dont le nom est %j", (name) => {
      const result = checkProtectedTenant({ slug: "autre-slug", name }, []);
      expect(result.protected).toBe(true);
    });

    it("refuse tout tenant contenant le compte réel interdit, indépendamment du slug/nom", () => {
      const result = checkProtectedTenant(
        { slug: "tenant-quelconque", name: "Tenant quelconque" },
        [{ email: "membre@test.local" }, { email: FORBIDDEN_USER_EMAIL.toUpperCase() }]
      );
      expect(result.protected).toBe(true);
      expect(result.reasons.join(" ")).toContain(FORBIDDEN_USER_EMAIL);
    });

    it("n'affecte pas un tenant de test ordinaire", () => {
      const result = checkProtectedTenant(
        { slug: "cleanup-demo-123", name: "Cleanup Demo" },
        [{ email: "admin-demo@test.local" }]
      );
      expect(result.protected).toBe(false);
      expect(result.reasons).toEqual([]);
    });
  });

  describe("mécanisme complet contre une vraie base xrent_test (tenants jetables créés par ce test)", () => {
    it("resolveTenant retrouve par id et par slug, refuse une cible inexistante", async () => {
      const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
      const admin = await createTenantAdmin({
        tenantName: `DeleteTool Demo ${runId}`,
        tenantSlug: `delete-tool-demo-${runId}`,
        name: "Admin",
        email: `admin-deletetool-${runId}@test.local`,
        password: "Correct-Horse-Battery-Staple9!",
      });

      const byId = await resolveTenant(prisma, { tenantId: admin.tenantId, slug: null });
      expect(byId.id).toBe(admin.tenantId);

      const bySlug = await resolveTenant(prisma, { tenantId: null, slug: `delete-tool-demo-${runId}` });
      expect(bySlug.id).toBe(admin.tenantId);

      await expect(resolveTenant(prisma, { tenantId: "not-a-real-id", slug: null })).rejects.toThrow(/Aucun tenant/);
      await expect(resolveTenant(prisma, { tenantId: null, slug: "not-a-real-slug" })).rejects.toThrow(/Aucun tenant/);

      await deleteTestTenants([admin.tenantId]);
    });

    it("dry-run (plan sans deleteTenantGraph) ne supprime jamais rien — cible de démonstration conservée intacte", async () => {
      const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
      const admin = await createTenantAdmin({
        tenantName: `DeleteTool DryRun ${runId}`,
        tenantSlug: `delete-tool-dryrun-${runId}`,
        name: "Admin",
        email: `admin-dryrun-${runId}@test.local`,
        password: "Correct-Horse-Battery-Staple9!",
      });
      const agency = await prisma.agency.create({
        data: { tenantId: admin.tenantId, name: "Agence Démo", slug: `demo-agence-${runId}` },
      });

      // Même séquence que le CLI en dry-run : résolution + garde tenant protégé + comptage —
      // deleteTenantGraph n'est jamais appelée.
      const tenant = await resolveTenant(prisma, { tenantId: admin.tenantId, slug: null });
      const users = await prisma.user.findMany({ where: { tenantId: tenant.id }, select: { email: true } });
      const { protected: isProtected } = checkProtectedTenant(tenant, users);
      expect(isProtected).toBe(false);

      const planned = await countTenantGraph(prisma, [tenant.id]);
      expect(planned.agency).toBe(1);

      const stillThere = await prisma.tenant.findUnique({ where: { id: admin.tenantId } });
      expect(stillThere).not.toBeNull();
      const agencyStillThere = await prisma.agency.findUnique({ where: { id: agency.id } });
      expect(agencyStillThere).not.toBeNull();

      await deleteTestTenants([admin.tenantId]);
    });

    it("deleteTenantGraph supprime intégralement la cible et n'affecte jamais un autre tenant (isolation)", async () => {
      const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
      const password = "Correct-Horse-Battery-Staple9!";

      const target = await createTenantAdmin({
        tenantName: `DeleteTool Target ${runId}`,
        tenantSlug: `delete-tool-target-${runId}`,
        name: "Admin",
        email: `admin-target-${runId}@test.local`,
        password,
      });
      const sibling = await createTenantAdmin({
        tenantName: `DeleteTool Sibling ${runId}`,
        tenantSlug: `delete-tool-sibling-${runId}`,
        name: "Admin",
        email: `admin-sibling-${runId}@test.local`,
        password,
      });

      const targetAgency = await prisma.agency.create({
        data: { tenantId: target.tenantId, name: "Agence Cible", slug: `target-agence-${runId}` },
      });
      const targetClient = await prisma.client.create({ data: { tenantId: target.tenantId, name: "Client Cible" } });
      const targetVehicle = await prisma.vehicle.create({
        data: {
          tenantId: target.tenantId,
          agencyId: targetAgency.id,
          name: "Véhicule Cible",
          licensePlate: `TARGET-${runId}`,
          make: "Marque",
          model: "Modèle",
          year: 2020,
          category: "Eco",
        },
      });
      const targetLocation = await prisma.location.create({
        data: {
          tenantId: target.tenantId,
          agencyId: targetAgency.id,
          vehicleId: targetVehicle.id,
          clientId: targetClient.id,
          startDate: new Date(),
          endDate: new Date(Date.now() + 86_400_000),
          pricePerDay: 10_000,
          totalPrice: 10_000,
        },
      });
      const targetInvoice = await prisma.invoice.create({
        data: {
          tenantId: target.tenantId,
          agencyId: targetAgency.id,
          locationId: targetLocation.id,
          clientId: targetClient.id,
          number: `INV-TARGET-${runId}`,
          subtotal: 10_000,
          totalAmount: 10_000,
        },
      });
      await prisma.payment.create({
        data: { tenantId: target.tenantId, invoiceId: targetInvoice.id, amount: 10_000, method: "CASH" },
      });

      const siblingAgency = await prisma.agency.create({
        data: { tenantId: sibling.tenantId, name: "Agence Voisine", slug: `sibling-agence-${runId}` },
      });

      const resolvedTarget = await resolveTenant(prisma, { tenantId: target.tenantId, slug: null });
      const { protected: isProtected } = checkProtectedTenant(resolvedTarget, []);
      expect(isProtected).toBe(false);

      await deleteTenantGraph(prisma, [target.tenantId]);

      const afterCounts = await countTenantGraph(prisma, [target.tenantId]);
      expect(Object.values(afterCounts).every((count) => count === 0)).toBe(true);

      const [deletedTenant, keptTenant, keptAgency] = await Promise.all([
        prisma.tenant.findUnique({ where: { id: target.tenantId } }),
        prisma.tenant.findUnique({ where: { id: sibling.tenantId } }),
        prisma.agency.findUnique({ where: { id: siblingAgency.id } }),
      ]);
      expect(deletedTenant).toBeNull();
      expect(keptTenant).not.toBeNull();
      expect(keptAgency).not.toBeNull();

      await deleteTestTenants([sibling.tenantId]);
    });

    it("confirme, en lecture seule, qu'un tenant système réel (si présent dans cette base) serait refusé par checkProtectedTenant", async () => {
      const realCuratedTenant = await prisma.tenant.findUnique({ where: { slug: "test-xrent" } });
      if (!realCuratedTenant) {
        // Absent de cette base à cet instant (ex. jamais recréé après un nettoyage complet) —
        // la protection par slug est déjà prouvée de façon déterministe ci-dessus
        // (describe "checkProtectedTenant"), donc rien à re-vérifier ici. On ne crée jamais de
        // tenant réel supplémentaire avec ce slug protégé pour ce test.
        return;
      }
      const users = await prisma.user.findMany({ where: { tenantId: realCuratedTenant.id }, select: { email: true } });
      const { protected: isProtected, reasons } = checkProtectedTenant(realCuratedTenant, users);
      expect(isProtected).toBe(true);
      expect(reasons.join(" ")).toContain("test-xrent");
      // Aucune suppression : lecture seule stricte, ce tenant n'est jamais touché par ce test.
    });
  });
});
