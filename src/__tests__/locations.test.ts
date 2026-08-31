import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { apiFetch } from "./helpers/http";
import { registerTenantAdmin, createAndLoginMember, type AuthenticatedTestUser, deleteTestTenants } from "./helpers/fixtures";
import {
  getContractsOverview,
  updateLocation,
  LocationStatusConflictError,
  LocationCancellationRequiresAdminError,
  InvalidStatusTransitionError,
} from "@/lib/locations";

const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const createdTenantIds: string[] = [];

let adminA: AuthenticatedTestUser;
let adminB: AuthenticatedTestUser;
let memberA: AuthenticatedTestUser;
/** Sprint 19 — MEMBER rattaché à agencyA1Id (contrairement à memberA), pour tester que la
 * machine à états/le verrou de dates s'applique toujours à un MEMBER (contrairement à
 * l'override ADMIN, voir DOMAINRULES.md section 37). */
let linkedMemberA: AuthenticatedTestUser;
let agencyA1Id: string;
let agencyB1Id: string;
let vehicleAId: string; // pricePerDay = 5000 (50,00 MAD)
let vehicleBId: string;
let clientAId: string;
let clientBId: string;

async function createLocation(
  admin: AuthenticatedTestUser,
  overrides: Record<string, unknown> = {}
) {
  return apiFetch("/api/locations", {
    method: "POST",
    headers: { Cookie: admin.sessionCookie },
    body: JSON.stringify({
      vehicleId: vehicleAId,
      clientId: clientAId,
      startDate: "2028-01-10",
      endDate: "2028-01-13",
      ...overrides,
    }),
  });
}

