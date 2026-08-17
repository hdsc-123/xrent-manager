import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAgencyById, getTenantById, getUserById } from "@/lib/db";

const runId = Date.now();

describe("couche d'accès aux données — isolation multi-tenant", () => {
  let tenantA: { id: string };
  let tenantB: { id: string };
  let agencyA: { id: string };
  let agencyB: { id: string };
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    tenantA = await prisma.tenant.create({
      data: { name: "Test Tenant A", slug: `test-tenant-a-${runId}` },
    });
    tenantB = await prisma.tenant.create({
      data: { name: "Test Tenant B", slug: `test-tenant-b-${runId}` },
    });

    agencyA = await prisma.agency.create({
      data: { tenantId: tenantA.id, name: "Agency A", slug: "agency-a" },
    });
    agencyB = await prisma.agency.create({
      data: { tenantId: tenantB.id, name: "Agency B", slug: "agency-b" },
    });

    userA = await prisma.user.create({
      data: { tenantId: tenantA.id, email: `user-a-${runId}@test.local`, name: "User A" },
    });
    userB = await prisma.user.create({
      data: { tenantId: tenantB.id, email: `user-b-${runId}@test.local`, name: "User B" },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } });
    await prisma.agency.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } });
    await prisma.alert.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } });
    await prisma.$disconnect();
  });

  it("getTenantById retourne le tenant demandé", async () => {
    const result = await getTenantById(tenantA.id);
    expect(result?.id).toBe(tenantA.id);
  });

  it("getAgencyById retourne l'agence quand elle appartient au tenant demandé", async () => {
    const result = await getAgencyById(tenantA.id, agencyA.id);
    expect(result?.id).toBe(agencyA.id);
  });

  it("getAgencyById ne retourne jamais une agence d'un autre tenant", async () => {
    const result = await getAgencyById(tenantA.id, agencyB.id);
    expect(result).toBeNull();
  });

  it("getUserById retourne l'utilisateur quand il appartient au tenant demandé", async () => {
    const result = await getUserById(tenantA.id, userA.id);
    expect(result?.id).toBe(userA.id);
  });

  it("getUserById ne retourne jamais un utilisateur d'un autre tenant", async () => {
    const result = await getUserById(tenantA.id, userB.id);
    expect(result).toBeNull();
  });
});
