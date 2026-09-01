import { describe, expect, it } from "vitest";
import { isRequestBodyTooLarge, requestBodyTooLargeResponse, MAX_PUBLIC_JSON_BODY_BYTES } from "@/lib/request-guards";

/**
 * Correctif OWASP Phase 6 (2026-08-31) — aucune limite générale de taille de corps de requête
 * n'existait sur les routes API publiques (sans session), qui bufferisaient intégralement
 * `request.json()` avant la moindre vérification bon marché (rate limiting, authentification).
 * Tests purs (sans serveur `next dev`, même famille que `mfa-encryption.test.ts`/
 * `super-admin.test.ts`) — la fonction ne lit que l'en-tête `Content-Length`, jamais le corps
 * lui-même, donc un `Request` sans corps réel suffit à l'exercer.
 */
describe("isRequestBodyTooLarge", () => {
  it("refuse un Content-Length déclaré au-delà de la limite", () => {
    const request = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-length": String(MAX_PUBLIC_JSON_BODY_BYTES + 1) },
    });
    expect(isRequestBodyTooLarge(request, MAX_PUBLIC_JSON_BODY_BYTES)).toBe(true);
  });

  it("accepte un Content-Length égal à la limite (borne inclusive)", () => {
    const request = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-length": String(MAX_PUBLIC_JSON_BODY_BYTES) },
    });
    expect(isRequestBodyTooLarge(request, MAX_PUBLIC_JSON_BODY_BYTES)).toBe(false);
  });

  it("accepte un Content-Length raisonnable", () => {
    const request = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-length": "512" },
    });
    expect(isRequestBodyTooLarge(request, MAX_PUBLIC_JSON_BODY_BYTES)).toBe(false);
  });

  it("laisse passer une requête sans Content-Length (limite connue, documentée — voir le commentaire de request-guards.ts)", () => {
    const request = new Request("http://localhost/api/auth/login", { method: "POST" });
    expect(isRequestBodyTooLarge(request, MAX_PUBLIC_JSON_BODY_BYTES)).toBe(false);
  });

  it("ignore un Content-Length non numérique plutôt que de planter", () => {
    const request = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-length": "not-a-number" },
    });
    expect(isRequestBodyTooLarge(request, MAX_PUBLIC_JSON_BODY_BYTES)).toBe(false);
  });
});

describe("requestBodyTooLargeResponse", () => {
  it("renvoie un 413 avec un message générique mentionnant la limite", async () => {
    const response = requestBodyTooLargeResponse(MAX_PUBLIC_JSON_BODY_BYTES);
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error).toContain("volumineux");
  });
});