beforeAll(async () => {
  adminA = await registerTenantAdmin({
    tenantName: "Locations Test A",
    tenantSlug: `locations-test-a-${runId}`,
    name: "Admin A",
    email: `admin-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminA.tenantId);

  adminB = await registerTenantAdmin({
    tenantName: "Locations Test B",
    tenantSlug: `locations-test-b-${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  createdTenantIds.push(adminB.tenantId);

  memberA = await createAndLoginMember({
    tenantId: adminA.tenantId,
    name: "Member A",
    email: `member-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });

  const agencyAResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Agence A1", slug: `agence-a1-${runId}` }),
  });
  agencyA1Id = (await agencyAResponse.json()).agency.id;

  const agencyBResponse = await apiFetch("/api/agencies", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Agence B1", slug: `agence-b1-${runId}` }),
  });
  agencyB1Id = (await agencyBResponse.json()).agency.id;

  const vehicleAResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({
      agencyId: agencyA1Id,
      name: "Clio",
      licensePlate: `LOC-A-${runId}`,
      make: "Renault",
      model: "Clio",
      year: 2022,
      category: "Citadine",
      pricePerDay: 5000,
      chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
    }),
  });
  vehicleAId = (await vehicleAResponse.json()).vehicle.id;

  const vehicleBResponse = await apiFetch("/api/vehicles", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({
      agencyId: agencyB1Id,
      name: "208",
      licensePlate: `LOC-B-${runId}`,
      make: "Peugeot",
      model: "208",
      year: 2022,
      category: "Citadine",
      pricePerDay: 4000,
      chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
      color: "Blanc",
      doors: 5,
      seats: 5,
      horsepower: 6,
      powerKW: 75,
      engineSize: 1.5,
    }),
  });
  vehicleBId = (await vehicleBResponse.json()).vehicle.id;

  const clientAResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminA.sessionCookie },
    body: JSON.stringify({ name: "Client A", email: `client-a-${runId}@test.local`, licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
  });
  clientAId = (await clientAResponse.json()).client.id;

  const clientBResponse = await apiFetch("/api/clients", {
    method: "POST",
    headers: { Cookie: adminB.sessionCookie },
    body: JSON.stringify({ name: "Client B", email: `client-b-${runId}@test.local`, licenseExpiryDate: "2099-12-31", birthDate: "1990-01-01" }),
  });
  clientBId = (await clientBResponse.json()).client.id;

  linkedMemberA = await createAndLoginMember({
    tenantId: adminA.tenantId,
    name: "Linked Member A",
    email: `linked-member-a-${runId}@test.local`,
    password: "Correct-Horse-Battery-Staple9!",
  });
  await prisma.userAgency.create({ data: { userId: linkedMemberA.userId, agencyId: agencyA1Id } });
});

/** Sprint 23 — plage de dates unique par appel (base 2028-02-01, +5 jours à chaque fois) : les
 * tests ci-dessous créent plusieurs contrats sur le même vehicleAId dans le même describe block
 * (contrairement aux tests existants du fichier, chacun avec ses propres dates explicites) —
 * sans cela, tous retomberaient sur les dates par défaut de createLocation et se
 * chevaucheraient (VehicleNotAvailableError, 409). */
let sprint23DateCounter = 0;
function nextTestDateRange(): { startDate: string; endDate: string } {
  const startDay = 1 + sprint23DateCounter * 5;
  sprint23DateCounter += 1;
  const start = new Date(Date.UTC(2028, 1, startDay));
  const end = new Date(Date.UTC(2028, 1, startDay + 3));
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

/** Sprint 23 — même motif que createLocationWithPayment (location-payment.test.ts) : crée un
 * contrat CONFIRMED avec un paiement intégré (donc une facture PAID et une CashEntry réelle),
 * pour tester l'annulation admin avec réversibilité financière. */
async function createConfirmedLocationWithPayment(admin: AuthenticatedTestUser) {
  const response = await createLocation(admin, {
    ...nextTestDateRange(),
    status: "CONFIRMED",
    payment: { method: "CASH", partial: false },
  });
  const body = await response.json();
  return {
    location: body.location as { id: string; agencyId: string; totalPrice: number },
    invoice: body.invoice as { id: string; status: string },
  };
}

describe("Sprint 23 — annulation d'un contrat validé, réservée ADMIN, avec réversibilité (DOMAINRULES.md section 39)", () => {
  it("PATCH status=CANCELLED sur un contrat CONFIRMED est refusé (403) même pour un ADMIN — seule POST .../admin-cancel le permet", async () => {
    const { location } = await createConfirmedLocationWithPayment(adminA);

    const patchResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(patchResponse.status).toBe(403);

    // Sprint 31A (DOMAINRULES.md section 43) : refus métier réel, aucune concurrence impliquée —
    // le message doit rester clairement distinct du message de conflit (409) harmonisé ce sprint.
    const body = await patchResponse.json();
    expect(body.error).toBe(
      "Seul un administrateur peut annuler un contrat déjà validé (voir POST /api/locations/[id]/admin-cancel)."
    );
    expect(body.error).not.toContain("modifié entre-temps");
    expect(body.error).not.toContain("un autre utilisateur");
  });

  it("PATCH status=CANCELLED sur un contrat encore PENDING reste autorisé pour un MEMBER (brouillon jamais validé)", async () => {
    const createResponse = await createLocation(linkedMemberA, nextTestDateRange());
    const { location: pendingLocation } = await createResponse.json();

    const patchResponse = await apiFetch(`/api/locations/${pendingLocation.id}`, {
      method: "PATCH",
      headers: { Cookie: linkedMemberA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(patchResponse.status).toBe(200);
  });

  it("POST .../admin-cancel refusé (403) pour un MEMBER, même rattaché à l'agence", async () => {
    const { location } = await createConfirmedLocationWithPayment(adminA);

    const response = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: linkedMemberA.sessionCookie },
    });
    expect(response.status).toBe(403);
  });

  it("POST .../admin-cancel refusé (409) sur un contrat encore PENDING", async () => {
    const createResponse = await createLocation(adminA, nextTestDateRange());
    const { location: pendingLocation } = await createResponse.json();

    const response = await apiFetch(`/api/locations/${pendingLocation.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Test — contrat encore PENDING" }),
    });
    expect(response.status).toBe(409);
  });

  it("annule un contrat CONFIRMED avec facture PAID : facture annulée, écriture de compensation créée, solde de caisse revenu à sa valeur d'origine, Payment conservé et marqué REFUNDED", async () => {
    const balanceBefore = await apiFetch("/api/cash-register", { headers: { Cookie: adminA.sessionCookie } });
    const currentBalanceBefore = (await balanceBefore.json()).currentBalance as number;

    const { location, invoice } = await createConfirmedLocationWithPayment(adminA);
    expect(invoice.status).toBe("PAID");

    const paymentsBefore = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(paymentsBefore.length).toBe(1);
    const paymentAmount = paymentsBefore[0].amount;

    const response = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Client — annulation de contrat" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.status).toBe("CANCELLED");
    expect(body.cancelledInvoiceCount).toBe(1);
    expect(body.reversedPaymentCount).toBe(1);
    expect(body.reversedAmountTotal).toBe(paymentAmount);

    const invoiceAfter = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    expect(invoiceAfter?.status).toBe("VOID");

    // Le Payment d'origine n'est jamais supprimé, ni réécrit dans son amount/method/paidAt
    // (append-only, DOMAINRULES.md section 10/23) — seul son statut passe à REFUNDED (Sprint
    // 26D, Finding D1) ; une écriture de compensation est ajoutée en caisse, liée à l'écriture
    // et au Payment d'origine.
    const paymentsAfter = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(paymentsAfter).toHaveLength(1);
    expect(paymentsAfter[0].amount).toBe(paymentsBefore[0].amount);
    expect(paymentsAfter[0].method).toBe(paymentsBefore[0].method);
    expect(paymentsAfter[0].paidAt).toEqual(paymentsBefore[0].paidAt);
    expect(paymentsBefore[0].status).toBe("ACTIVE");
    expect(paymentsAfter[0].status).toBe("REFUNDED");

    const originalEntry = await prisma.cashEntry.findFirst({
      where: { paymentId: paymentsAfter[0].id, parentEntryId: null },
    });
    expect(originalEntry).not.toBeNull();
    expect(originalEntry?.amount).toBe(paymentAmount);

    const compensationEntry = await prisma.cashEntry.findFirst({
      where: { contractId: location.id, category: "ANNULATION_CONTRAT" },
    });
    expect(compensationEntry).not.toBeNull();
    expect(compensationEntry?.type).toBe("EXPENSE");
    expect(compensationEntry?.amount).toBe(paymentAmount);
    expect(compensationEntry?.paymentId).toBe(paymentsAfter[0].id);
    expect(compensationEntry?.parentEntryId).toBe(originalEntry?.id);
    expect(compensationEntry?.reason).toBe("Client — annulation de contrat");
    expect(compensationEntry?.performedByUserId).toBe(adminA.userId);

    const balanceAfter = await apiFetch("/api/cash-register", { headers: { Cookie: adminA.sessionCookie } });
    const currentBalanceAfter = (await balanceAfter.json()).currentBalance as number;
    expect(currentBalanceAfter).toBe(currentBalanceBefore);
  });

  it("un second appel admin-cancel sur le même contrat déjà annulé échoue proprement (409, jamais un double reversal)", async () => {
    const { location } = await createConfirmedLocationWithPayment(adminA);

    const first = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Premier appel" }),
    });
    expect(first.status).toBe(200);

    const second = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Second appel — doit échouer" }),
    });
    expect(second.status).toBe(409);
  });

  it("Sprint 26D (Finding D1) — idempotence : un second appel (retry) ne rembourse jamais deux fois le même Payment", async () => {
    const { location, invoice } = await createConfirmedLocationWithPayment(adminA);
    const paymentsBefore = await prisma.payment.findMany({ where: { invoiceId: invoice.id } });
    expect(paymentsBefore).toHaveLength(1);
    const paymentId = paymentsBefore[0].id;

    const first = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Premier remboursement" }),
    });
    expect(first.status).toBe(200);

    const paymentAfterFirst = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(paymentAfterFirst.status).toBe("REFUNDED");
    const compensationsAfterFirst = await prisma.cashEntry.findMany({ where: { paymentId, parentEntryId: { not: null } } });
    expect(compensationsAfterFirst).toHaveLength(1);

    const second = await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Retry — ne doit rien changer" }),
    });
    expect(second.status).toBe(409);

    // Conservé tel quel — jamais un second remboursement, jamais une seconde compensation.
    const paymentAfterSecond = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(paymentAfterSecond).toEqual(paymentAfterFirst);
    const compensationsAfterSecond = await prisma.cashEntry.findMany({ where: { paymentId, parentEntryId: { not: null } } });
    expect(compensationsAfterSecond).toHaveLength(1);
    expect(compensationsAfterSecond[0].id).toBe(compensationsAfterFirst[0].id);
  });

  it("un contrat annulé avec historique financier reste bloqué à la suppression (LocationHasInvoiceError, décision documentée section 3.3 du plan Sprint 23)", async () => {
    const { location } = await createConfirmedLocationWithPayment(adminA);
    await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Annulation avant suppression" }),
    });

    const deleteResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(409);
  });

  it("le contrat annulé n'est plus compté dans le CA réalisé du véhicule (getTopVehicles)", async () => {
    const { location } = await createConfirmedLocationWithPayment(adminA);
    // Contrat validé (CONFIRMED) : passe ACTIVE pour compter dans REALIZED_LOCATION_STATUSES
    // (src/lib/reports.ts) avant annulation, pour vérifier qu'il en sort bien après.
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    const { getTopVehicles } = await import("@/lib/reports");
    const before = await getTopVehicles(adminA.tenantId, 50);
    const vehicleBefore = before.find((entry) => entry.vehicleId === vehicleAId);
    expect(vehicleBefore).toBeDefined();

    await apiFetch(`/api/locations/${location.id}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Annulation — CA réalisé" }),
    });

    const after = await getTopVehicles(adminA.tenantId, 50);
    const vehicleAfter = after.find((entry) => entry.vehicleId === vehicleAId);
    expect(vehicleAfter?.revenue ?? 0).toBe((vehicleBefore?.revenue ?? 0) - location.totalPrice);
  });
});

describe("Sprint 23 — correctif de concurrence sur updateLocation (DOMAINRULES.md section 39, étend le correctif Sprint 22)", () => {
  // INC-4 (Sprint 34, tâche 1 — voir INCIDENTS.md et DOMAINRULES.md section 51) : ces deux tests
  // exerçaient jusqu'ici la course via deux `fetch` PATCH concurrents (Promise.all) sur
  // `/api/locations/[id]`. Cause exacte, confirmée par instrumentation directe (timestamps
  // `process.hrtime.bigint()` de part et d'autre de chaque étape) : le serveur `next dev`
  // (Turbopack, Next 16.3.0) sérialise en pratique les requêtes concurrentes adressées à une même
  // route dynamique de l'App Router (`[id]/route.ts`) — y compris pour deux ressources
  // différentes, y compris après une requête de préchauffage préalable sur la même route. Aucun
  // chevauchement réel n'a jamais été observé côté application dans ce scénario HTTP : la
  // deuxième requête ne commence son exécution qu'une fois la réponse de la première entièrement
  // envoyée. Ce n'est donc ni un bug de verrou PostgreSQL, ni de nettoyage de données, ni de
  // données partagées entre tests.
  //
  // Un deuxième constat, plus fin, a été fait en creusant la cause avec des appels directs et
  // réellement concurrents à `updateLocation()` (même process Node, chevauchement réel garanti,
  // vérifié par instrumentation) : lorsque les deux appels portent `adminOverride: true` (ce que
  // fait la route pour un utilisateur ADMIN — c'était le cas du test d'origine avec `adminA`) ET
  // que l'exécution se retrouve malgré tout totalement séquentielle (par accident de
  // planification, même sans passer par next dev), les DEUX opérations peuvent réussir : la
  // deuxième lit un `existing.status` exact (non périmé, l'autre a déjà committé), donc le verrou
  // de ligne ne détecte aucune course — et `adminOverride` contourne alors légitimement
  // `canTransition` (comportement voulu du Sprint 19 : un ADMIN peut forcer n'importe quelle
  // transition). Un ADMIN qui exécute deux actions contradictoires l'une après l'autre (pas une
  // vraie course) obtient donc deux succès, par conception. Ce n'est pas la garantie que ce test
  // doit vérifier — cette garantie (deux opérations *concurrentes* et *non privilégiées* sur la
  // même ligne → une seule réussit toujours) est celle que Sprint 22/23/31A ont réellement
  // construite, et elle ne dépend jamais d'`adminOverride`.
  //
  // Correction à la source, sur les deux points : (1) exercer la garantie de concurrence via deux
  // appels directs et réellement concurrents à `updateLocation()` (le service exporté par la
  // route), dans le même process Node — un chevauchement réel est ainsi garanti, sans dépendre du
  // dispatch des routes dynamiques de `next dev` ; (2) ne jamais passer `adminOverride` pour les
  // deux opérations à la fois — PENDING → CONFIRMED et PENDING → CANCELLED sont toutes deux des
  // transitions normalement valides depuis PENDING sans le moindre override, donc la perdante
  // (qui tente une transition depuis un statut déjà changé) est TOUJOURS refusée, que
  // l'exécution ait réellement chevauché (LocationStatusConflictError, Sprint 31A) ou se soit
  // retrouvée séquentielle (LocationCancellationRequiresAdminError si CONFIRMED passe en premier,
  // Sprint 23 ; InvalidStatusTransitionError si CANCELLED passe en premier, canTransition refuse
  // CANCELLED → CONFIRMED sans override) — jamais un double succès. Voir DOMAINRULES.md
  // section 51 pour le détail complet. Aucun test désactivé, aucun retry artificiel : la garantie
  // testée est identique à celle voulue par Sprint 22/23/31A, seul le mécanisme d'invocation
  // change pour la rendre déterministe et pour ne plus mélanger la question de la concurrence
  // avec celle, distincte, du contournement ADMIN.
  it("deux transitions de statut concurrentes sur la même location PENDING — une seule réussit (conflit explicite pour l'autre)", async () => {
    const createResponse = await createLocation(adminA, nextTestDateRange());
    const { location } = await createResponse.json();

    const results = await Promise.allSettled([
      updateLocation(adminA.tenantId, location.id, { status: "CONFIRMED" }),
      updateLocation(adminA.tenantId, location.id, { status: "CANCELLED" }),
    ]);

    // Garantie non négociable (règle 7 du brief Sprint 34 tâche 1) : deux opérations
    // incompatibles concurrentes ne doivent jamais produire deux succès (double écriture) — une
    // seule doit réussir, quel que soit l'entrelacement réel des deux transactions.
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Sans adminOverride, la perdante est toujours refusée par l'une de ces trois gardes
    // métier — jamais un succès en double. Voir le commentaire de describe ci-dessus.
    const [loser] = rejected as PromiseRejectedResult[];
    const legitimateLoserErrors = [
      LocationStatusConflictError,
      LocationCancellationRequiresAdminError,
      InvalidStatusTransitionError,
    ];
    expect(legitimateLoserErrors.some((errorClass) => loser.reason instanceof errorClass)).toBe(true);
    if (loser.reason instanceof LocationStatusConflictError) {
      // Sprint 31A (DOMAINRULES.md section 43) : quand un chevauchement réel se produit, le
      // message est toujours le message de conflit harmonisé.
      expect(loser.reason.message).toBe(
        "Cette opération n'a pas été appliquée. La location a déjà été modifiée par un autre utilisateur. Actualisez la page puis réessayez."
      );
    }

    const finalLocation = await prisma.location.findUnique({ where: { id: location.id } });
    expect(["CONFIRMED", "CANCELLED"]).toContain(finalLocation?.status);
  });

  it("scénario reproductible : 5 itérations indépendantes de la même course, un succès et un seul à chaque fois, jamais deux succès (preuve du caractère déterministe du verrou, indépendant du dispatch HTTP de next dev)", async () => {
    // Sprint 34 tâche 1 (INC-4) : le nombre d'itérations reste volontairement celui d'origine
    // (Sprint 31A) — `sprint23DateCounter` est un compteur global partagé par tout le fichier de
    // test (voir sa définition plus haut) ; l'augmenter changerait les dates consommées par ce
    // test et décalerait d'autant celles des tests suivants dans le fichier qui, eux, utilisent
    // des dates codées en dur (ex. « refuse une location en conflit... », 2028-05-01). La
    // vérification « au moins 10 exécutions » du brief porte sur le nombre de lancements de ce
    // test (voir le rapport), pas sur son nombre d'itérations internes.
    for (let i = 0; i < 5; i += 1) {
      const createResponse = await createLocation(adminA, nextTestDateRange());
      const { location } = await createResponse.json();

      const results = await Promise.allSettled([
        updateLocation(adminA.tenantId, location.id, { status: "CONFIRMED" }),
        updateLocation(adminA.tenantId, location.id, { status: "CANCELLED" }),
      ]);

      // Le verrou de ligne (lockLocationForUpdate) garantit qu'un chevauchement réel des deux
      // transactions produit toujours un succès et un conflit explicite ; sans adminOverride,
      // une exécution séquentielle reste elle aussi toujours refusée pour la perdante (voir le
      // test précédent pour le détail des trois refus légitimes possibles) — jamais deux succès.
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const [loser] = rejected as PromiseRejectedResult[];
      const legitimateLoserErrors = [
        LocationStatusConflictError,
        LocationCancellationRequiresAdminError,
        InvalidStatusTransitionError,
      ];
      expect(legitimateLoserErrors.some((errorClass) => loser.reason instanceof errorClass)).toBe(true);

      const finalLocation = await prisma.location.findUnique({ where: { id: location.id } });
      expect(["CONFIRMED", "CANCELLED"]).toContain(finalLocation?.status);
    }
  });

  // Sprint 34 tâche 1 (INC-4, revue) : les deux tests ci-dessus vérifient la garantie de
  // concurrence au niveau du service (`updateLocation`), seul endroit où elle est réellement
  // implémentée (verrou de ligne + `updateMany` conditionné) — la route HTTP ne fait
  // qu'authentifier, vérifier les permissions et calculer `adminOverride`/`confirmMaintenanceConflict`
  // avant de l'appeler, sans ajouter la moindre logique de concurrence propre. Ce test complète
  // néanmoins la couverture en exerçant la chaîne complète (authentification, permissions
  // granulaires, désérialisation JSON, mapping erreur → code HTTP) via deux vraies requêtes PATCH
  // concurrentes, pour vérifier qu'aucun problème propre à la route ne se cache derrière l'appel
  // direct au service. Comme pour les deux tests directs ci-dessus, l'acteur n'a délibérément pas
  // `adminOverride` (MEMBER titulaire uniquement de `locations.confirm`/`locations.cancel`, pas
  // ADMIN) — la garantie « une seule réussite » est ainsi assurée par construction (voir le
  // commentaire de describe plus haut), qu'un chevauchement réel se produise ou que next dev
  // sérialise les deux requêtes (comportement documenté, INCIDENTS.md INC-4) : ce test est donc
  // stable et déterministe dans les deux cas, contrairement à l'ancienne version qui exigeait un
  // chevauchement réel pour passer.
  it("HTTP — deux PATCH concurrents (MEMBER, sans adminOverride) sur la même location PENDING : une seule réussit, jamais deux 200", async () => {
    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        name: `ConfirmCancel-${runId}`,
        permissions: ["locations.view", "locations.confirm", "locations.cancel"],
      }),
    });
    const groupId = (await groupResponse.json()).group.id;

    const raceMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Race Member",
      email: `race-member-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: raceMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${raceMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: groupId }),
    });

    const createResponse = await createLocation(adminA, nextTestDateRange());
    const { location } = await createResponse.json();

    const [toConfirmed, toCancelled] = await Promise.all([
      apiFetch(`/api/locations/${location.id}`, {
        method: "PATCH",
        headers: { Cookie: raceMember.sessionCookie },
        body: JSON.stringify({ status: "CONFIRMED" }),
      }),
      apiFetch(`/api/locations/${location.id}`, {
        method: "PATCH",
        headers: { Cookie: raceMember.sessionCookie },
        body: JSON.stringify({ status: "CANCELLED" }),
      }),
    ]);

    const statuses = [toConfirmed.status, toCancelled.status];
    // Garantie non négociable, identique aux tests directs ci-dessus : exactement une réussite.
    // Le perdant reçoit 403 (LocationCancellationRequiresAdminError) ou 409
    // (LocationStatusConflictError / InvalidStatusTransitionError) selon l'entrelacement réel —
    // jamais [200, 200].
    const successCount = statuses.filter((status) => status === 200).length;
    expect(successCount).toBe(1);
    const loserStatus = statuses.find((status) => status !== 200);
    expect([403, 409]).toContain(loserStatus);

    const finalLocation = await prisma.location.findUnique({ where: { id: location.id } });
    expect(["CONFIRMED", "CANCELLED"]).toContain(finalLocation?.status);
  });
});

