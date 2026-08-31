import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { apiFetch, findSetCookie } from "./helpers/http";
import { registerTenantAdmin, deleteTestTenants } from "./helpers/fixtures";

/**
 * Mode livraison efficace, phase 5 (2026-08-31) — avant cette phase, aucun en-tête de sécurité
 * HTTP n'était posé nulle part dans ce projet (vérifié par grep exhaustif : aucune occurrence
 * de Content-Security-Policy/X-Frame-Options/X-Content-Type-Options/Strict-Transport-Security/
 * Referrer-Policy/Permissions-Policy dans tout `src/`). Corrigé de façon centralisée dans
 * `next.config.ts` (`headers()`, `source: "/:path*"`) — une seule déclaration couvre pages ET
 * routes API, vérifié explicitement ci-dessous sur les deux types de route.
 *
 * Les cookies NextAuth (HttpOnly/SameSite/Secure) n'étaient eux jamais surchargés (défauts
 * `@auth/core` déjà corrects, voir node_modules/@auth/core/lib/utils/cookie.js) — vérifiés ici
 * pour ne jamais régresser silencieusement si une future modification de src/lib/auth.ts
 * ajoutait une section `cookies` mal configurée.
 */
const runId = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const tenantSlug = `security-headers-test-tenant-${runId}`;
const adminEmail = `admin-${runId}@test.local`;
const password = "Correct-Horse-Battery-Staple9!";

const createdTenantIds: string[] = [];

afterAll(async () => {
  await deleteTestTenants(createdTenantIds);
  await prisma.$disconnect();
});

describe("En-têtes de sécurité HTTP globaux (phase 5)", () => {
  it("une page publique (/login) porte l'ensemble des en-têtes de sécurité attendus", async () => {
    const response = await apiFetch("/login");

    const csp = response.headers.get("content-security-policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");

    // Particularité vérifiée empiriquement (AGENTS.md : cette version de Next.js diffère parfois
    // des connaissances par défaut) : `next dev` (node_modules/next/dist/bin/next) ne force
    // NODE_ENV="development" que si la variable n'est *pas déjà* définie
    // (`process.env.NODE_ENV || defaultEnv`) — Vitest définissant lui-même NODE_ENV="test" avant
    // de lancer ce serveur (vitest.global-setup.ts), le serveur de test tourne donc en
    // NODE_ENV="test", jamais "development", même s'il s'agit bien d'un `next dev` réel. Seul
    // `npm run dev` lancé directement (NODE_ENV non pré-défini par le shell) obtient
    // "development". `next.config.ts` n'active 'unsafe-eval' que pour NODE_ENV==="development"
    // strictement — assertion alignée sur ce comportement réel plutôt que sur une hypothèse.
    if (process.env.NODE_ENV === "development") {
      expect(csp).toContain("'unsafe-eval'");
    } else {
      expect(csp).not.toContain("unsafe-eval");
    }

    // 'unsafe-inline' (script-src et style-src) est en revanche inconditionnel : requis dans
    // TOUTE configuration CSP sans nonce, y compris en production (le HTML streamé par l'App
    // Router contient un script inline `self.__next_f.push(...)` nécessaire à l'hydratation —
    // vérifié empiriquement par un `next build && next start` réel : sans 'unsafe-inline' sur
    // script-src, /login rend une coquille vide, React error #412). Voir le commentaire dans
    // next.config.ts pour le compromis assumé (script-src reste borné à 'self', aucune origine
    // externe autorisée).
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");

    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("permissions-policy")).toContain("geolocation=()");

    // HSTS n'a de sens (et n'est respecté par le navigateur, RFC 6797 §8.1) que sous HTTPS —
    // jamais envoyé par le serveur de test/dev local, qui sert toujours du HTTP simple.
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });

  it("une route API (même non authentifiée) porte les mêmes en-têtes — couverture globale, pas seulement les pages", async () => {
    const response = await apiFetch("/api/auth/me");
    expect(response.status).toBe(401);

    expect(response.headers.get("content-security-policy")).toBeTruthy();
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });
});

describe("Attributs des cookies de session (phase 5)", () => {
  it("le cookie de session posé à la connexion est HttpOnly et SameSite=Lax", async () => {
    const bootstrapped = await registerTenantAdmin({
      tenantName: "Security Headers Test Tenant",
      tenantSlug,
      name: "Admin Test",
      email: adminEmail,
      password,
    });
    createdTenantIds.push(bootstrapped.tenantId);

    const loginResponse = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: adminEmail, password }),
    });
    expect(loginResponse.status).toBe(200);

    const cookie = findSetCookie(loginResponse, "session-token=");
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    // Le serveur de test répond en HTTP simple (jamais HTTPS) — `useSecureCookies` (@auth/core)
    // se cale sur le protocole de la requête reçue (`url.protocol === "https:"`), donc ni
    // `Secure` ni le préfixe `__Secure-` ne doivent apparaître ici. En production réelle
    // derrière HTTPS, ce même mécanisme framework les ajoute automatiquement, sans
    // configuration supplémentaire côté application (voir SECURITY.md).
    expect(cookie).not.toMatch(/;\s*Secure/i);
    expect(cookie).not.toMatch(/__Secure-/);
  });
});

describe("Absence de fuite de trace technique dans les routes API (phase 5)", () => {
  it("aucune route API ne renvoie error.stack/err.stack au client", () => {
    const apiDir = path.join(process.cwd(), "src", "app", "api");
    const offenders: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (/\.tsx?$/.test(entry.name)) {
          const content = fs.readFileSync(fullPath, "utf-8");
          if (/\berror\.stack\b|\berr\.stack\b/.test(content)) {
            offenders.push(fullPath);
          }
        }
      }
    }
    walk(apiDir);

    expect(offenders).toEqual([]);
  });
});
