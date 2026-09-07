import { describe, expect, it } from "vitest";
import { sanitizeInternalRedirect } from "@/lib/safe-redirect";

describe("sanitizeInternalRedirect", () => {
  it("accepte un chemin interne simple", () => {
    expect(sanitizeInternalRedirect("/dashboard")).toBe("/dashboard");
  });

  it("accepte un chemin interne avec une chaîne de requête", () => {
    expect(sanitizeInternalRedirect("/reservations?id=1")).toBe("/reservations?id=1");
  });

  it("rejette une URL absolue externe (redirection ouverte)", () => {
    expect(sanitizeInternalRedirect("https://evil.example")).toBe("/dashboard");
  });

  it("rejette une URL protocol-relative (redirection ouverte)", () => {
    expect(sanitizeInternalRedirect("//evil.example")).toBe("/dashboard");
  });

  it("rejette un schéma javascript:", () => {
    expect(sanitizeInternalRedirect("javascript:alert(document.cookie)")).toBe("/dashboard");
  });

  it("rejette un schéma data:", () => {
    expect(sanitizeInternalRedirect("data:text/html,<script>alert(1)</script>")).toBe("/dashboard");
  });

  it("rejette une valeur absente", () => {
    expect(sanitizeInternalRedirect(null)).toBe("/dashboard");
    expect(sanitizeInternalRedirect(undefined)).toBe("/dashboard");
  });

  it("rejette une valeur vide ou structurellement invalide", () => {
    expect(sanitizeInternalRedirect("")).toBe("/dashboard");
    expect(sanitizeInternalRedirect("dashboard")).toBe("/dashboard"); // sans "/" initial
  });

  it("rejette une valeur backslashée (contournement de normalisation d'URL)", () => {
    expect(sanitizeInternalRedirect("/\\evil.example")).toBe("/dashboard");
    expect(sanitizeInternalRedirect("\\\\evil.example")).toBe("/dashboard");
  });

  it("rejette une valeur avec un caractère de contrôle (contournement par suppression WHATWG)", () => {
    expect(sanitizeInternalRedirect("/\t/evil.example")).toBe("/dashboard");
    expect(sanitizeInternalRedirect("/\n/evil.example")).toBe("/dashboard");
  });

  it("rejette une valeur ambiguë contenant un schéma non initial", () => {
    expect(sanitizeInternalRedirect("/redirect?to=http://evil.example")).toBe("/dashboard");
  });

  it("utilise un repli personnalisé si fourni", () => {
    expect(sanitizeInternalRedirect("https://evil.example", "/login")).toBe("/login");
  });
});