describe("Sprint 26C, Finding C — verrou Vehicle contre le double booking concurrent", () => {
  it("Test 1 — deux POST /api/locations concurrents, même véhicule, dates chevauchantes : une seule réussite, une seule Location bloquante persistée", async () => {
    const [responseA, responseB] = await Promise.all([
      createLocation(adminA, { startDate: "2033-01-10", endDate: "2033-01-15" }),
      createLocation(adminA, { startDate: "2033-01-12", endDate: "2033-01-18" }),
    ]);

    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winnerResponse = responseA.status === 201 ? responseA : responseB;
    const loserResponse = responseA.status === 201 ? responseB : responseA;
    const winnerBody = await winnerResponse.json();
    const loserBody = await loserResponse.json();
    expect(Array.isArray(loserBody.conflictingLocations)).toBe(true);

    const persisted = await prisma.location.findMany({
      where: {
        vehicleId: vehicleAId,
        status: { in: ["PENDING", "CONFIRMED", "ACTIVE"] },
        startDate: { lt: new Date("2033-01-18") },
        endDate: { gt: new Date("2033-01-10") },
      },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(winnerBody.location.id);
  });

  it("Test 4 — PATCH concurrent vers une période conflictuelle et création directe sur le même véhicule : aucun chevauchement final persisté", async () => {
    // `otherLocation` démarre sur une période totalement indépendante de la cible visée par les
    // deux tentatives concurrentes ci-dessous, pour n'entrer en conflit qu'avec elles (et pas
    // avec elle-même avant sa propre modification).
    const otherResponse = await createLocation(adminA, { startDate: "2033-03-20", endDate: "2033-03-25" });
    const otherLocation = (await otherResponse.json()).location;

    const [patchResponse, createResponse] = await Promise.all([
      apiFetch(`/api/locations/${otherLocation.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ startDate: "2033-03-02", endDate: "2033-03-06" }),
      }),
      createLocation(adminA, { startDate: "2033-03-02", endDate: "2033-03-06" }),
    ]);

    const statuses = [patchResponse.status, createResponse.status].sort();
    expect(statuses).toEqual([201, 409]);

    const blocking = await prisma.location.findMany({
      where: {
        vehicleId: vehicleAId,
        status: { in: ["PENDING", "CONFIRMED", "ACTIVE"] },
        startDate: { lt: new Date("2033-03-06") },
        endDate: { gt: new Date("2033-03-02") },
      },
    });
    expect(blocking).toHaveLength(1);
  });

  it("Test 5 — non-régression séquentielle : disponibilité sans conflit, conflit existant, bornes de dates, statuts bloquants, exclusion de la Location courante en modification", async () => {
    const free = await createLocation(adminA, { startDate: "2033-02-01", endDate: "2033-02-05" });
    expect(free.status).toBe(201);

    // Conflit existant (chevauchement strict).
    const conflict = await createLocation(adminA, { startDate: "2033-02-03", endDate: "2033-02-08" });
    expect(conflict.status).toBe(409);

    // Borne de date : une reprise le jour même de la restitution n'est pas un conflit.
    const adjacent = await createLocation(adminA, { startDate: "2033-02-05", endDate: "2033-02-08" });
    expect(adjacent.status).toBe(201);
    const adjacentLocation = (await adjacent.json()).location;

    // Statuts bloquants : CANCELLED ne bloque plus la période qu'elle occupait.
    const cancelResponse = await apiFetch(`/api/locations/${adjacentLocation.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(cancelResponse.status).toBe(200);
    const afterCancel = await createLocation(adminA, { startDate: "2033-02-05", endDate: "2033-02-08" });
    expect(afterCancel.status).toBe(201);
    const afterCancelLocation = (await afterCancel.json()).location;

    // Exclusion de la Location courante lors d'une modification de ses propres dates (PATCH sur
    // elle-même) : ne doit jamais se heurter à son propre enregistrement.
    const selfPatch = await apiFetch(`/api/locations/${afterCancelLocation.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ startDate: "2033-02-05", endDate: "2033-02-09" }),
    });
    expect(selfPatch.status).toBe(200);

    // Un vrai conflit (avec `free`, toujours PENDING) reste bien détecté après ce changement.
    const realConflict = await apiFetch(`/api/locations/${afterCancelLocation.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ startDate: "2033-02-01", endDate: "2033-02-03" }),
    });
    expect(realConflict.status).toBe(409);
  });

  it("Isolation tenant — lockVehicleForUpdate ne verrouille jamais un véhicule d'un autre tenant", async () => {
    const { lockVehicleForUpdate } = await import("@/lib/vehicles");
    const result = await prisma.$transaction((tx) => lockVehicleForUpdate(adminB.tenantId, vehicleAId, tx));
    expect(result).toBeNull();
  });

  it("Isolation tenant — POST /api/locations refuse un véhicule d'un autre tenant (404, avant toute tentative de verrou)", async () => {
    const response = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({
        vehicleId: vehicleAId,
        clientId: clientBId,
        startDate: "2033-04-01",
        endDate: "2033-04-03",
      }),
    });
    expect(response.status).toBe(404);
  });

  it("Rollback — un échec après acquisition du verrou (MissingPriceError) ne laisse aucune Location partiellement persistée", async () => {
    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId: agencyA1Id,
        name: "Sans prix Finding C",
        licensePlate: `LOC-S26C-NOPRICE-${runId}`,
        make: "Renault",
        model: "Clio",
        year: 2022,
        category: "Citadine",
        chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
        color: "Blanc",
        doors: 5,
        seats: 5,
        horsepower: 6,
        powerKW: 75,
        engineSize: 1.5,
      }),
    });
    const noPriceVehicleId = (await vehicleResponse.json()).vehicle.id;

    const response = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        vehicleId: noPriceVehicleId,
        clientId: clientAId,
        startDate: "2033-05-01",
        endDate: "2033-05-03",
      }),
    });
    expect(response.status).toBe(400);

    const persisted = await prisma.location.findMany({ where: { vehicleId: noPriceVehicleId } });
    expect(persisted).toHaveLength(0);
  });
});

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
  await prisma.$disconnect();
});

describe("POST /api/locations", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/locations", {
      method: "POST",
      body: JSON.stringify({ vehicleId: vehicleAId, clientId: clientAId }),
    });
    expect(response.status).toBe(401);
  });

  it("refuse une date de fin antérieure ou égale à la date de début", async () => {
    const response = await createLocation(adminA, { startDate: "2028-02-05", endDate: "2028-02-05" });
    expect(response.status).toBe(400);
  });

  it("refuse un véhicule d'un autre tenant (isolation multi-tenant)", async () => {
    const response = await createLocation(adminA, { vehicleId: vehicleBId });
    expect(response.status).toBe(404);
  });

  it("refuse un client d'un autre tenant (isolation multi-tenant)", async () => {
    const response = await createLocation(adminA, { clientId: clientBId });
    expect(response.status).toBe(404);
  });

  it("crée la location, calcule totalPrice = pricePerDay × jours et fixe le statut PENDING par défaut", async () => {
    const response = await createLocation(adminA, {
      startDate: "2028-01-10",
      endDate: "2028-01-13",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.status).toBe("PENDING");
    expect(body.location.pricePerDay).toBe(5000);
    expect(body.location.totalPrice).toBe(15000); // 3 jours × 5000
    expect(body.location.currency).toBe("MAD");
  });

  it("un pricePerDay explicite prime sur le prix informatif du véhicule (Sprint 14A)", async () => {
    const response = await createLocation(adminA, {
      startDate: "2028-01-20",
      endDate: "2028-01-22",
      pricePerDay: 8000,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.pricePerDay).toBe(8000);
    expect(body.location.totalPrice).toBe(16000); // 2 jours × 8000
  });

  // Sprint 24-1 : NewLocationForm.tsx préremplit désormais startOdometer/startFuelLevel depuis
  // GET /api/vehicles/[id]/last-known-state (comportement client, non testable ici) — ce test
  // couvre la seule partie serveur concernée : startFuelLevel accepté et persisté à la création,
  // déjà supporté par l'API depuis le Sprint 23 mais jusqu'ici non couvert par un test dédié.
  it("accepte et persiste startFuelLevel à la création (Sprint 23, non testé jusqu'ici)", async () => {
    const response = await createLocation(adminA, {
      startDate: "2028-01-25",
      endDate: "2028-01-27",
      startOdometer: 15000,
      startFuelLevel: 75,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.startOdometer).toBe(15000);
    expect(body.location.startFuelLevel).toBe(75);
  });

  describe("véhicule sans pricePerDay (Sprint 14A, prix optionnel)", () => {
    let vehicleNoPriceId: string;

    beforeAll(async () => {
      const response = await apiFetch("/api/vehicles", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({
          agencyId: agencyA1Id,
          name: "Sans prix",
          licensePlate: `LOC-NOPRICE-${runId}`,
          make: "Dacia",
          model: "Sandero",
          year: 2023,
          category: "Citadine",
          chassisNumber: `VF1TEST${Math.floor(Math.random() * 1_000_000)}`,
          color: "Blanc",
          doors: 5,
          seats: 5,
          horsepower: 6,
          powerKW: 75,
          engineSize: 1.5,
        }),
      });
      vehicleNoPriceId = (await response.json()).vehicle.id;
    });

    it("crée la location si un pricePerDay explicite est fourni", async () => {
      const response = await createLocation(adminA, {
        vehicleId: vehicleNoPriceId,
        startDate: "2028-01-24",
        endDate: "2028-01-26",
        pricePerDay: 3000,
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.location.pricePerDay).toBe(3000);
      expect(body.location.totalPrice).toBe(6000); // 2 jours × 3000
    });

    it("refuse (400) sans pricePerDay explicite ni prix véhicule", async () => {
      const response = await createLocation(adminA, {
        vehicleId: vehicleNoPriceId,
        startDate: "2028-01-27",
        endDate: "2028-01-29",
      });
      expect(response.status).toBe(400);
    });
  });

  it("refuse une location en conflit avec une location existante sur le même véhicule", async () => {
    const first = await createLocation(adminA, { startDate: "2028-05-01", endDate: "2028-05-05" });
    expect(first.status).toBe(201);

    const conflicting = await createLocation(adminA, {
      startDate: "2028-05-03",
      endDate: "2028-05-08",
    });
    expect(conflicting.status).toBe(409);
    const body = await conflicting.json();
    expect(body.conflictingLocations).toHaveLength(1);
  });

  it("accepte une location adjacente (pas de chevauchement) sur le même véhicule", async () => {
    const response = await createLocation(adminA, { startDate: "2028-05-05", endDate: "2028-05-08" });
    expect(response.status).toBe(201);
  });

  it("refuse un MEMBER non rattaché à l'agence du véhicule", async () => {
    const response = await createLocation(memberA as unknown as AuthenticatedTestUser, {
      startDate: "2028-06-01",
      endDate: "2028-06-03",
    });
    expect(response.status).toBe(403);
  });

  it("persiste startOdometer/endOdometer/deposit (Sprint 12A)", async () => {
    const response = await createLocation(adminA, {
      startDate: "2029-01-15",
      endDate: "2029-01-17",
      startOdometer: 12000,
      endOdometer: 12250,
      deposit: 300000,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.startOdometer).toBe(12000);
    expect(body.location.endOdometer).toBe(12250);
    expect(body.location.deposit).toBe(300000);
  });

  it("refuse un kilométrage négatif", async () => {
    const response = await createLocation(adminA, {
      startDate: "2029-01-20",
      endDate: "2029-01-22",
      startOdometer: -10,
    });
    expect(response.status).toBe(400);
  });

  it("arrondit le nombre de jours au jour supérieur en tenant compte de l'heure (dépassement = jour supplémentaire)", async () => {
    // Départ 10/02 10:00, retour 12/02 11:00 → 2 jours + 1h de dépassement → 3 jours facturés.
    const response = await createLocation(adminA, {
      startDate: "2029-02-10T10:00:00.000Z",
      endDate: "2029-02-12T11:00:00.000Z",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.totalPrice).toBe(15000); // 3 jours × 5000
  });

  it("n'arrondit pas à un jour de plus pour un retour légèrement anticipé", async () => {
    // Départ 10/03 10:00, retour 12/03 09:59 → toujours 2 jours (pas de dépassement).
    const response = await createLocation(adminA, {
      startDate: "2029-03-10T10:00:00.000Z",
      endDate: "2029-03-12T09:59:00.000Z",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.location.totalPrice).toBe(10000); // 2 jours × 5000
  });

  describe("Sprint 29 — permis du client principal doit couvrir la date de retour (point 16, DOMAINRULES.md section 44)", () => {
    async function createClientWithLicense(overrides: Record<string, unknown>) {
      const response = await apiFetch("/api/clients", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ name: "Client Sprint 29", ...overrides }),
      });
      return (await response.json()).client as { id: string };
    }

    // Plage 2034-xx isolée : aucune autre location de ce fichier (ni d'aucun autre fichier de
    // test, vérifié) n'utilise l'année 2034 — élimine tout risque de VehicleNotAvailableError
    // (409) accidentel avec un test déjà existant sur vehicleAId.
    it("refuse (400) si le permis expire strictement avant la date de retour — aucune Location créée", async () => {
      const client = await createClientWithLicense({ licenseExpiryDate: "2034-04-04", birthDate: "1990-01-01" });

      const before = await prisma.location.count({ where: { vehicleId: vehicleAId, clientId: client.id } });

      const response = await createLocation(adminA, {
        clientId: client.id,
        startDate: "2034-04-10",
        endDate: "2034-04-13", // permis expiré 9 jours avant le retour
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/expire avant la date de retour/i);

      const after = await prisma.location.count({ where: { vehicleId: vehicleAId, clientId: client.id } });
      expect(after).toBe(before);
    });

    it("accepte lorsque la date d'expiration du permis est égale à la date de retour, après normalisation UTC (heure ignorée)", async () => {
      // Retour à 14h UTC le 20/04 ; permis expirant minuit UTC le même jour calendaire —
      // égalité au sens du jour UTC, pas de l'horodatage exact (décision validée).
      const client = await createClientWithLicense({ licenseExpiryDate: "2034-04-20", birthDate: "1990-01-01" });

      const response = await createLocation(adminA, {
        clientId: client.id,
        startDate: "2034-04-18T10:00:00.000Z",
        endDate: "2034-04-20T14:00:00.000Z",
      });
      expect(response.status).toBe(201);
    });

    it("accepte lorsque la date d'expiration du permis est postérieure à la date de retour", async () => {
      const client = await createClientWithLicense({ licenseExpiryDate: "2034-05-01", birthDate: "1990-01-01" });

      const response = await createLocation(adminA, {
        clientId: client.id,
        startDate: "2034-04-22",
        endDate: "2034-04-25",
      });
      expect(response.status).toBe(201);
    });

    it("refuse (400) si licenseExpiryDate est absente — aucune Location créée", async () => {
      const client = await createClientWithLicense({});

      const before = await prisma.location.count({ where: { vehicleId: vehicleAId, clientId: client.id } });

      const response = await createLocation(adminA, {
        clientId: client.id,
        startDate: "2034-04-28",
        endDate: "2034-04-30",
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/n'est pas renseignée/i);

      const after = await prisma.location.count({ where: { vehicleId: vehicleAId, clientId: client.id } });
      expect(after).toBe(before);
    });

    it("non-régression : un contrat avec permis valide (clientAId, expiration 2099) est toujours accepté", async () => {
      const response = await createLocation(adminA, { startDate: "2034-05-05", endDate: "2034-05-07" });
      expect(response.status).toBe(201);
    });

    it("portée limitée à la création : updateLocation() ne revérifie pas le permis lors d'un changement de dates (hors périmètre Sprint 29, documenté)", async () => {
      const client = await createClientWithLicense({ licenseExpiryDate: "2034-05-12", birthDate: "1990-01-01" });
      const createResponse = await createLocation(adminA, {
        clientId: client.id,
        startDate: "2034-05-10",
        endDate: "2034-05-12", // égal à l'expiration : accepté à la création
      });
      expect(createResponse.status).toBe(201);
      const locationId = (await createResponse.json()).location.id;

      // Toujours PENDING (aucun status transmis) : les dates restent modifiables. On les
      // repousse au-delà de l'expiration du permis (2034-05-15 > 2034-05-12) — updateLocation
      // n'exécute aucune vérification de permis (portée Sprint 29 volontairement limitée à
      // createLocation, voir DOMAINRULES.md section 44) : accepté malgré l'incohérence.
      const updateResponse = await apiFetch(`/api/locations/${locationId}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ startDate: "2034-05-13", endDate: "2034-05-15" }),
      });
      expect(updateResponse.status).toBe(200);
    });
  });

  describe("Sprint 30 — âge minimum du conducteur à la date de départ (point 7, DOMAINRULES.md section 45)", () => {
    // Plage 2035-xx isolée (aucune autre location de ce fichier n'utilise cette année) — élimine
    // tout risque de VehicleNotAvailableError (409) accidentel avec un test déjà existant sur
    // vehicleAId. licenseExpiryDate systématiquement 2099-12-31 (permis toujours valide, voir
    // Sprint 29 ci-dessus) pour isoler strictement le contrôle d'âge testé ici.
    async function createClientWithBirthDate(overrides: Record<string, unknown>) {
      const response = await apiFetch("/api/clients", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ name: "Client Sprint 30", licenseExpiryDate: "2099-12-31", ...overrides }),
      });
      return (await response.json()).client as { id: string };
    }

    it("refuse (400) un client âgé de 20 ans et 364 jours à la date de départ — aucune Location créée", async () => {
      // Départ le 2035-06-15 ; 21e anniversaire le 2035-06-16 (un jour après) → 20 ans et 364 jours.
      const client = await createClientWithBirthDate({ birthDate: "2014-06-16" });

      const before = await prisma.location.count({ where: { vehicleId: vehicleAId, clientId: client.id } });

      const response = await createLocation(adminA, {
        clientId: client.id,
        startDate: "2035-06-15",
        endDate: "2035-06-17",
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/n'a pas encore 21 ans/i);

      const after = await prisma.location.count({ where: { vehicleId: vehicleAId, clientId: client.id } });
      expect(after).toBe(before);
    });

    it("accepte un client exactement âgé de 21 ans le jour de la date de départ", async () => {
      // Départ le 2035-06-20 ; anniversaire le même jour calendaire → exactement 21 ans.
      const client = await createClientWithBirthDate({ birthDate: "2014-06-20" });

      const response = await createLocation(adminA, {
        clientId: client.id,
        startDate: "2035-06-20",
        endDate: "2035-06-22",
      });
      expect(response.status).toBe(201);
    });

    it("accepte un client plus âgé que le minimum requis", async () => {
      const client = await createClientWithBirthDate({ birthDate: "1990-01-01" });

      const response = await createLocation(adminA, {
        clientId: client.id,
        startDate: "2035-06-25",
        endDate: "2035-06-27",
      });
      expect(response.status).toBe(201);
    });

    it("refuse (400) si birthDate est absente — aucune Location créée", async () => {
      const client = await createClientWithBirthDate({});

      const before = await prisma.location.count({ where: { vehicleId: vehicleAId, clientId: client.id } });

      const response = await createLocation(adminA, {
        clientId: client.id,
        startDate: "2035-06-28",
        endDate: "2035-06-30",
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/date de naissance.*n'est pas renseignée/i);

      const after = await prisma.location.count({ where: { vehicleId: vehicleAId, clientId: client.id } });
      expect(after).toBe(before);
    });

    it("refuse (400) si birthDate est postérieure à la date du jour", async () => {
      // POST /api/clients refuse déjà une birthDate future à la création (Task Client
      // model/API) — une birthDate future ne peut donc normalement jamais atteindre ce
      // contrôle métier. Vérifié ici en défense en profondeur : une valeur déjà en base
      // (contournement direct, hors API) reste bloquée à la création du contrat.
      const client = await createClientWithBirthDate({ birthDate: "1990-01-01" });
      await prisma.client.update({ where: { id: client.id }, data: { birthDate: new Date("2099-01-01") } });

      const response = await createLocation(adminA, {
        clientId: client.id,
        startDate: "2035-07-02",
        endDate: "2035-07-04",
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/postérieure à la date du jour/i);
    });

    it("non-régression : un contrat avec un client majeur (clientAId, né en 1990) est toujours accepté", async () => {
      const response = await createLocation(adminA, { startDate: "2035-07-06", endDate: "2035-07-08" });
      expect(response.status).toBe(201);
    });
  });
});

describe("Sprint 30 — âge minimum du second conducteur ajouté via PATCH /api/locations/[id] (point 7, DOMAINRULES.md section 45)", () => {
  async function createClientWithBirthDate(overrides: Record<string, unknown>) {
    const response = await apiFetch("/api/clients", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: "Second Conducteur Sprint 30", ...overrides }),
    });
    return (await response.json()).client as { id: string };
  }

  it("refuse (400) l'ajout d'un second conducteur âgé de moins de 21 ans à la date de départ du contrat", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2035-08-01", endDate: "2035-08-03" });
    const locationId = (await createResponse.json()).location.id;

    // 21e anniversaire le 2035-08-02 (un jour après le départ) → 20 ans et 364 jours au départ.
    const secondDriver = await createClientWithBirthDate({ birthDate: "2014-08-02" });

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ secondDriverId: secondDriver.id }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/n'a pas encore 21 ans/i);

    const locationAfter = await prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    expect(locationAfter.secondDriverId).toBeNull();
  });

  it("accepte un second conducteur exactement âgé de 21 ans à la date de départ du contrat", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2035-08-10", endDate: "2035-08-12" });
    const locationId = (await createResponse.json()).location.id;

    const secondDriver = await createClientWithBirthDate({ birthDate: "2014-08-10" });

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ secondDriverId: secondDriver.id }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.secondDriverId).toBe(secondDriver.id);
  });

  it("refuse (400) un second conducteur sans birthDate connue", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2035-08-15", endDate: "2035-08-17" });
    const locationId = (await createResponse.json()).location.id;

    const secondDriver = await createClientWithBirthDate({});

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ secondDriverId: secondDriver.id }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/second conducteur.*n'est pas renseignée/i);
  });

  it("un contrat déjà verrouillé (hors PENDING, dates non modifiables) reste soumis au contrôle d'âge pour un second conducteur ajouté après coup", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2035-08-20",
      endDate: "2035-08-22",
      status: "CONFIRMED",
    });
    const locationId = (await createResponse.json()).location.id;

    // Les dates restent verrouillées (LocationLockedError) sur ce contrat CONFIRMED pour un
    // titulaire ordinaire (linkedMemberA, sans adminOverride — un ADMIN contournerait ce verrou,
    // voir DOMAINRULES.md section 37, non représentatif ici), mais secondDriverId n'est jamais
    // verrouillé (voir UpdateLocationInput.secondDriverId) — le contrôle d'âge s'applique donc
    // malgré tout, sans dépendre du statut du contrat.
    const lockedDatesResponse = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: linkedMemberA.sessionCookie },
      body: JSON.stringify({ startDate: "2035-08-21", endDate: "2035-08-23" }),
    });
    expect(lockedDatesResponse.status).toBe(409);

    const tooYoungSecondDriver = await createClientWithBirthDate({ birthDate: "2020-01-01" });
    const rejectedResponse = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ secondDriverId: tooYoungSecondDriver.id }),
    });
    expect(rejectedResponse.status).toBe(400);

    const adultSecondDriver = await createClientWithBirthDate({ birthDate: "1990-01-01" });
    const acceptedResponse = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ secondDriverId: adultSecondDriver.id }),
    });
    expect(acceptedResponse.status).toBe(200);
  });
});

describe("GET /api/locations", () => {
  it("liste uniquement les locations du tenant connecté (isolation multi-tenant)", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-07-01",
      endDate: "2028-07-03",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch("/api/locations", { headers: { Cookie: adminA.sessionCookie } });
    const body = await response.json();
    const ids: string[] = body.locations.map((l: { id: string }) => l.id);
    expect(ids).toContain(locationId);

    const otherTenantResponse = await apiFetch("/api/locations", {
      headers: { Cookie: adminB.sessionCookie },
    });
    const otherBody = await otherTenantResponse.json();
    const otherIds: string[] = otherBody.locations.map((l: { id: string }) => l.id);
    expect(otherIds).not.toContain(locationId);
  });

  it("filtre par statut", async () => {
    const response = await apiFetch("/api/locations?status=PENDING", {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.locations.every((l: { status: string }) => l.status === "PENDING")).toBe(true);
  });
});

/**
 * BUG-004 (INCIDENTS.md) — un contrat créé à l'agence de départ (agencyId) avec une agence de
 * retour (dropoffAgencyId) distincte doit rester visible à l'agence de retour, dans la liste
 * (GET /api/locations) comme sur la fiche (GET /api/locations/[id]), sans donner à cette agence
 * un accès général à toutes les locations, sans casser l'isolation tenant, et sans changer les
 * actions déjà réservées à l'agence de départ. Reproduit le scénario réel RAK → CASA (contrat
 * n°00002) avec un tenant/deux agences dédiés à ce test.
 */
describe("BUG-004 — visibilité d'une location par l'agence de RETOUR (dropoffAgencyId)", () => {
  let pickupAgencyId: string;
  let dropoffAgencyId: string;
  let pickupOnlyMember: AuthenticatedTestUser;
  let dropoffOnlyMember: AuthenticatedTestUser;
  let unrelatedMember: AuthenticatedTestUser;
  let crossLocationId: string;

  beforeAll(async () => {
    const pickupAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `RAK-${runId}`, slug: `rak-${runId}` }),
    });
    pickupAgencyId = (await pickupAgencyResponse.json()).agency.id;

    const dropoffAgencyResponse = await apiFetch("/api/agencies", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `CASA-${runId}`, slug: `casa-${runId}` }),
    });
    dropoffAgencyId = (await dropoffAgencyResponse.json()).agency.id;

    // Préfixe de numérotation dédié (DOMAINRULES.md section 29) : sans lui, cette nouvelle
    // agence redémarrerait la séquence de numéros de contrat à 1 et entrerait en collision avec
    // agencyA1Id (même tenant, déjà utilisée par de nombreux autres tests de ce fichier) sur la
    // contrainte d'unicité (tenantId, contractNumber).
    await apiFetch(`/api/agencies/${pickupAgencyId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ contractNumberPrefix: `RAK4${runId}` }),
    });
    await apiFetch(`/api/agencies/${dropoffAgencyId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ contractNumberPrefix: `CASA4${runId}` }),
    });

    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId: pickupAgencyId,
        name: "Clio RAK",
        licensePlate: `BUG4-${runId}`,
        make: "Renault",
        model: "Clio",
        year: 2022,
        category: "Citadine",
        pricePerDay: 5000,
        chassisNumber: `VF1BUG4${Math.floor(Math.random() * 1_000_000)}`,
        color: "Blanc",
        doors: 5,
        seats: 5,
        horsepower: 6,
        powerKW: 75,
        engineSize: 1.5,
      }),
    });
    const bug4VehicleId = (await vehicleResponse.json()).vehicle.id;

    const createResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ vehicleId: bug4VehicleId, clientId: clientAId, ...nextTestDateRange() }),
    });
    crossLocationId = (await createResponse.json()).location.id;

    // dropoffAgencyId n'est renseignable que par la conversion réservation → contrat
    // (DOMAINRULES.md section 37) ; ce test exerce la règle de visibilité elle-même (déjà
    // couverte ailleurs pour la conversion), donc l'état est posé directement en base, comme
    // d'autres tests de ce fichier (ex. contractNumber, ligne ~1593) et de data-reset.test.ts.
    await prisma.location.update({
      where: { id: crossLocationId },
      data: { dropoffAgencyId },
    });

    pickupOnlyMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Agent RAK",
      email: `agent-rak-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: pickupOnlyMember.userId, agencyId: pickupAgencyId } });

    dropoffOnlyMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Agent CASA",
      email: `agent-casa-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: dropoffOnlyMember.userId, agencyId: dropoffAgencyId } });

    unrelatedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Agent sans agence",
      email: `agent-sans-agence-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
  });

  it("l'agent de l'agence de départ (RAK) voit le contrat dans la liste et sur la fiche", async () => {
    const listResponse = await apiFetch("/api/locations", { headers: { Cookie: pickupOnlyMember.sessionCookie } });
    const listBody = await listResponse.json();
    expect((listBody.locations as { id: string }[]).map((l) => l.id)).toContain(crossLocationId);

    const detailResponse = await apiFetch(`/api/locations/${crossLocationId}`, {
      headers: { Cookie: pickupOnlyMember.sessionCookie },
    });
    expect(detailResponse.status).toBe(200);
  });

  it("l'agent de l'agence de RETOUR (CASA) voit désormais le contrat dans la liste et sur la fiche", async () => {
    const listResponse = await apiFetch("/api/locations", { headers: { Cookie: dropoffOnlyMember.sessionCookie } });
    const listBody = await listResponse.json();
    expect((listBody.locations as { id: string }[]).map((l) => l.id)).toContain(crossLocationId);

    const detailResponse = await apiFetch(`/api/locations/${crossLocationId}`, {
      headers: { Cookie: dropoffOnlyMember.sessionCookie },
    });
    expect(detailResponse.status).toBe(200);
  });

  it("l'agent CASA (retour uniquement) peut enregistrer la réception (endOdometer) mais reste limité à cette action", async () => {
    const allowedResponse = await apiFetch(`/api/locations/${crossLocationId}`, {
      method: "PATCH",
      headers: { Cookie: dropoffOnlyMember.sessionCookie },
      body: JSON.stringify({ endOdometer: 50 }),
    });
    expect(allowedResponse.status).toBe(200);

    const forbiddenResponse = await apiFetch(`/api/locations/${crossLocationId}`, {
      method: "PATCH",
      headers: { Cookie: dropoffOnlyMember.sessionCookie },
      body: JSON.stringify({ notes: "Tentative de modification hors périmètre retour" }),
    });
    expect(forbiddenResponse.status).toBe(403);
  });

  it("un agent sans rattachement à RAK ni CASA ne voit pas le contrat (pas d'accès général élargi)", async () => {
    const listResponse = await apiFetch("/api/locations", { headers: { Cookie: unrelatedMember.sessionCookie } });
    const listBody = await listResponse.json();
    expect((listBody.locations as { id: string }[]).map((l) => l.id)).not.toContain(crossLocationId);

    const detailResponse = await apiFetch(`/api/locations/${crossLocationId}`, {
      headers: { Cookie: unrelatedMember.sessionCookie },
    });
    expect(detailResponse.status).toBe(404);
  });

  it("un tenant différent ne voit jamais le contrat, ni par la liste ni par accès direct (isolation)", async () => {
    const listResponse = await apiFetch("/api/locations", { headers: { Cookie: adminB.sessionCookie } });
    const listBody = await listResponse.json();
    expect((listBody.locations as { id: string }[]).map((l) => l.id)).not.toContain(crossLocationId);

    const detailResponse = await apiFetch(`/api/locations/${crossLocationId}`, {
      headers: { Cookie: adminB.sessionCookie },
    });
    expect(detailResponse.status).toBe(404);
  });

  it("un ADMIN du même tenant voit toujours le contrat (accès transverse inchangé)", async () => {
    const listResponse = await apiFetch("/api/locations", { headers: { Cookie: adminA.sessionCookie } });
    const listBody = await listResponse.json();
    expect((listBody.locations as { id: string }[]).map((l) => l.id)).toContain(crossLocationId);
  });
});

describe("PATCH /api/locations/[id]", () => {
  it("retourne 404 pour une location d'un autre tenant", async () => {
    const otherLocationResponse = await apiFetch("/api/locations", {
      method: "POST",
      headers: { Cookie: adminB.sessionCookie },
      body: JSON.stringify({
        vehicleId: vehicleBId,
        clientId: clientBId,
        startDate: "2028-08-01",
        endDate: "2028-08-03",
      }),
    });
    const otherLocationId = (await otherLocationResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${otherLocationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(response.status).toBe(404);
  });

  it("autorise la transition PENDING → CONFIRMED", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-09-01",
      endDate: "2028-09-03",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.status).toBe("CONFIRMED");
  });

  it("refuse une transition de statut invalide (PENDING → COMPLETED) pour un MEMBER", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-09-10",
      endDate: "2028-09-13",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: linkedMemberA.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    expect(response.status).toBe(409);
  });

  it("Sprint 19 : un ADMIN peut forcer une transition de statut invalide (override, journalisé)", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-09-15",
      endDate: "2028-09-18",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).location.status).toBe("COMPLETED");

    const auditResponse = await apiFetch(
      `/api/audit?resource=Location&action=location.admin_override`,
      { headers: { Cookie: adminA.sessionCookie } }
    );
    const auditLogs = (await auditResponse.json()).logs as { resourceId: string }[];
    expect(auditLogs.some((log) => log.resourceId === locationId)).toBe(true);
  });

  it("recalcule totalPrice quand les dates changent", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-10-01",
      endDate: "2028-10-03",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ startDate: "2028-10-01", endDate: "2028-10-06" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.totalPrice).toBe(25000); // 5 jours × 5000
  });

  it("permet d'enregistrer le kilométrage de retour et la caution (Sprint 12A)", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2029-04-01",
      endDate: "2029-04-03",
      startOdometer: 50000,
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ endOdometer: 50180 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.startOdometer).toBe(50000);
    expect(body.location.endOdometer).toBe(50180);
  });

  // BUG-005 (INCIDENTS.md) : PATCH /api/locations/[id] est le seul chemin disponible pour
  // l'agence de RETOUR (canManageReturnOnly, voir authz.ts) — contrairement à
  // POST /api/locations/[id]/return (déjà validé, voir location-return.test.ts), il acceptait
  // endOdometer sans jamais le comparer à startOdometer.
  describe("BUG-005 — kilométrage retour doit être strictement supérieur au départ", () => {
    // Véhicule dédié (plutôt que vehicleAId, déjà réservé sur de nombreuses plages explicites
    // ailleurs dans ce fichier) : évite toute collision de disponibilité (409) avec
    // nextTestDateRange(), dont le compteur global peut retomber sur une date déjà prise par un
    // autre test de ce fichier utilisant des dates explicites plutôt que le compteur.
    let bug5VehicleId: string;

    beforeAll(async () => {
      const vehicleResponse = await apiFetch("/api/vehicles", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({
          agencyId: agencyA1Id,
          name: "Clio BUG-005",
          licensePlate: `BUG5-${runId}`,
          make: "Renault",
          model: "Clio",
          year: 2022,
          category: "Citadine",
          pricePerDay: 5000,
          chassisNumber: `VF1BUG5${Math.floor(Math.random() * 1_000_000)}`,
          color: "Blanc",
          doors: 5,
          seats: 5,
          horsepower: 6,
          powerKW: 75,
          engineSize: 1.5,
        }),
      });
      bug5VehicleId = (await vehicleResponse.json()).vehicle.id;
    });

    async function createLocationWithStartOdometer(startOdometer: number) {
      const createResponse = await createLocation(adminA, {
        ...nextTestDateRange(),
        vehicleId: bug5VehicleId,
        startOdometer,
      });
      const json = await createResponse.json();
      return json.location.id as string;
    }

    it("refuse un kilométrage retour inférieur au départ", async () => {
      const locationId = await createLocationWithStartOdometer(30000);
      const response = await apiFetch(`/api/locations/${locationId}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ endOdometer: 29999 }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe(
        "Le kilométrage de retour doit être un entier strictement supérieur au kilométrage de départ."
      );
    });

    it("refuse un kilométrage retour égal au départ", async () => {
      const locationId = await createLocationWithStartOdometer(30000);
      const response = await apiFetch(`/api/locations/${locationId}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ endOdometer: 30000 }),
      });
      expect(response.status).toBe(400);
    });

    it("refuse une valeur négative", async () => {
      const locationId = await createLocationWithStartOdometer(30000);
      const response = await apiFetch(`/api/locations/${locationId}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ endOdometer: -10 }),
      });
      expect(response.status).toBe(400);
    });

    it("refuse une valeur non numérique", async () => {
      const locationId = await createLocationWithStartOdometer(30000);
      const response = await apiFetch(`/api/locations/${locationId}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ endOdometer: "abc" }),
      });
      expect(response.status).toBe(400);
    });

    it("n'exige rien si endOdometer n'est pas fourni (champ non modifié)", async () => {
      const locationId = await createLocationWithStartOdometer(30000);
      const response = await apiFetch(`/api/locations/${locationId}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ notes: "Sans rapport avec le kilométrage" }),
      });
      expect(response.status).toBe(200);
    });

    it("accepte une valeur strictement supérieure au départ, et l'état persiste correctement en base", async () => {
      const locationId = await createLocationWithStartOdometer(30000);
      const response = await apiFetch(`/api/locations/${locationId}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ endOdometer: 30001 }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.location.endOdometer).toBe(30001);

      const persisted = await prisma.location.findUnique({ where: { id: locationId } });
      expect(persisted?.endOdometer).toBe(30001);
    });

    it("un rejet ne modifie aucun champ (pas de mise à jour partielle) : endOdometer reste inchangé en base", async () => {
      const locationId = await createLocationWithStartOdometer(30000);
      const rejected = await apiFetch(`/api/locations/${locationId}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ notes: "Tentative avec kilométrage invalide", endOdometer: 100 }),
      });
      expect(rejected.status).toBe(400);

      const persisted = await prisma.location.findUnique({ where: { id: locationId } });
      expect(persisted?.endOdometer).toBeNull();
      expect(persisted?.notes).not.toBe("Tentative avec kilométrage invalide");
    });
  });
});

describe("DELETE /api/locations/[id]", () => {
  it("supprime une location PENDING", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-11-01",
      endDate: "2028-11-03",
    });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
  });

  it("refuse la suppression d'une location CONFIRMED (doit être annulée d'abord, désormais via admin-cancel — Sprint 23, DOMAINRULES.md section 39)", async () => {
    const createResponse = await createLocation(adminA, {
      startDate: "2028-11-10",
      endDate: "2028-11-13",
    });
    const locationId = (await createResponse.json()).location.id;

    await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const deleteResponse = await apiFetch(`/api/locations/${locationId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteResponse.status).toBe(409);

    // Sprint 23 : un contrat déjà validé (CONFIRMED) ne peut plus être annulé via la
    // transition PATCH simple, même pour un ADMIN — seul POST .../admin-cancel le permet
    // (voir LocationCancellationRequiresAdminError, src/lib/locations.ts).
    const cancelResponse = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(cancelResponse.status).toBe(403);

    const adminCancelResponse = await apiFetch(`/api/locations/${locationId}/admin-cancel`, {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ reason: "Annulation — pas de paiement enregistré" }),
    });
    expect(adminCancelResponse.status).toBe(200);

    // Aucun paiement n'a jamais été enregistré ici (facture restée DRAFT, amountPaid = 0) —
    // admin-cancel ne la force donc pas à CANCELLED (voir le commentaire dans
    // adminCancelValidatedLocation), la suppression reste donc possible ensuite.
    const deleteAfterCancelResponse = await apiFetch(`/api/locations/${locationId}`, {
      method: "DELETE",
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(deleteAfterCancelResponse.status).toBe(200);
  });
});

describe("Sprint 14B — numérotation de contrat", () => {
  it("génère un numéro de contrat séquentiel à la création", async () => {
    const first = await createLocation(adminA, { startDate: "2029-05-01", endDate: "2029-05-03" });
    const firstBody = await first.json();
    const second = await createLocation(adminA, { startDate: "2029-05-05", endDate: "2029-05-07" });
    const secondBody = await second.json();

    expect(firstBody.location.contractNumber).toBeTruthy();
    expect(secondBody.location.contractNumber).toBeTruthy();

    const firstN = Number(firstBody.location.contractNumber.split("-").pop());
    const secondN = Number(secondBody.location.contractNumber.split("-").pop());
    expect(secondN).toBe(firstN + 1);
  });

  it("respecte le préfixe et le dernier numéro configurés dans les paramètres de l'agence (Sprint 15 — numérotation déplacée vers Agency)", async () => {
    await apiFetch(`/api/agencies/${agencyA1Id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ contractNumberPrefix: "RAK", lastContractNumber: 120 }),
    });

    const response = await createLocation(adminA, { startDate: "2029-06-01", endDate: "2029-06-03" });
    const body = await response.json();
    expect(body.location.contractNumber).toBe("RAK-00121");
  });

  it("réessaie avec le numéro suivant en cas de collision (redéfinition manuelle en arrière)", async () => {
    const first = await createLocation(adminA, { startDate: "2029-07-01", endDate: "2029-07-03" });
    const firstBody = await first.json();
    const firstN = Number(firstBody.location.contractNumber.split("-").pop());

    // Rembobine volontairement le compteur pour forcer une collision sur le prochain numéro
    // (Sprint 15 — la numérotation est désormais portée par Agency, pas Tenant).
    await apiFetch(`/api/agencies/${agencyA1Id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ lastContractNumber: firstN - 1 }),
    });

    const second = await createLocation(adminA, { startDate: "2029-07-10", endDate: "2029-07-12" });
    expect(second.status).toBe(201);
    const secondBody = await second.json();
    expect(secondBody.location.contractNumber).not.toBe(firstBody.location.contractNumber);
    // Le contrat existant n'a pas été affecté par la collision.
    const existing = await prisma.location.findUnique({ where: { id: firstBody.location.id } });
    expect(existing?.contractNumber).toBe(firstBody.location.contractNumber);
  });

  it("verrouille les dates une fois le contrat sorti de PENDING (CONFIRMED) pour un MEMBER", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2029-08-01", endDate: "2029-08-03" });
    const locationId = (await createResponse.json()).location.id;

    await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: linkedMemberA.sessionCookie },
      body: JSON.stringify({ startDate: "2029-08-02", endDate: "2029-08-04" }),
    });
    expect(response.status).toBe(409);

    // Le statut, lui, reste modifiable (seules les dates sont verrouillées).
    const notesResponse = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: linkedMemberA.sessionCookie },
      body: JSON.stringify({ notes: "toujours modifiable" }),
    });
    expect(notesResponse.status).toBe(200);
  });

  it("Sprint 19 : un ADMIN peut modifier les dates d'un contrat verrouillé (override, journalisé)", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2029-08-10", endDate: "2029-08-12" });
    const locationId = (await createResponse.json()).location.id;

    await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ startDate: "2029-08-11", endDate: "2029-08-13" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.location.startDate).toContain("2029-08-11");

    const auditResponse = await apiFetch(
      `/api/audit?resource=Location&action=location.admin_override`,
      { headers: { Cookie: adminA.sessionCookie } }
    );
    const auditLogs = (await auditResponse.json()).logs as { resourceId: string }[];
    expect(auditLogs.some((log) => log.resourceId === locationId)).toBe(true);
  });

  it("permet toujours de modifier les dates tant que le contrat est PENDING", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2029-09-01", endDate: "2029-09-03" });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ startDate: "2029-09-01", endDate: "2029-09-05" }),
    });
    expect(response.status).toBe(200);
  });
});

describe("GET /api/locations/[id]/pdf", () => {
  it("refuse une requête non authentifiée", async () => {
    const response = await apiFetch("/api/locations/nonexistent/pdf");
    expect(response.status).toBe(401);
  });

  it("génère le PDF du contrat pour un contrat numéroté", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2029-10-01", endDate: "2029-10-03" });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}/pdf`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
  });

  it("refuse un contrat sans numéro (créé avant la numérotation)", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2029-10-10", endDate: "2029-10-12" });
    const locationId = (await createResponse.json()).location.id;
    await prisma.location.update({ where: { id: locationId }, data: { contractNumber: null } });

    const response = await apiFetch(`/api/locations/${locationId}/pdf`, {
      headers: { Cookie: adminA.sessionCookie },
    });
    expect(response.status).toBe(404);
  });

  it("refuse l'accès à un contrat d'un autre tenant", async () => {
    const createResponse = await createLocation(adminA, { startDate: "2029-10-15", endDate: "2029-10-17" });
    const locationId = (await createResponse.json()).location.id;

    const response = await apiFetch(`/api/locations/${locationId}/pdf`, {
      headers: { Cookie: adminB.sessionCookie },
    });
    expect(response.status).toBe(404);
  });
});

describe("Sprint 15 — permissions granulaires (locations.create)", () => {
  it("refuse un MEMBER rattaché à l'agence mais dont le groupe personnalisé n'a pas locations.create", async () => {
    const restrictedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `NoLocationCreate-${runId}`, permissions: ["locations.view"] }),
    });
    const restrictedGroupId = (await restrictedGroupResponse.json()).group.id;

    const restrictedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Restricted Member",
      email: `restricted-locations-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: restrictedMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${restrictedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: restrictedGroupId }),
    });

    const response = await createLocation(restrictedMember, { startDate: "2029-11-01", endDate: "2029-11-03" });
    expect(response.status).toBe(403);
  });

  it("autorise un MEMBER dont le groupe personnalisé accorde locations.create", async () => {
    const grantedGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `WithLocationCreate-${runId}`, permissions: ["locations.view", "locations.create"] }),
    });
    const grantedGroupId = (await grantedGroupResponse.json()).group.id;

    const grantedMember = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name: "Granted Member",
      email: `granted-locations-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: grantedMember.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${grantedMember.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: grantedGroupId }),
    });

    const response = await createLocation(grantedMember, { startDate: "2029-11-05", endDate: "2029-11-07" });
    expect(response.status).toBe(201);
  });

  it("un ADMIN crée une location même rattaché à un groupe personnalisé vide (bypass systématique)", async () => {
    const emptyGroupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `EmptyAdminGroup-${runId}`, permissions: [] }),
    });
    const emptyGroupId = (await emptyGroupResponse.json()).group.id;

    await apiFetch(`/api/users/${adminA.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: emptyGroupId }),
    });

    try {
      const response = await createLocation(adminA, { startDate: "2029-11-10", endDate: "2029-11-12" });
      expect(response.status).toBe(201);
    } finally {
      await apiFetch(`/api/users/${adminA.userId}/permissions`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ permissionGroupId: null }),
      });
    }
  });
});

describe("Sprint 24 — locations.confirm/activate/complete/cancel séparées de locations.edit", () => {
  async function createGroupAndMember(name: string, permissions: string[]) {
    const groupResponse = await apiFetch("/api/permission-groups", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ name: `${name}-${runId}`, permissions }),
    });
    const groupId = (await groupResponse.json()).group.id;

    const member = await createAndLoginMember({
      tenantId: adminA.tenantId,
      name,
      email: `${name.toLowerCase()}-${runId}@test.local`,
      password: "Correct-Horse-Battery-Staple9!",
    });
    await prisma.userAgency.create({ data: { userId: member.userId, agencyId: agencyA1Id } });
    await apiFetch(`/api/users/${member.userId}/permissions`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ permissionGroupId: groupId }),
    });
    return member;
  }

  it("locations.edit seul ne permet plus de confirmer, activer, terminer ni annuler", async () => {
    const editOnly = await createGroupAndMember("LocEditOnly", ["locations.view", "locations.edit"]);

    const createResponse = await createLocation(adminA, { startDate: "2029-12-01", endDate: "2029-12-03" });
    const location = (await createResponse.json()).location;

    for (const status of ["CONFIRMED", "CANCELLED"]) {
      const response = await apiFetch(`/api/locations/${location.id}`, {
        method: "PATCH",
        headers: { Cookie: editOnly.sessionCookie },
        body: JSON.stringify({ status }),
      });
      expect(response.status).toBe(403);
    }

    // Un champ générique (notes) reste autorisé avec locations.edit seul.
    const notesResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: editOnly.sessionCookie },
      body: JSON.stringify({ notes: "Note ajoutée par LocEditOnly" }),
    });
    expect(notesResponse.status).toBe(200);
  });

  it("locations.confirm seul confirme, sans locations.edit", async () => {
    const confirmOnly = await createGroupAndMember("LocConfirmOnly", ["locations.view", "locations.confirm"]);

    const createResponse = await createLocation(adminA, { startDate: "2029-12-05", endDate: "2029-12-07" });
    const location = (await createResponse.json()).location;

    const confirmResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: confirmOnly.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(confirmResponse.status).toBe(200);
    expect((await confirmResponse.json()).location.status).toBe("CONFIRMED");

    const notesResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: confirmOnly.sessionCookie },
      body: JSON.stringify({ notes: "Tentative" }),
    });
    expect(notesResponse.status).toBe(403);
  });

  it("locations.activate seul active (CONFIRMED → ACTIVE), sans locations.edit", async () => {
    const activateOnly = await createGroupAndMember("LocActivateOnly", ["locations.view", "locations.activate"]);

    const createResponse = await createLocation(adminA, { startDate: "2029-12-08", endDate: "2029-12-10" });
    const location = (await createResponse.json()).location;
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });

    const activateResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: activateOnly.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });
    expect(activateResponse.status).toBe(200);
    expect((await activateResponse.json()).location.status).toBe("ACTIVE");
  });

  it("locations.complete seul termine (→ COMPLETED), sans locations.edit", async () => {
    const completeOnly = await createGroupAndMember("LocCompleteOnly", ["locations.view", "locations.complete"]);

    const createResponse = await createLocation(adminA, { startDate: "2029-12-11", endDate: "2029-12-13" });
    const location = (await createResponse.json()).location;
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    const completeResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: completeOnly.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    expect(completeResponse.status).toBe(200);
    expect((await completeResponse.json()).location.status).toBe("COMPLETED");
  });

  it("locations.cancel seul annule un contrat PENDING, sans locations.edit", async () => {
    const cancelOnly = await createGroupAndMember("LocCancelOnly", ["locations.view", "locations.cancel"]);

    const createResponse = await createLocation(adminA, { startDate: "2029-12-15", endDate: "2029-12-17" });
    const location = (await createResponse.json()).location;

    const cancelResponse = await apiFetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { Cookie: cancelOnly.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(cancelResponse.status).toBe(200);
    expect((await cancelResponse.json()).location.status).toBe("CANCELLED");
  });

  it("un ADMIN (super admin du tenant) confirme/active/termine/annule sans aucun groupe de permissions", async () => {
    const progressResponse = await createLocation(adminA, { startDate: "2029-12-20", endDate: "2029-12-22" });
    const progress = (await progressResponse.json()).location;

    const confirmResponse = await apiFetch(`/api/locations/${progress.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CONFIRMED" }),
    });
    expect(confirmResponse.status).toBe(200);

    const activateResponse = await apiFetch(`/api/locations/${progress.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "ACTIVE" }),
    });
    expect(activateResponse.status).toBe(200);

    const completeResponse = await apiFetch(`/api/locations/${progress.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "COMPLETED" }),
    });
    expect(completeResponse.status).toBe(200);

    const cancelTargetResponse = await createLocation(adminA, { startDate: "2029-12-23", endDate: "2029-12-25" });
    const cancelTarget = (await cancelTargetResponse.json()).location;
    const cancelResponse = await apiFetch(`/api/locations/${cancelTarget.id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ status: "CANCELLED" }),
    });
    expect(cancelResponse.status).toBe(200);
  });
});

describe("Sprint 28 (Finding E) + campagne QA 2026-08-27 partie 2 — véhicule MAINTENANCE/TRANSFERRING/ON_TRIP bloque la création/modification d'une Location", () => {
  /** Statuts « en mobilité »/indisponibles posés automatiquement par vehicle-transfers.ts/
   * vehicle-trips.ts (jamais assignables manuellement via POST/PATCH /api/vehicles*,
   * DOMAINRULES.md section 30) — forcés directement en base pour isoler ce test du reste de
   * l'infrastructure de transfert/déplacement, non concernée par ce sprint. INACTIVE retiré
   * (sprint "statut opérationnel automatique", 2026-08-28) — remplacé par l'état administratif
   * séparé Vehicle.deactivatedAt, couvert par un test dédié plus bas (createDeactivatedVehicle). */
  async function createVehicleWithStatus(status: "MAINTENANCE" | "TRANSFERRING" | "ON_TRIP") {
    const response = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId: agencyA1Id,
        name: "Véhicule Finding E",
        licensePlate: `E-${status}-${runId}-${Math.floor(Math.random() * 100_000)}`,
        make: "Dacia",
        model: "Sandero",
        year: 2022,
        category: "Citadine",
        pricePerDay: 4000,
        chassisNumber: `VF1TESTE${Math.floor(Math.random() * 1_000_000)}`,
        color: "Blanc",
        doors: 5,
        seats: 5,
        horsepower: 5,
        powerKW: 55,
        engineSize: 1.0,
      }),
    });
    const vehicleId = (await response.json()).vehicle.id;
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status } });
    return vehicleId;
  }

  it.each(["MAINTENANCE", "TRANSFERRING", "ON_TRIP"] as const)(
    "refuse la création d'une Location (409) si le véhicule est %s",
    async (status) => {
      const vehicleId = await createVehicleWithStatus(status);

      const response = await createLocation(adminA, {
        vehicleId,
        startDate: "2028-04-01",
        endDate: "2028-04-03",
      });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toContain(status);

      const locationCount = await prisma.location.count({ where: { vehicleId } });
      expect(locationCount).toBe(0);
    }
  );

  it.each(["MAINTENANCE", "TRANSFERRING", "ON_TRIP"] as const)(
    "refuse la modification des dates d'une Location existante (409) si le véhicule est %s, même pour un ADMIN, sans annuler la Location automatiquement",
    async (status) => {
      const vehicleResponse = await apiFetch("/api/vehicles", {
        method: "POST",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({
          agencyId: agencyA1Id,
          name: "Véhicule Finding E (modification)",
          licensePlate: `E-MOD-${status}-${runId}-${Math.floor(Math.random() * 100_000)}`,
          make: "Dacia",
          model: "Sandero",
          year: 2022,
          category: "Citadine",
          pricePerDay: 4000,
          chassisNumber: `VF1TESTE${Math.floor(Math.random() * 1_000_000)}`,
          color: "Blanc",
          doors: 5,
          seats: 5,
          horsepower: 5,
          powerKW: 55,
          engineSize: 1.0,
        }),
      });
      const vehicleId = (await vehicleResponse.json()).vehicle.id;

      // Créé pendant que le véhicule est encore AVAILABLE (autorisé).
      const locationResponse = await createLocation(adminA, {
        vehicleId,
        startDate: "2028-05-01",
        endDate: "2028-05-03",
      });
      expect(locationResponse.status).toBe(201);
      const location = (await locationResponse.json()).location;

      await prisma.vehicle.update({ where: { id: vehicleId }, data: { status } });

      // adminA est ADMIN (adminOverride dérivé de user.role côté route) — ce contrôle ne
      // connaît aucune exception ADMIN, contrairement à LocationLockedError.
      const patchResponse = await apiFetch(`/api/locations/${location.id}`, {
        method: "PATCH",
        headers: { Cookie: adminA.sessionCookie },
        body: JSON.stringify({ startDate: "2028-05-02", endDate: "2028-05-04" }),
      });
      expect(patchResponse.status).toBe(409);
      const patchBody = await patchResponse.json();
      expect(patchBody.error).toContain(status);

      // La Location existante n'est ni annulée ni suspendue automatiquement par le changement
      // de statut du véhicule après coup (DOMAINRULES.md section 30) — seule la tentative de
      // modification est refusée, la Location reste inchangée dans son état d'origine.
      const unchanged = await prisma.location.findUniqueOrThrow({ where: { id: location.id } });
      expect(unchanged.status).toBe("PENDING");
      expect(unchanged.startDate.toISOString()).toBe(new Date("2028-05-01").toISOString());
    }
  );

  /** Sprint "statut opérationnel automatique" (2026-08-28) : un véhicule désactivé
   * (Vehicle.deactivatedAt) bloque toute nouvelle Location, indépendamment de son statut
   * opérationnel calculé — même sévérité que MAINTENANCE/TRANSFERRING/ON_TRIP ci-dessus, sans
   * exception ADMIN. */
  it("refuse la création d'une Location (409) si le véhicule est désactivé", async () => {
    const vehicleId = await createVehicleWithStatus("MAINTENANCE").then(async (id) => {
      await prisma.vehicle.update({ where: { id }, data: { status: "AVAILABLE" } });
      return id;
    });
    await prisma.vehicle.update({
      where: { id: vehicleId },
      data: { deactivatedAt: new Date(), deactivatedReason: "Panne moteur grave", deactivatedById: adminA.userId },
    });

    const response = await createLocation(adminA, {
      vehicleId,
      startDate: "2028-04-01",
      endDate: "2028-04-03",
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain("désactivé");

    const locationCount = await prisma.location.count({ where: { vehicleId } });
    expect(locationCount).toBe(0);
  });

  it("autorise la création d'une Location si le véhicule est AVAILABLE", async () => {
    const vehicleResponse = await apiFetch("/api/vehicles", {
      method: "POST",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({
        agencyId: agencyA1Id,
        name: "Véhicule Finding E (disponible)",
        licensePlate: `E-AVAILABLE-${runId}`,
        make: "Dacia",
        model: "Sandero",
        year: 2022,
        category: "Citadine",
        pricePerDay: 4000,
        chassisNumber: `VF1TESTE${Math.floor(Math.random() * 1_000_000)}`,
        color: "Blanc",
        doors: 5,
        seats: 5,
        horsepower: 5,
        powerKW: 55,
        engineSize: 1.0,
      }),
    });
    const vehicleId = (await vehicleResponse.json()).vehicle.id;

    const response = await createLocation(adminA, {
      vehicleId,
      startDate: "2028-06-01",
      endDate: "2028-06-03",
    });
    expect(response.status).toBe(201);
  });
});

// Sprint 30 (point 6b, Sprint A) : getContractsOverview supportait déjà `status` en filtre
// (src/lib/locations.ts) mais jusqu'ici jamais exposé côté UI (/dashboard/contracts,
// ContractsOverviewTable.tsx n'a pas de route API dédiée — appelée directement depuis le Server
// Component, testée ici en important la fonction lib directement, même principe que les tests de
// concurrence Sprint 26A/26C de reservations.test.ts).
describe("getContractsOverview — filtre status (Sprint 30, point 6b Sprint A)", () => {
  it("filtre par statut, combinable avec le scoping agencyIds existant", async () => {
    const pendingResponse = await createLocation(adminA, { startDate: "2028-11-01", endDate: "2028-11-03" });
    const pendingLocationId = (await pendingResponse.json()).location.id;

    const confirmedResponse = await createLocation(adminA, {
      startDate: "2028-11-05",
      endDate: "2028-11-07",
      status: "CONFIRMED",
    });
    const confirmedLocationId = (await confirmedResponse.json()).location.id;

    const allContracts = await getContractsOverview(adminA.tenantId, { agencyIds: [agencyA1Id] });
    const allIds = allContracts.map((contract) => contract.id);
    expect(allIds).toContain(pendingLocationId);
    expect(allIds).toContain(confirmedLocationId);

    const pendingOnly = await getContractsOverview(adminA.tenantId, { agencyIds: [agencyA1Id], status: "PENDING" });
    const pendingOnlyIds = pendingOnly.map((contract) => contract.id);
    expect(pendingOnlyIds).toContain(pendingLocationId);
    expect(pendingOnlyIds).not.toContain(confirmedLocationId);

    const confirmedOnly = await getContractsOverview(adminA.tenantId, {
      agencyIds: [agencyA1Id],
      status: "CONFIRMED",
    });
    const confirmedOnlyIds = confirmedOnly.map((contract) => contract.id);
    expect(confirmedOnlyIds).toContain(confirmedLocationId);
    expect(confirmedOnlyIds).not.toContain(pendingLocationId);

    // Isolation agence préservée : une agence n'ayant pas accès à agencyA1Id ne voit aucun de
    // ces deux contrats, quel que soit le filtre status.
    const otherAgencyScope = await getContractsOverview(adminA.tenantId, {
      agencyIds: [agencyB1Id],
      status: "PENDING",
    });
    expect(otherAgencyScope.map((contract) => contract.id)).not.toContain(pendingLocationId);
  });
});

// Recherche par numéro de contrat (2026-08-29) — même principe de test que le filtre status
// ci-dessus : getContractsOverview appelée directement, /dashboard/contracts n'ayant pas de
// route API dédiée (Server Component).
describe("getContractsOverview — filtre contractNumber (recherche par numéro de contrat)", () => {
  it("recherche exacte : ne retourne que le contrat dont le numéro correspond exactement", async () => {
    const response = await createLocation(adminA, { startDate: "2028-12-01", endDate: "2028-12-03" });
    const location = (await response.json()).location;
    const exactNumber = location.contractNumber as string;

    const results = await getContractsOverview(adminA.tenantId, {
      agencyIds: [agencyA1Id],
      contractNumber: exactNumber,
    });
    expect(results.map((c) => c.id)).toContain(location.id);
    expect(results.every((c) => c.contractNumber === exactNumber)).toBe(true);
  });

  it("recherche partielle : un sous-ensemble du numéro suffit à retrouver le contrat", async () => {
    const response = await createLocation(adminA, { startDate: "2028-12-05", endDate: "2028-12-07" });
    const location = (await response.json()).location;
    const exactNumber = location.contractNumber as string;
    const partial = exactNumber.slice(-3); // ex. les 3 derniers chiffres du compteur

    const results = await getContractsOverview(adminA.tenantId, {
      agencyIds: [agencyA1Id],
      contractNumber: partial,
    });
    expect(results.map((c) => c.id)).toContain(location.id);
  });

  it("insensible à la casse : une recherche en minuscules retrouve un numéro contenant des lettres majuscules", async () => {
    const prefixResponse = await apiFetch(`/api/agencies/${agencyA1Id}`, {
      method: "PATCH",
      headers: { Cookie: adminA.sessionCookie },
      body: JSON.stringify({ contractNumberPrefix: "CASE" }),
    });
    expect(prefixResponse.status).toBe(200);

    const response = await createLocation(adminA, { startDate: "2028-12-09", endDate: "2028-12-11" });
    const location = (await response.json()).location;
    expect(location.contractNumber as string).toMatch(/^CASE-/);

    const results = await getContractsOverview(adminA.tenantId, {
      agencyIds: [agencyA1Id],
      contractNumber: "case-",
    });
    expect(results.map((c) => c.id)).toContain(location.id);
  });

  it("aucun résultat pour un numéro inexistant, combinable avec le filtre status", async () => {
    const results = await getContractsOverview(adminA.tenantId, {
      agencyIds: [agencyA1Id],
      contractNumber: "NUMERO-INEXISTANT-XYZ",
      status: "PENDING",
    });
    expect(results).toHaveLength(0);
  });

  it("isolation agence préservée : un numéro de contrat existant dans une autre agence n'apparaît jamais hors de son scope", async () => {
    const response = await createLocation(adminA, { startDate: "2028-12-13", endDate: "2028-12-15" });
    const location = (await response.json()).location;

    const otherAgencyScope = await getContractsOverview(adminA.tenantId, {
      agencyIds: [agencyB1Id],
      contractNumber: location.contractNumber as string,
    });
    expect(otherAgencyScope.map((c) => c.id)).not.toContain(location.id);
  });

  it("isolation tenant préservée : un numéro de contrat existant dans un autre tenant n'apparaît jamais", async () => {
    const response = await createLocation(adminA, { startDate: "2028-12-17", endDate: "2028-12-19" });
    const location = (await response.json()).location;

    const otherTenantResults = await getContractsOverview(adminB.tenantId, {
      agencyIds: null,
      contractNumber: location.contractNumber as string,
    });
    expect(otherTenantResults).toHaveLength(0);
  });
});
